/**
 * Voice gateway session registry (FRE-1296 Task 10).
 *
 * Implements VoiceGatewayConnector:
 *   attach(socket, { companyId, userId }) → creates a DB voice session,
 *   waits for the "start" message from the browser (which includes the agentId),
 *   then opens a Gemini Live session and runs the bidirectional protocol loop.
 *
 * One GatewaySession per WebSocket connection. Each session owns:
 *   - a Gemini Live LiveSession (PCM in / text deltas out)
 *   - a TtsPipe (text deltas → audio frames → browser)
 *   - a FlywheelLogger (JSONL per-day training data)
 *   - per-session run-outcome pollers (for dispatched Conrad runs)
 */

import { logger } from "../../middleware/logger.js";
import type { GatewaySocket, VoiceGatewayConnector } from "../../realtime/voice-live-ws.js";
import type { VoiceGatewayConfig } from "../../voice-gateway-config.js";
import { createGeminiLiveClient } from "./gemini-live.js";
import type { LiveSession } from "./gemini-live.js";
import { buildGatewaySystemPrompt } from "./prompt.js";
import { GATEWAY_TOOL_DEFS } from "./tool-defs.js";
import { routeToolCall, makeToolDeps } from "./tools.js";
import type { ToolDeps } from "./tools.js";
import { createTtsPipe } from "./tts-pipe.js";
import type { TtsPipe } from "./tts-pipe.js";
import { createFlywheelLogger } from "./flywheel.js";
import { streamTextToSpeech } from "../voice/elevenlabs-stream.js";
import { encodeAudioFrame, parseClientMessage } from "./protocol.js";
import type { ServerMessage } from "./protocol.js";
import { voiceSessionsService } from "../voice-sessions.js";
import type { Db } from "@paperclipai/db";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface HeartbeatHandle {
  wakeup(agentId: string, opts: Record<string, unknown>): Promise<{ id: string } | null>;
  getRun(runId: string): Promise<{ status: string } | null>;
}

export interface SessionRegistryDeps {
  db: Db;
  heartbeat: HeartbeatHandle;
  config: VoiceGatewayConfig;
}

// How often to poll for Conrad run completion (ms).
const RUN_POLL_INTERVAL_MS = 2_000;
// Maximum time to poll before giving up (5 min).
const RUN_POLL_TIMEOUT_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Single session
// ---------------------------------------------------------------------------

class GatewaySession {
  readonly sessionId: string;
  readonly companyId: string;
  readonly userId: string;

  private socket: GatewaySocket;
  private liveSession: LiveSession | null = null;
  private deps: SessionRegistryDeps;
  private flywheel: ReturnType<typeof createFlywheelLogger>;

  private muted = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private activePollers = new Map<string, () => void>();
  private closed = false;

  constructor(
    sessionId: string,
    companyId: string,
    userId: string,
    socket: GatewaySocket,
    deps: SessionRegistryDeps,
  ) {
    this.sessionId = sessionId;
    this.companyId = companyId;
    this.userId = userId;
    this.socket = socket;
    this.deps = deps;
    this.flywheel = createFlywheelLogger(deps.config.flywheelDir);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    const { config, db, heartbeat } = this.deps;

    // Build tool deps with the DB and heartbeat handle.
    const toolDeps: ToolDeps = makeToolDeps(db, {
      wakeup: (agentId, opts) => heartbeat.wakeup(agentId, opts),
      getRun: (runId) => heartbeat.getRun(runId),
    });

    const liveClient = createGeminiLiveClient({
      apiKey: config.geminiApiKey!,
      model: config.liveModel,
      output: "cascade", // always use ElevenLabs TTS
    });

    // Build TTS pipe that forwards MP3 frames to the browser.
    const ttsPipe: TtsPipe = createTtsPipe({
      synthesize: (sentence) => {
        if (!config.elevenlabsApiKey) {
          return new ReadableStream({ start(c) { c.close(); } });
        }
        const textSource = new ReadableStream<string>({
          start(c) { c.enqueue(sentence); c.close(); },
        });
        return streamTextToSpeech({
          voiceId: config.voiceId,
          text$: textSource,
          apiKey: config.elevenlabsApiKey,
        });
      },
      synthesizeFallback: async (_sentence) => null,
      sendAudioStart: (seq) => this.sendJson({ type: "audio-start", seq }),
      sendAudioChunk: (seq, bytes) => {
        const frame = encodeAudioFrame(seq, bytes);
        if (this.socket.readyState === 1 /* OPEN */) {
          this.socket.send(frame);
        }
      },
      sendAudioEnd: (seq) => this.sendJson({ type: "audio-end", seq }),
    });

    // agentId resolved from the browser "start" message (set in the message handler).
    let agentId: string | null = null;

    // Connect to Gemini Live.
    try {
      this.liveSession = await liveClient.connect({
        systemInstruction: buildGatewaySystemPrompt(),
        tools: GATEWAY_TOOL_DEFS,
        onEvent: (event) => {
          if (event.textDelta) {
            ttsPipe.pushTextDelta(event.textDelta);
            this.sendJson({
              type: "transcript",
              role: "assistant",
              text: event.textDelta,
              final: false,
            });
          }

          if (event.userTranscript) {
            const { text, final } = event.userTranscript;
            this.sendJson({ type: "transcript", role: "user", text, final });
            if (final) {
              this.flywheel.log({
                ts: new Date().toISOString(),
                sessionId: this.sessionId,
                userId: this.userId,
                kind: "user_turn",
                text,
              });
              this.sendJson({ type: "status", state: "thinking" });
            }
          }

          if (event.interrupted) {
            ttsPipe.cancel();
            this.sendJson({ type: "interrupt" });
            this.flywheel.log({
              ts: new Date().toISOString(),
              sessionId: this.sessionId,
              userId: this.userId,
              kind: "interrupt",
            });
          }

          if (event.turnComplete) {
            ttsPipe.endTurn();
            this.sendJson({ type: "status", state: "listening" });
            this.resetIdleTimeout();
          }

          if (event.toolCalls && event.toolCalls.length > 0) {
            this.sendJson({ type: "status", state: "thinking" });
            for (const call of event.toolCalls) {
              this.dispatchToolCall(call, agentId ?? "", toolDeps, ttsPipe);
            }
          }
        },
        onError: (err) => {
          logger.error({ err, sessionId: this.sessionId }, "gemini live session error");
          this.sendJson({ type: "error", message: "voice session error" });
          this.close();
        },
        onClose: () => {
          this.close();
        },
      });
    } catch (err) {
      logger.error({ err, sessionId: this.sessionId }, "failed to connect gemini live session");
      this.sendJson({ type: "error", message: "failed to connect voice session" });
      this.socket.close(1011, "gateway connect failed");
      return;
    }

    // Wire up browser socket messages.
    this.socket.on("message", (data, isBinary) => {
      if (this.closed) return;

      if (isBinary) {
        // PCM16 audio from browser → forward to Gemini.
        if (!this.muted && this.liveSession) {
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as unknown as ArrayBuffer);
          this.liveSession.sendAudioChunk(buf);
        }
        return;
      }

      // JSON text message.
      const raw = typeof data === "string" ? data : (data as Buffer).toString("utf8");
      const msg = parseClientMessage(raw);
      if (!msg) return;

      switch (msg.type) {
        case "start":
          // Capture agentId from the first start message.
          if (!agentId && msg.agentId) {
            agentId = msg.agentId;
          }
          // Send ready (idempotent on reconnect).
          this.sendJson({ type: "ready", sessionId: this.sessionId });
          this.sendJson({ type: "status", state: "listening" });
          break;
        case "mute":
          this.muted = true;
          break;
        case "unmute":
          this.muted = false;
          break;
        case "camera":
          this.liveSession?.sendVideoFrame(msg.jpegBase64);
          break;
        case "end":
          ttsPipe.cancel();
          this.close();
          break;
      }
    });

    this.socket.on("close", () => this.close());
    this.socket.on("error", (err) => {
      logger.warn({ err, sessionId: this.sessionId }, "gateway socket error");
    });

    // Initial ready + idle timeout start.
    // Note: we send "ready" again when "start" message arrives (idempotent).
    this.sendJson({ type: "ready", sessionId: this.sessionId });
    this.sendJson({ type: "status", state: "listening" });
    this.resetIdleTimeout();
  }

  // ---------------------------------------------------------------------------
  // Tool call dispatch
  // ---------------------------------------------------------------------------

  private dispatchToolCall(
    call: { id: string; name: string; args: Record<string, unknown> },
    agentId: string,
    toolDeps: ToolDeps,
    ttsPipe: TtsPipe,
  ): void {
    const ts = new Date().toISOString();

    this.flywheel.log({
      ts,
      sessionId: this.sessionId,
      userId: this.userId,
      kind: "tool_call",
      tool: call.name,
      data: { args: call.args },
    });

    routeToolCall(
      toolDeps,
      {
        companyId: this.companyId,
        agentId,
        sessionId: this.sessionId,
        userId: this.userId,
      },
      call,
    )
      .then((result) => {
        this.liveSession?.sendToolResponse(call.id, call.name, result.response);

        this.flywheel.log({
          ts: new Date().toISOString(),
          sessionId: this.sessionId,
          userId: this.userId,
          kind: "tool_result",
          tool: call.name,
          data: result.response,
        });

        if (result.dispatchedRunId) {
          const runId = result.dispatchedRunId;
          this.sendJson({ type: "run-dispatched", runId });
          this.pollRunCompletion(runId, ttsPipe);
        }
      })
      .catch((err) => {
        logger.error({ err, call, sessionId: this.sessionId }, "tool call failed");
        this.liveSession?.sendToolResponse(call.id, call.name, { error: "tool call failed" });
      });
  }

  // ---------------------------------------------------------------------------
  // Run completion polling (Task 11)
  // ---------------------------------------------------------------------------

  private pollRunCompletion(runId: string, _ttsPipe: TtsPipe): void {
    if (this.activePollers.has(runId)) return;

    const startTime = Date.now();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      this.activePollers.delete(runId);
    };
    this.activePollers.set(runId, cleanup);

    const poll = async () => {
      if (cancelled || this.closed) return;

      if (Date.now() - startTime > RUN_POLL_TIMEOUT_MS) {
        cleanup();
        this.sendJson({ type: "run-complete", runId, ok: false });
        this.liveSession?.sendSystemText(
          `Conrad's run (${runId}) did not complete within 5 minutes. Please inform the user.`,
        );
        return;
      }

      try {
        const run = await this.deps.heartbeat.getRun(runId);
        const status = run?.status ?? "unknown";
        const isTerminal = ["done", "succeeded", "failed", "errored", "cancelled"].includes(status);

        if (isTerminal) {
          cleanup();
          const ok = ["done", "succeeded"].includes(status);
          this.sendJson({ type: "run-complete", runId, ok });
          this.flywheel.log({
            ts: new Date().toISOString(),
            sessionId: this.sessionId,
            userId: this.userId,
            kind: "run_complete",
            data: { runId, ok, status },
          });
          const outcome = ok ? "completed successfully" : `ended with status: ${status}`;
          this.liveSession?.sendSystemText(
            `Conrad's run (${runId}) has ${outcome}. Please relay this to the user conversationally now.`,
          );
          return;
        }
      } catch (err) {
        logger.warn({ err, runId, sessionId: this.sessionId }, "run poll error");
      }

      timer = setTimeout(() => { void poll(); }, RUN_POLL_INTERVAL_MS);
    };

    timer = setTimeout(() => { void poll(); }, RUN_POLL_INTERVAL_MS);
  }

  // ---------------------------------------------------------------------------
  // Idle timeout
  // ---------------------------------------------------------------------------

  private resetIdleTimeout(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      logger.info({ sessionId: this.sessionId }, "voice gateway session idle timeout");
      this.close();
    }, this.deps.config.idleTimeoutMs);
  }

  // ---------------------------------------------------------------------------
  // Close
  // ---------------------------------------------------------------------------

  close(): void {
    if (this.closed) return;
    this.closed = true;

    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    for (const cleanup of this.activePollers.values()) cleanup();
    this.activePollers.clear();

    if (this.liveSession) {
      try { this.liveSession.close(); } catch { /* ignore */ }
      this.liveSession = null;
    }

    if (this.socket.readyState < 2 /* < CLOSING */) {
      try { this.socket.close(1000, "session ended"); } catch { /* ignore */ }
    }

    voiceSessionsService(this.deps.db)
      .endSession(this.sessionId)
      .catch((err) => {
        logger.warn({ err, sessionId: this.sessionId }, "failed to end voice session in DB");
      });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private sendJson(msg: ServerMessage): void {
    if (this.socket.readyState === 1 /* OPEN */) {
      try { this.socket.send(JSON.stringify(msg)); } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Registry factory
// ---------------------------------------------------------------------------

export function createVoiceGatewayRegistry(deps: SessionRegistryDeps): VoiceGatewayConnector {
  return {
    attach(socket: GatewaySocket, ctx: { companyId: string; userId: string }) {
      void (async () => {
        let sessionId: string;
        try {
          const sess = await voiceSessionsService(deps.db).createSession({
            companyId: ctx.companyId,
            userId: ctx.userId,
          });
          sessionId = sess.id;
        } catch (err) {
          logger.error({ err }, "failed to create voice session in DB");
          socket.close(1011, "failed to create session");
          return;
        }

        const session = new GatewaySession(sessionId, ctx.companyId, ctx.userId, socket, deps);

        socket.on("close", () => session.close());

        await session.start();
      })();
    },
  };
}
