/**
 * Conversational engine — routes plain text and voice messages
 * through Paperclip agent sessions for natural-language responses.
 *
 * Phase 3: Conversational AI, voice transcription, task extraction.
 */

import type {
  PluginContext,
  Agent,
  AgentSession,
  AgentSessionEvent,
} from "@paperclipai/plugin-sdk";
import type { TelegramClient, TelegramMessage } from "./telegram.js";
import { escapeHtml } from "./telegram.js";
import type { PluginConfig } from "./commands.js";
import { createVoiceClient, DEFAULT_VOICE_ID, type VoiceClient } from "./voice.js";

const SESSION_STATE_PREFIX = "chat-session-";

interface ChatSessionState {
  sessionId: string;
  agentId: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Session management — one agent session per Telegram chat
// ---------------------------------------------------------------------------

async function getOrCreateSession(
  ctx: PluginContext,
  config: PluginConfig,
  chatId: number,
): Promise<{ session: AgentSession; agentId: string }> {
  const stateKey = `${SESSION_STATE_PREFIX}${chatId}`;
  const scopeKey = { scopeKind: "instance" as const, stateKey };

  // Check for existing session
  const existing = await ctx.state.get(scopeKey);
  if (existing && typeof existing === "object" && "sessionId" in existing) {
    const state = existing as ChatSessionState;
    // Verify the session is still active
    const sessions = await ctx.agents.sessions.list(state.agentId, config.defaultCompanyId);
    const active = sessions.find((s) => s.sessionId === state.sessionId && s.status === "active");
    if (active) {
      return { session: active, agentId: state.agentId };
    }
    // Session closed, clean up
    ctx.logger.info("Previous session closed, creating new one", { chatId });
  }

  // Find the best agent to use for conversation
  const agents = await ctx.agents.list({
    companyId: config.defaultCompanyId,
    limit: 50,
    offset: 0,
  });

  if (agents.length === 0) {
    throw new Error("No agents available for conversation");
  }

  // Prefer an active/idle agent
  const agent =
    agents.find((a: Agent) => a.status === "active" || a.status === "idle") ?? agents[0]!;

  const session = await ctx.agents.sessions.create(
    agent.id,
    config.defaultCompanyId,
    {
      taskKey: `telegram-chat-${chatId}`,
      reason: "Telegram bot conversational session",
    },
  );

  // Persist session mapping
  const sessionState: ChatSessionState = {
    sessionId: session.sessionId,
    agentId: agent.id,
    createdAt: new Date().toISOString(),
  };
  await ctx.state.set(scopeKey, sessionState);

  ctx.logger.info("Created new agent session for chat", {
    chatId,
    sessionId: session.sessionId,
    agentId: agent.id,
    agentName: agent.name,
  });

  return { session, agentId: agent.id };
}

// ---------------------------------------------------------------------------
// Conversational message handler
// ---------------------------------------------------------------------------

export async function handleConversation(
  message: TelegramMessage,
  text: string,
  ctx: PluginContext,
  config: PluginConfig,
  telegram: TelegramClient,
): Promise<string> {
  const chatId = message.chat.id;
  const companyId = config.defaultCompanyId;
  if (!companyId) return "No default company configured.";

  await telegram.sendChatAction(chatId, "typing");

  let sessionInfo: { session: AgentSession; agentId: string };
  try {
    sessionInfo = await getOrCreateSession(ctx, config, chatId);
  } catch (err) {
    ctx.logger.error("Failed to create agent session", { error: String(err) });
    return "I couldn't start a conversation session. No agents are available right now.";
  }

  // Collect streaming response chunks
  const chunks: string[] = [];
  let done = false;

  try {
    await sessionInfo.session;
    const result = await ctx.agents.sessions.sendMessage(
      sessionInfo.session.sessionId,
      companyId,
      {
        prompt: text,
        reason: "Telegram conversation",
        onEvent: (event: AgentSessionEvent) => {
          if (event.eventType === "chunk" && event.message) {
            chunks.push(event.message);
          } else if (event.eventType === "done") {
            done = true;
          } else if (event.eventType === "error") {
            ctx.logger.error("Agent session error", { message: event.message });
          }
        },
      },
    );

    // Wait briefly for streaming to complete (the onEvent callback collects chunks)
    // The sendMessage call should block until the stream finishes
    const response = chunks.join("");

    if (!response.trim()) {
      return "The agent processed your message but didn't generate a response. Try rephrasing.";
    }

    // Truncate very long responses for Telegram
    if (response.length > 3800) {
      return response.slice(0, 3800) + "\n\n<i>(truncated)</i>";
    }

    return response;
  } catch (err) {
    ctx.logger.error("Agent conversation failed", {
      chatId,
      sessionId: sessionInfo.session.sessionId,
      error: String(err),
    });

    // Session may have died — clear it so next message creates a fresh one
    const stateKey = `${SESSION_STATE_PREFIX}${chatId}`;
    await ctx.state.delete({ scopeKind: "instance" as const, stateKey });

    return "Something went wrong with the conversation. I've reset the session — try again.";
  }
}

// ---------------------------------------------------------------------------
// Voice message handler — download, transcribe, then converse
// ---------------------------------------------------------------------------

export async function handleVoiceMessage(
  message: TelegramMessage,
  ctx: PluginContext,
  config: PluginConfig,
  telegram: TelegramClient,
): Promise<string> {
  const chatId = message.chat.id;
  const voice = message.voice;
  if (!voice) return "No voice message found.";

  await telegram.sendChatAction(chatId, "typing");

  // Download the voice file from Telegram
  let audioBytes: Uint8Array;
  try {
    const file = await telegram.getFile(voice.file_id);
    if (!file.file_path) {
      return "Couldn't retrieve the voice file from Telegram.";
    }
    audioBytes = await telegram.downloadFile(file.file_path);
    ctx.logger.info("Downloaded voice message", {
      chatId,
      fileSize: audioBytes.length,
      duration: voice.duration,
    });
  } catch (err) {
    ctx.logger.error("Failed to download voice file", { error: String(err) });
    return "I couldn't download your voice message. Please try again or send text instead.";
  }

  // Transcribe using ElevenLabs STT (they support speech-to-text)
  let transcript: string;
  try {
    transcript = await transcribeAudio(ctx, config, audioBytes);
    ctx.logger.info("Transcribed voice message", {
      chatId,
      transcriptLength: transcript.length,
    });
  } catch (err) {
    ctx.logger.error("Voice transcription failed", { error: String(err) });
    return "I couldn't transcribe your voice message. Please send text instead.";
  }

  if (!transcript.trim()) {
    return "I couldn't make out what you said. Could you try again?";
  }

  // Send transcription confirmation
  await telegram.sendMessage(chatId, `<i>Heard: "${escapeHtml(transcript)}"</i>`, {
    parse_mode: "HTML",
  });

  // Get the conversational response as text
  const textResponse = await handleConversation(message, transcript, ctx, config, telegram);

  if (!textResponse.trim()) return textResponse;

  // Try to respond with voice using Kenn's voice via ElevenLabs TTS
  try {
    const voice = await getVoiceClient(ctx, config);
    if (voice) {
      await telegram.sendChatAction(chatId, "upload_voice");
      const audioBytes = await voice.synthesize(textResponse);
      await telegram.sendVoice(chatId, audioBytes, {
        caption: textResponse.length > 1024 ? textResponse.slice(0, 1020) + "..." : textResponse,
      });
      // Voice sent directly — return empty so worker doesn't send text too
      return "";
    }
  } catch (err) {
    ctx.logger.warn("TTS response failed, falling back to text", { error: String(err) });
  }

  // Fallback: return text response
  return textResponse;
}

// ---------------------------------------------------------------------------
// Voice TTS client — responds with Kenn Akomea's voice
// ---------------------------------------------------------------------------

let cachedVoiceClient: VoiceClient | null = null;
let cachedVoiceKeyRef = "";

async function getVoiceClient(
  ctx: PluginContext,
  config: PluginConfig,
): Promise<VoiceClient | null> {
  if (!config.elevenLabsKeyRef) return null;

  if (cachedVoiceClient && cachedVoiceKeyRef === config.elevenLabsKeyRef) {
    return cachedVoiceClient;
  }

  const apiKey = await ctx.secrets.resolve(config.elevenLabsKeyRef);
  const voiceId = config.elevenLabsVoiceId || DEFAULT_VOICE_ID;
  cachedVoiceClient = createVoiceClient(ctx.logger, apiKey, voiceId);
  cachedVoiceKeyRef = config.elevenLabsKeyRef;
  return cachedVoiceClient;
}

// ---------------------------------------------------------------------------
// Audio transcription via ElevenLabs Speech-to-Text
// ---------------------------------------------------------------------------

const ELEVENLABS_STT_URL = "https://api.elevenlabs.io/v1/speech-to-text";

async function transcribeAudio(
  ctx: PluginContext,
  config: PluginConfig,
  audioBytes: Uint8Array,
): Promise<string> {
  if (!config.elevenLabsKeyRef) {
    throw new Error("ElevenLabs API key not configured — cannot transcribe voice messages");
  }

  const apiKey = await ctx.secrets.resolve(config.elevenLabsKeyRef);

  const formData = new FormData();
  const audioBuffer = audioBytes.buffer.slice(
    audioBytes.byteOffset,
    audioBytes.byteOffset + audioBytes.byteLength,
  ) as ArrayBuffer;
  formData.append("file", new Blob([audioBuffer], { type: "audio/ogg" }), "voice.ogg");
  formData.append("model_id", "scribe_v1");

  // Global fetch, NOT ctx.http: the host RPC bridge stringifies bodies
  // (FormData becomes "[object FormData]"), so multipart uploads must
  // bypass the bridge (FRE-1318).
  const response = await fetch(ELEVENLABS_STT_URL, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
    },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "unknown");
    throw new Error(`ElevenLabs STT failed (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as { text?: string };
  return data.text ?? "";
}
