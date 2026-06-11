/**
 * Thin wrapper over the @google/genai Live API (FRE-1296).
 *
 * ALL other gateway modules depend on the interfaces defined here, never on
 * the SDK directly. Only this file imports from @google/genai.
 */

import { GoogleGenAI, Modality } from "@google/genai";
import type { LiveServerMessage } from "@google/genai";

// ---------------------------------------------------------------------------
// Public interfaces (the contract the rest of the gateway builds against)
// ---------------------------------------------------------------------------

export interface LiveServerEvent {
  textDelta?: string;
  audioDelta?: Uint8Array;
  userTranscript?: { text: string; final: boolean };
  /** User barging in caused Gemini to drop its current turn. */
  interrupted?: boolean;
  turnComplete?: boolean;
  toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
}

export interface LiveSession {
  /** Base64-encodes the PCM16 buffer and sends it as audio/pcm;rate=16000. */
  sendAudioChunk(pcm16: Buffer): void;
  /** Sends a JPEG frame as image/jpeg. */
  sendVideoFrame(jpegBase64: string): void;
  /** Sends a user-role text turn with turnComplete=true. */
  sendSystemText(text: string): void;
  sendToolResponse(id: string, name: string, response: Record<string, unknown>): void;
  close(): void;
}

export interface LiveClient {
  connect(opts: {
    systemInstruction: string;
    tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
    onEvent: (event: LiveServerEvent) => void;
    onError: (err: Error) => void;
    onClose: () => void;
  }): Promise<LiveSession>;
}

// ---------------------------------------------------------------------------
// Pure mapping function (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Maps a raw @google/genai LiveServerMessage to our LiveServerEvent shape.
 * Pure function - no side effects, no network.
 */
export function mapServerMessage(raw: LiveServerMessage): LiveServerEvent {
  const evt: LiveServerEvent = {};

  const sc = raw.serverContent;
  if (sc) {
    // textDelta: concatenate all text parts from modelTurn
    if (sc.modelTurn?.parts) {
      const textParts = sc.modelTurn.parts
        .map((p) => (typeof (p as { text?: string }).text === "string" ? (p as { text: string }).text : ""))
        .filter((t) => t.length > 0);
      if (textParts.length > 0) {
        evt.textDelta = textParts.join("");
      }
    }

    // audioDelta: first inlineData part (base64 -> Uint8Array)
    if (sc.modelTurn?.parts) {
      for (const part of sc.modelTurn.parts) {
        const p = part as { inlineData?: { data?: string; mimeType?: string } };
        if (p.inlineData?.data) {
          evt.audioDelta = new Uint8Array(Buffer.from(p.inlineData.data, "base64"));
          break;
        }
      }
    }

    // userTranscript: from inputTranscription
    if (sc.inputTranscription) {
      evt.userTranscript = {
        text: sc.inputTranscription.text ?? "",
        final: sc.inputTranscription.finished === true,
      };
    }

    // interrupted
    if (sc.interrupted === true) {
      evt.interrupted = true;
    }

    // turnComplete
    if (sc.turnComplete === true) {
      evt.turnComplete = true;
    }
  }

  // toolCalls
  if (raw.toolCall?.functionCalls && raw.toolCall.functionCalls.length > 0) {
    evt.toolCalls = raw.toolCall.functionCalls.map((fc) => ({
      id: fc.id ?? "",
      name: fc.name ?? "",
      args: fc.args ?? {},
    }));
  }

  return evt;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a LiveClient backed by the @google/genai SDK.
 *
 * @param cfg.apiKey   - Gemini API key.
 * @param cfg.model    - Live model ID (e.g. "gemini-live-2.5-flash-preview").
 * @param cfg.output   - "cascade" uses TEXT modality (audio produced downstream by
 *                       ElevenLabs); "native" uses AUDIO modality directly.
 */
export function createGeminiLiveClient(cfg: {
  apiKey: string;
  model: string;
  output: "cascade" | "native";
}): LiveClient {
  const ai = new GoogleGenAI({ apiKey: cfg.apiKey });

  return {
    async connect(opts) {
      const responseModalities: Modality[] =
        cfg.output === "native" ? [Modality.AUDIO] : [Modality.TEXT];

      // Build the tools array in the shape the SDK expects: { functionDeclarations }
      const sdkTools =
        opts.tools.length > 0
          ? [
              {
                functionDeclarations: opts.tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  parameters: t.parameters,
                })),
              },
            ]
          : undefined;

      const session = await ai.live.connect({
        model: cfg.model,
        config: {
          responseModalities,
          systemInstruction: opts.systemInstruction,
          inputAudioTranscription: {},
          ...(sdkTools ? { tools: sdkTools as Parameters<typeof ai.live.connect>[0]["config"] extends { tools?: infer T } ? T : never } : {}),
        },
        callbacks: {
          onopen: () => {
            // connection established - nothing to do here
          },
          onmessage: (msg: LiveServerMessage) => {
            opts.onEvent(mapServerMessage(msg));
          },
          onerror: (e: ErrorEvent) => {
            opts.onError(new Error(e.message ?? String(e)));
          },
          onclose: () => {
            opts.onClose();
          },
        },
      });

      // Return the LiveSession wrapper
      const liveSession: LiveSession = {
        sendAudioChunk(pcm16: Buffer): void {
          session.sendRealtimeInput({
            audio: {
              data: pcm16.toString("base64"),
              mimeType: "audio/pcm;rate=16000",
            },
          });
        },

        sendVideoFrame(jpegBase64: string): void {
          session.sendRealtimeInput({
            video: {
              data: jpegBase64,
              mimeType: "image/jpeg",
            },
          });
        },

        sendSystemText(text: string): void {
          session.sendClientContent({
            turns: [{ role: "user", parts: [{ text }] }],
            turnComplete: true,
          });
        },

        sendToolResponse(id: string, name: string, response: Record<string, unknown>): void {
          session.sendToolResponse({
            functionResponses: [{ id, name, response }],
          });
        },

        close(): void {
          session.close();
        },
      };

      return liveSession;
    },
  };
}
