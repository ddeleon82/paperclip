/**
 * useVoiceGatewaySocket.ts
 *
 * React hook that owns the WebSocket connection to the voice gateway.
 * URL mirrors the existing live-events client in LiveUpdatesProvider /
 * useLiveRunTranscripts (see context/LiveUpdatesProvider.tsx:805):
 *   ${protocol}://${window.location.host}/api/companies/${companyId}/events/ws
 * The voice endpoint follows the same derivation at a different path:
 *   ${protocol}://${window.location.host}/api/voice/live?companyId=...
 *
 * Protocol types duplicated client-side from:
 *   server/src/services/voice-gateway/protocol.ts
 */

import { useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Protocol types (keep in sync with server/src/services/voice-gateway/protocol.ts)
// ---------------------------------------------------------------------------

export type ClientMessage =
  | { type: "start"; agentId: string }
  | { type: "camera"; jpegBase64: string }
  | { type: "mute" }
  | { type: "unmute" }
  | { type: "end" };

export type ServerMessage =
  | { type: "ready"; sessionId: string }
  | { type: "resumed"; sessionId: string }
  | { type: "transcript"; role: "user" | "assistant"; text: string; final: boolean }
  | { type: "audio-start"; seq: number }
  | { type: "audio-end"; seq: number }
  | { type: "interrupt" }
  | { type: "run-dispatched"; runId: string }
  | { type: "run-complete"; runId: string; ok: boolean }
  | { type: "status"; state: "listening" | "thinking" | "speaking" }
  | { type: "superseded" }
  | { type: "error"; message: string };

// ---------------------------------------------------------------------------
// Framing helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/** Decode a binary server frame: [seq u32 BE][bytes...] */
export function decodeServerBinary(buf: ArrayBuffer): {
  seq: number;
  bytes: Uint8Array;
} {
  const view = new DataView(buf);
  const seq = view.getUint32(0, false); // big-endian
  const bytes = new Uint8Array(buf, 4);
  return { seq, bytes };
}

/** Encode client audio: [seq u32 BE = 0][PCM16 bytes] */
export function encodeAudioFrame(pcm: Int16Array): ArrayBuffer {
  const buf = new ArrayBuffer(4 + pcm.byteLength);
  const view = new DataView(buf);
  view.setUint32(0, 0, false);
  new Uint8Array(buf, 4).set(
    new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength),
  );
  return buf;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GatewaySocketCallbacks {
  onServerMessage(msg: ServerMessage): void;
  onAudioFrame(seq: number, bytes: Uint8Array): void;
  onOpen(): void;
  onClose(reason: "superseded" | "error" | "normal"): void;
  onStateChange?(state: GatewaySocketState): void;
}

export type GatewaySocketState =
  | "idle"
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed";

export interface GatewaySocketHandle {
  send(msg: ClientMessage): void;
  sendAudio(pcm: Int16Array): void;
  destroy(): void;
  readonly state: GatewaySocketState;
}

const BACKOFF_MS = [1000, 2000, 4000] as const;
// ~5 seconds of 16 kHz PCM16 mono audio in 250 ms chunks = 20 chunks
const MAX_BUFFERED_AUDIO_FRAMES = 20;

// ---------------------------------------------------------------------------
// Core factory (framework-free, fully unit-testable)
// ---------------------------------------------------------------------------

export function createGatewaySocket(opts: {
  url: string;
  agentId: string;
  callbacks: GatewaySocketCallbacks;
  wsFactory?: (url: string) => WebSocket;
}): GatewaySocketHandle {
  const { url, agentId, callbacks, wsFactory } = opts;

  let ws: WebSocket | null = null;
  let retryCount = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;
  let currentState: GatewaySocketState = "idle";
  const audioBuffer: ArrayBuffer[] = [];

  const setState = (s: GatewaySocketState) => {
    currentState = s;
    callbacks.onStateChange?.(s);
  };

  const clearTimer = () => {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  const flushAudioBuffer = (socket: WebSocket) => {
    const frames = audioBuffer.splice(0);
    for (const frame of frames) {
      socket.send(frame);
    }
  };

  const connect = () => {
    if (destroyed) return;
    setState("connecting");
    const factory = wsFactory ?? ((u: string) => new WebSocket(u));
    ws = factory(url);
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      if (destroyed) { ws?.close(); return; }
      // Reset retry budget on successful open — a stable connection resets the
      // counter so a temporary drop doesn't permanently exhaust retries.
      // NOTE: the test for "max retries exceeded" drives the socket to open
      // and immediately close; in that case the reset is harmless because the
      // onclose handler checks the NEW retryCount = 0 and starts counting again.
      // The spec "max 3" means 3 consecutive failures; opening and failing again
      // from 0 is the intended behavior.
      retryCount = 0;
      setState("open");
      callbacks.onOpen();
      // Send start FIRST (server's idempotent start is safe on warm resumes)
      ws!.send(JSON.stringify({ type: "start", agentId }));
      // Then flush any buffered audio from the reconnect window
      flushAudioBuffer(ws!);
    };

    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data === "string") {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(ev.data) as ServerMessage;
        } catch {
          return;
        }
        callbacks.onServerMessage(msg);
      } else if (ev.data instanceof ArrayBuffer) {
        const { seq, bytes } = decodeServerBinary(ev.data);
        callbacks.onAudioFrame(seq, bytes);
      }
    };

    ws.onclose = (ev: CloseEvent) => {
      ws = null;
      if (destroyed) return;

      if (!ev.wasClean) {
        const attempt = retryCount;
        if (attempt < BACKOFF_MS.length) {
          setState("reconnecting");
          retryCount += 1;
          retryTimer = setTimeout(connect, BACKOFF_MS[attempt]);
        } else {
          setState("closed");
          callbacks.onClose("error");
        }
      } else {
        setState("idle");
        callbacks.onClose("normal");
      }
    };

    ws.onerror = () => {
      // onclose fires right after onerror; let onclose handle retry
    };
  };

  connect();

  return {
    send(msg: ClientMessage) {
      if (ws && ws.readyState === 1 /* OPEN */) {
        ws.send(JSON.stringify(msg));
      }
    },

    sendAudio(pcm: Int16Array) {
      const frame = encodeAudioFrame(pcm);
      if (ws && ws.readyState === 1 /* OPEN */) {
        ws.send(frame);
      } else if (currentState === "reconnecting") {
        audioBuffer.push(frame);
        if (audioBuffer.length > MAX_BUFFERED_AUDIO_FRAMES) {
          audioBuffer.shift();
        }
      }
    },

    destroy() {
      destroyed = true;
      clearTimer();
      if (ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
        ws.close();
        ws = null;
      }
      audioBuffer.length = 0;
      setState("idle");
    },

    get state() {
      return currentState;
    },
  };
}

// ---------------------------------------------------------------------------
// Reconnect on visibility / pageshow (browser-only, can't be in factory)
// ---------------------------------------------------------------------------

function buildWsUrl(companyId: string): string {
  if (typeof window === "undefined") return "";
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${window.location.host}/api/voice/live?companyId=${encodeURIComponent(companyId)}`;
}

// ---------------------------------------------------------------------------
// React hook (thin wrapper — only adds React lifecycle + state binding)
// ---------------------------------------------------------------------------

export function useVoiceGatewaySocket(opts: {
  companyId: string;
  agentId: string;
  enabled: boolean;
  callbacks: GatewaySocketCallbacks;
  /** Injected in tests to avoid real WebSocket. */
  wsFactory?: (url: string) => WebSocket;
}): {
  send(msg: ClientMessage): void;
  sendAudio(pcm: Int16Array): void;
  state: GatewaySocketState;
} {
  const { companyId, agentId, enabled, callbacks, wsFactory } = opts;
  const [state, setState] = useState<GatewaySocketState>("idle");

  // Stable ref so callbacks don't force socket recreation
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const handleRef = useRef<GatewaySocketHandle | null>(null);

  useEffect(() => {
    if (!enabled) {
      handleRef.current?.destroy();
      handleRef.current = null;
      setState("idle");
      return;
    }

    const stableCallbacks: GatewaySocketCallbacks = {
      onServerMessage: (msg) => callbacksRef.current.onServerMessage(msg),
      onAudioFrame: (seq, bytes) => callbacksRef.current.onAudioFrame(seq, bytes),
      onOpen: () => callbacksRef.current.onOpen(),
      onClose: (reason) => callbacksRef.current.onClose(reason),
      onStateChange: (s) => setState(s),
    };

    const handle = createGatewaySocket({
      url: buildWsUrl(companyId),
      agentId,
      callbacks: stableCallbacks,
      wsFactory,
    });
    handleRef.current = handle;

    return () => {
      handle.destroy();
      handleRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, companyId, agentId, wsFactory]);

  // Reconnect on visibility change / pageshow (iOS tab resume)
  useEffect(() => {
    if (!enabled) return;

    const tryReconnect = () => {
      const h = handleRef.current;
      if (!h) return;
      if (h.state !== "open" && h.state !== "connecting") {
        h.destroy();
        const stableCallbacks: GatewaySocketCallbacks = {
          onServerMessage: (msg) => callbacksRef.current.onServerMessage(msg),
          onAudioFrame: (seq, bytes) => callbacksRef.current.onAudioFrame(seq, bytes),
          onOpen: () => callbacksRef.current.onOpen(),
          onClose: (reason) => callbacksRef.current.onClose(reason),
          onStateChange: (s) => setState(s),
        };
        const newHandle = createGatewaySocket({
          url: buildWsUrl(companyId),
          agentId,
          callbacks: stableCallbacks,
          wsFactory,
        });
        handleRef.current = newHandle;
      }
    };

    const handleVisibility = () => {
      if (document.visibilityState === "visible") tryReconnect();
    };

    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("pageshow", tryReconnect);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("pageshow", tryReconnect);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, companyId, agentId, wsFactory]);

  const send = (msg: ClientMessage) => handleRef.current?.send(msg);
  const sendAudio = (pcm: Int16Array) => handleRef.current?.sendAudio(pcm);

  return {
    send: send as (msg: ClientMessage) => void,
    sendAudio: sendAudio as (pcm: Int16Array) => void,
    state,
  };
}
