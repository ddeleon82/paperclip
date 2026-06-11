/**
 * GatewaySession — conductor for one user's live conversation (FRE-1296).
 *
 * All I/O is injected; no imports from @google/genai, ElevenLabs, or the DB
 * directly. This makes the module fully unit-testable with vi.fn() fakes.
 */

import type { LiveClient, LiveSession } from "./gemini-live.js";
import type { TtsPipe, TtsPipeDeps } from "./tts-pipe.js";
import type { ToolDeps, ToolCallResult } from "./tools.js";
import { routeToolCall } from "./tools.js";
import type { FlywheelEntry } from "./flywheel.js";
import type { ClientMessage, ServerMessage } from "./protocol.js";
import { encodeAudioFrame } from "./protocol.js";
import type { GatewaySocket } from "../../realtime/voice-live-ws.js";
import type { VoiceSessionsService } from "../voice-sessions.js";
import { buildGatewaySystemPrompt } from "./prompt.js";
import { GATEWAY_TOOL_DEFS } from "./tool-defs.js";
import {
  HEARTBEAT_RUN_STATUSES,
} from "@paperclipai/shared";
import type { LiveEvent } from "@paperclipai/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GatewaySessionHandle {
  readonly userId: string;
  /** Takeover: closes previous socket with "superseded" + code 4001. */
  attachSocket(socket: GatewaySocket): void;
  /** Mic PCM → liveSession.sendAudioChunk (dropped while muted). */
  handleBinary(buf: Buffer): void;
  handleMessage(msg: ClientMessage): void;
  /** Starts warm-hold timer. */
  clientDisconnected(): void;
  /** Closes Gemini session, ends DB session, clears timers. */
  destroy(reason: string): void;
}

export interface GatewaySessionDeps {
  ctx: {
    companyId: string;
    userId: string;
    agentId: string;
  };
  liveClient: LiveClient;
  createTtsPipe(deps: TtsPipeDeps): TtsPipe;
  /**
   * Optional real TTS synthesizer (ElevenLabs streaming).
   * When omitted, falls back to an empty stream (safe for tests).
   */
  synthesize?: (sentence: string) => ReadableStream<Uint8Array>;
  /**
   * Optional non-streaming TTS fallback (POST /v1/text-to-speech).
   * When omitted, returns null (no fallback bytes).
   */
  synthesizeFallback?: (sentence: string) => Promise<Uint8Array | null>;
  toolDeps: ToolDeps;
  voiceSessions: VoiceSessionsService;
  flywheel: { log(entry: FlywheelEntry): void };
  subscribeCompanyLiveEvents(
    companyId: string,
    handler: (event: LiveEvent) => void,
  ): () => void;
  extractRunOutcome(runId: string): Promise<string>;
  config: {
    warmHoldMs: number;
    idleTimeoutMs: number;
    output: "cascade" | "native";
  };
}

// Terminal heartbeat run statuses (use constants, never hardcode)
const TERMINAL_STATUSES = new Set<string>(
  HEARTBEAT_RUN_STATUSES.filter(
    (s) => s === "succeeded" || s === "failed" || s === "cancelled" || s === "timed_out",
  ),
);

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createGatewaySession(deps: GatewaySessionDeps): GatewaySessionHandle {
  const { ctx, liveClient, createTtsPipe, toolDeps, voiceSessions, flywheel, config } = deps;

  // ---- State ----
  let socket: GatewaySocket | null = null;
  let liveSession: LiveSession | null = null;
  let ttsPipe: TtsPipe | null = null;

  let dbSessionId: string | null = null;
  let muted = false;
  let destroyed = false;
  let reconnectAttempt = 0; // tracks how many reconnect attempts made

  // Text accumulator for the current assistant turn
  let currentTurnText = "";
  let turnHasDelta = false; // whether we've emitted speaking status for this turn

  // Audio sequence counter for native output
  let nativeAudioSeq = 0;
  let nativeAudioTurnStarted = false;

  // Timers
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let warmHoldTimer: ReturnType<typeof setTimeout> | null = null;

  // ---- Helpers ----

  function send(msg: ServerMessage): void {
    if (!socket || socket.readyState !== 1) return;
    socket.send(JSON.stringify(msg));
  }

  function sendBinary(buf: Buffer): void {
    if (!socket || socket.readyState !== 1) return;
    socket.send(buf);
  }

  function resetIdleTimer(): void {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(() => {
      handle.destroy("idle timeout");
    }, config.idleTimeoutMs);
  }

  function clearIdleTimer(): void {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function clearWarmHoldTimer(): void {
    if (warmHoldTimer !== null) {
      clearTimeout(warmHoldTimer);
      warmHoldTimer = null;
    }
  }

  // ---- Live event handler ----

  function onLiveEvent(event: import("./gemini-live.js").LiveServerEvent): void {
    if (destroyed) return;

    // userTranscript
    if (event.userTranscript) {
      const { text, final } = event.userTranscript;
      if (final && dbSessionId) {
        const ts = new Date().toISOString();
        // appendTurn is fire-and-forget — errors are logged but don't crash the session
        void voiceSessions.appendTurn(dbSessionId, { role: "user", text, ts }).catch((err) => {
          console.warn("[voice-gateway] appendTurn user failed", err);
        });
        flywheel.log({ ts, sessionId: dbSessionId, userId: ctx.userId, kind: "user_turn", text });
        send({ type: "transcript", role: "user", text, final: true });
        send({ type: "status", state: "thinking" });
      }
    }

    // textDelta
    if (event.textDelta !== undefined) {
      const delta = event.textDelta;
      currentTurnText += delta;

      if (!turnHasDelta) {
        turnHasDelta = true;
        send({ type: "status", state: "speaking" });
      }

      // Cascade mode: push to TtsPipe
      if (config.output === "cascade" && ttsPipe) {
        ttsPipe.pushTextDelta(delta);
      }

      send({ type: "transcript", role: "assistant", text: delta, final: false });
    }

    // audioDelta (native mode only)
    if (event.audioDelta !== undefined && config.output === "native") {
      if (!nativeAudioTurnStarted) {
        nativeAudioTurnStarted = true;
        send({ type: "audio-start", seq: nativeAudioSeq });
      }
      const frame = encodeAudioFrame(nativeAudioSeq, event.audioDelta);
      sendBinary(frame);
    }

    // turnComplete
    if (event.turnComplete) {
      const accumulated = currentTurnText;
      const ts = new Date().toISOString();

      // Cascade: flush the TtsPipe
      if (config.output === "cascade" && ttsPipe) {
        ttsPipe.endTurn();
      }

      // Native: close the audio turn
      if (config.output === "native" && nativeAudioTurnStarted) {
        send({ type: "audio-end", seq: nativeAudioSeq });
        nativeAudioSeq++;
        nativeAudioTurnStarted = false;
      }

      // Send final transcript
      send({ type: "transcript", role: "assistant", text: accumulated, final: true });

      // Persist and log
      if (dbSessionId && accumulated.length > 0) {
        void voiceSessions.appendTurn(dbSessionId, { role: "assistant", text: accumulated, ts }).catch((err) => {
          console.warn("[voice-gateway] appendTurn assistant failed", err);
        });
        flywheel.log({
          ts,
          sessionId: dbSessionId,
          userId: ctx.userId,
          kind: "assistant_turn",
          text: accumulated,
        });
      }

      // Reset turn state
      currentTurnText = "";
      turnHasDelta = false;

      send({ type: "status", state: "listening" });
    }

    // interrupted
    if (event.interrupted) {
      if (config.output === "cascade" && ttsPipe) {
        ttsPipe.cancel();
      }
      if (config.output === "native" && nativeAudioTurnStarted) {
        // Drop the in-flight audio turn
        nativeAudioSeq++;
        nativeAudioTurnStarted = false;
      }
      send({ type: "interrupt" });
      const ts = new Date().toISOString();
      if (dbSessionId) {
        flywheel.log({ ts, sessionId: dbSessionId, userId: ctx.userId, kind: "interrupt" });
      }
      send({ type: "status", state: "listening" });
      // Reset turn state
      currentTurnText = "";
      turnHasDelta = false;
    }

    // toolCalls
    if (event.toolCalls && event.toolCalls.length > 0) {
      for (const call of event.toolCalls) {
        void handleToolCall(call);
      }
    }
  }

  async function handleToolCall(call: { id: string; name: string; args: Record<string, unknown> }): Promise<void> {
    if (destroyed || !liveSession || !dbSessionId) return;

    let result: ToolCallResult;
    try {
      result = await routeToolCall(toolDeps, {
        companyId: ctx.companyId,
        agentId: ctx.agentId,
        sessionId: dbSessionId,
        userId: ctx.userId,
      }, call);
    } catch (err) {
      console.warn("[voice-gateway] routeToolCall threw", { call, err });
      result = { response: { error: String(err) } };
    }

    if (destroyed) return;

    // Send the tool response back to Gemini
    liveSession.sendToolResponse(call.id, call.name, result.response);

    // If this was a dispatch, watch for the run to complete
    if (result.dispatchedRunId) {
      const runId = result.dispatchedRunId;
      send({ type: "run-dispatched", runId });

      const unsubscribe = deps.subscribeCompanyLiveEvents(ctx.companyId, (event: LiveEvent) => {
        if (event.type !== "heartbeat.run.status") return;

        const payload = event.payload as Record<string, unknown>;
        if (payload.runId !== runId) return;

        const status = payload.status as string;
        if (!TERMINAL_STATUSES.has(status)) return;

        // Unsubscribe immediately
        unsubscribe();

        const ok = status === "succeeded";

        void deps.extractRunOutcome(runId).then((outcome) => {
          if (destroyed) return;

          if (liveSession) {
            liveSession.sendSystemText(
              `[system] Conrad finished: ${outcome}. Tell the user now.`,
            );
          }

          send({ type: "run-complete", runId, ok });

          const ts = new Date().toISOString();
          if (dbSessionId) {
            flywheel.log({
              ts,
              sessionId: dbSessionId,
              userId: ctx.userId,
              kind: "run_complete",
              data: { runId, ok },
            });
          }
        }).catch((err) => {
          console.warn("[voice-gateway] extractRunOutcome failed", { runId, err });
          send({ type: "run-complete", runId, ok: false });
        });
      });
    }
  }

  // ---- Gemini error/close handlers ----

  function onGeminiError(err: Error): void {
    if (destroyed) return;
    console.warn("[voice-gateway] Gemini session error", { err: err.message, reconnectAttempt });

    send({ type: "error", message: `Connection error: ${err.message}` });

    if (reconnectAttempt >= 1) {
      // Second failure: destroy
      handle.destroy("Gemini reconnect failed twice");
      return;
    }

    reconnectAttempt++;
    liveSession = null;
    void reconnect();
  }

  function onGeminiClose(): void {
    if (destroyed) return;
    console.warn("[voice-gateway] Gemini session closed", { reconnectAttempt });

    if (reconnectAttempt >= 1) {
      handle.destroy("Gemini closed after reconnect attempt");
      return;
    }

    reconnectAttempt++;
    liveSession = null;
    void reconnect();
  }

  async function reconnect(): Promise<void> {
    if (destroyed) return;
    try {
      const session = await liveClient.connect({
        systemInstruction: buildGatewaySystemPrompt(),
        tools: GATEWAY_TOOL_DEFS,
        onEvent: onLiveEvent,
        onError: onGeminiError,
        onClose: onGeminiClose,
      });
      if (destroyed) {
        session.close();
        return;
      }
      liveSession = session;
      session.sendSystemText(
        "session restored after a connection drop; the last user message may need repeating",
      );
    } catch (err) {
      if (destroyed) return;
      console.warn("[voice-gateway] reconnect failed", err);
      handle.destroy("Gemini reconnect threw");
    }
  }

  // ---- TtsPipe deps (cascade mode) ----

  function makeTtsPipeDeps(): TtsPipeDeps {
    return {
      synthesize(sentence: string): ReadableStream<Uint8Array> {
        if (deps.synthesize) {
          return deps.synthesize(sentence);
        }
        // Fallback: empty stream (tests override createTtsPipe, so this is unreachable in tests)
        return new ReadableStream({ start(controller) { controller.close(); } });
      },
      async synthesizeFallback(sentence: string): Promise<Uint8Array | null> {
        if (deps.synthesizeFallback) {
          return deps.synthesizeFallback(sentence);
        }
        return null;
      },
      sendAudioStart(seq: number): void {
        send({ type: "audio-start", seq });
      },
      sendAudioChunk(seq: number, bytes: Uint8Array): void {
        sendBinary(encodeAudioFrame(seq, bytes));
      },
      sendAudioEnd(seq: number): void {
        send({ type: "audio-end", seq });
      },
    };
  }

  // ---- Start (connect to Gemini and create DB session) ----

  async function doStart(agentId: string): Promise<void> {
    if (destroyed) return;

    // Create DB session
    const { id: sessionId } = await voiceSessions.createSession({
      companyId: ctx.companyId,
      userId: ctx.userId,
    });
    if (destroyed) return;

    dbSessionId = sessionId;

    // Create TtsPipe (only needed in cascade mode, but always create for simplicity)
    if (config.output === "cascade") {
      ttsPipe = createTtsPipe(makeTtsPipeDeps());
    }

    // Connect to Gemini
    const session = await liveClient.connect({
      systemInstruction: buildGatewaySystemPrompt(),
      tools: GATEWAY_TOOL_DEFS,
      onEvent: onLiveEvent,
      onError: onGeminiError,
      onClose: onGeminiClose,
    });

    if (destroyed) {
      session.close();
      return;
    }

    liveSession = session;

    // Start idle timer
    resetIdleTimer();

    send({ type: "ready", sessionId });
    send({ type: "status", state: "listening" });
  }

  // ---- Public handle ----

  const handle: GatewaySessionHandle = {
    get userId() {
      return ctx.userId;
    },

    attachSocket(newSocket: GatewaySocket): void {
      if (destroyed) return;

      // Supersede old socket
      if (socket && socket !== newSocket && socket.readyState === 1) {
        socket.send(JSON.stringify({ type: "superseded" } satisfies ServerMessage));
        socket.close(4001, "superseded");
      }

      socket = newSocket;

      // Cancel warm-hold timer (client reconnected)
      clearWarmHoldTimer();
    },

    handleBinary(buf: Buffer): void {
      if (destroyed || muted || !liveSession) return;

      // Forward audio to Gemini
      liveSession.sendAudioChunk(buf);

      // Reset idle timer on audio
      resetIdleTimer();
    },

    handleMessage(msg: ClientMessage): void {
      if (destroyed) return;

      switch (msg.type) {
        case "start": {
          if (liveSession !== null) {
            // Already connected — idempotent: reply resumed
            send({ type: "resumed", sessionId: dbSessionId! });
            return;
          }
          void doStart(msg.agentId);
          break;
        }

        case "camera": {
          if (liveSession) {
            liveSession.sendVideoFrame(msg.jpegBase64);
          }
          break;
        }

        case "mute": {
          muted = true;
          break;
        }

        case "unmute": {
          muted = false;
          break;
        }

        case "end": {
          handle.destroy("client sent end");
          break;
        }
      }
    },

    clientDisconnected(): void {
      if (destroyed) return;

      // Detach socket reference but keep session alive
      socket = null;

      clearWarmHoldTimer();
      warmHoldTimer = setTimeout(() => {
        handle.destroy("warm-hold expired");
      }, config.warmHoldMs);
    },

    destroy(reason: string): void {
      if (destroyed) return;
      destroyed = true;

      console.info(`[voice-gateway] session destroyed: ${reason}`, { userId: ctx.userId });

      clearIdleTimer();
      clearWarmHoldTimer();

      // Close Gemini session
      if (liveSession) {
        try { liveSession.close(); } catch { /* ignore */ }
        liveSession = null;
      }

      // End DB session
      if (dbSessionId) {
        void voiceSessions.endSession(dbSessionId).catch((err) => {
          console.warn("[voice-gateway] endSession failed", err);
        });
      }

      // Close socket if still open
      if (socket && socket.readyState === 1) {
        try { socket.close(1000, reason); } catch { /* ignore */ }
        socket = null;
      }
    },
  };

  return handle;
}
