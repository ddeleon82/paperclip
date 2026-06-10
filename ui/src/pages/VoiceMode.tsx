import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { LiveEvent } from "@paperclipai/shared";

import { useNavigate } from "@/lib/router";
import { cn } from "@/lib/utils";
import { useCompany } from "@/context/CompanyContext";
import { agentsApi } from "@/api/agents";
import { heartbeatsApi } from "@/api/heartbeats";
import { pluginsApi } from "@/api/plugins";
import { queryKeys } from "@/lib/queryKeys";

import { useVad } from "@/hooks/useVad";
import { useStreamingTts } from "@/hooks/useStreamingTts";
import { useVoiceSessionMachine } from "@/hooks/useVoiceSessionMachine";
import type { MutablePhase } from "@/hooks/useVoiceSessionMachine";
import { useVoiceCues } from "@/hooks/useVoiceCues";
import { createAckCache } from "@/hooks/useAckPlayer";
import type { AckCache } from "@/hooks/useAckPlayer";

import { VoicePoweredOrb } from "@/components/voice/VoicePoweredOrb";
import { VoiceScrollback, type VoiceTurn } from "@/components/voice/VoiceScrollback";
import { VoiceControls } from "@/components/voice/VoiceControls";

/**
 * Kenn Akomea (ElevenLabs). Hard-coded per FRE-968 plan - Conrad's voice.
 */
const KENN_VOICE_ID = "VjSFSNiy9sK85Z9QRu3d";

const VOICE_MODE_PLUGIN_ID = "voice-mode";

// ---------------------------------------------------------------------------
// WAV encoding helpers - VAD gives Float32 PCM @ 16kHz mono. ElevenLabs STT
// accepts WAV directly, so we wrap a minimal 16-bit PCM WAV header.
// ---------------------------------------------------------------------------

const VAD_SAMPLE_RATE = 16000;

function floatTo16BitPCM(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const pcm = floatTo16BitPCM(samples);
  const byteLength = pcm.length * 2;
  const buffer = new ArrayBuffer(44 + byteLength);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + byteLength, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, "data");
  view.setUint32(40, byteLength, true);

  const out = new Uint8Array(buffer);
  // Copy PCM samples in little-endian after the header.
  const pcmBytes = new Uint8Array(pcm.buffer);
  out.set(pcmBytes, 44);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, Math.min(i + chunk, bytes.length));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// Helpers for resolving the current phase into the orb's mutable phase view.
// ---------------------------------------------------------------------------

function machinePhaseToOrb(
  phase: "idle" | "listening" | "thinking" | "speaking" | "muted" | "error",
): MutablePhase | "muted" | "error" {
  if (phase === "muted" || phase === "error") return phase;
  return phase;
}

// ---------------------------------------------------------------------------
// Best-effort assistant-message extractor from the run log.
//
// The agent run writes NDJSON lines `{ stream, chunk }` to its log. For
// claude_local runs the stdout chunks are themselves stream-json events
// (`--output-format stream-json`), so the last chunk is a `{"type":"result",
// ...}` envelope — speaking that raw JSON aloud was the FRE-1296 bug. We now
// parse stream-json and return the `result` text (falling back to the last
// assistant message text block, then to raw text for non-claude adapters).
// ---------------------------------------------------------------------------

interface StreamJsonEvent {
  type?: string;
  result?: unknown;
  message?: { content?: Array<{ type?: string; text?: string }> };
}

/** Extract speakable text from a single claude stream-json line, or null. */
function extractSpokenText(line: string): string | null {
  let evt: StreamJsonEvent;
  try {
    evt = JSON.parse(line) as StreamJsonEvent;
  } catch {
    return null;
  }
  if (!evt || typeof evt !== "object") return null;
  if (evt.type === "result" && typeof evt.result === "string" && evt.result.trim()) {
    return evt.result.trim();
  }
  if (evt.type === "assistant" && Array.isArray(evt.message?.content)) {
    const text = evt.message.content
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join(" ")
      .trim();
    if (text) return text;
  }
  return null;
}

/**
 * Light markdown strip for TTS. The voice system prompt forbids markdown, but
 * agents occasionally leak it; reading "asterisk asterisk" aloud is worse than
 * a lossy strip.
 */
function stripMarkdownForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]*)\*\*/g, "$1")
    .replace(/\*([^*]*)\*/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchFinalAssistantText(runId: string): Promise<string> {
  try {
    const { content } = await heartbeatsApi.log(runId, 0, 256_000);
    if (!content) return "";
    const lines = content.split("\n");
    let rawFallback = "";
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let chunk: string | null = null;
      try {
        const parsed = JSON.parse(line) as { stream?: string; chunk?: string };
        if (parsed.stream === "stdout" && parsed.chunk && parsed.chunk.trim()) {
          chunk = parsed.chunk;
        } else {
          continue;
        }
      } catch {
        // Plain-text log line (non-NDJSON adapters). Keep as a fallback only.
        if (!rawFallback) rawFallback = line;
        continue;
      }
      // A chunk may contain one or more stream-json lines; walk them backward.
      const sublines = chunk.split("\n");
      for (let j = sublines.length - 1; j >= 0; j--) {
        const sub = sublines[j].trim();
        if (!sub) continue;
        const spoken = extractSpokenText(sub);
        if (spoken) return stripMarkdownForSpeech(spoken);
        // Non-stream-json stdout (plain-text adapters): remember the first
        // (i.e. latest) raw text we see as a fallback. Gate on whether the
        // subline parses as JSON (a stream-json event with no speakable text)
        // rather than on its leading character, so plain-text replies that
        // happen to start with "{" are not dropped.
        if (!rawFallback) {
          try {
            JSON.parse(sub);
          } catch {
            rawFallback = sub;
          }
        }
      }
    }
    return stripMarkdownForSpeech(rawFallback);
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// VoiceMode page
// ---------------------------------------------------------------------------

export function VoiceMode() {
  const { selectedCompanyId } = useCompany();
  const navigate = useNavigate();

  const { state, dispatch } = useVoiceSessionMachine();
  const tts = useStreamingTts();
  const cues = useVoiceCues();

  // `useStreamingTts` returns a fresh object every render. Mirror it into a
  // ref so long-lived effects (notably the WS subscription) can read the
  // latest `play`/`stop` without listing `tts` in their dep array, which
  // would otherwise tear down + reconnect the socket on every render that
  // flips `tts.isPlaying`.
  const ttsRef = useRef(tts);
  useEffect(() => {
    ttsRef.current = tts;
  }, [tts]);

  // Track the active session + current turn IDs so the network code can
  // dispatch the right events back into the machine without races.
  const [sessionId, setSessionId] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const turnIdRef = useRef<string | null>(null);
  const runIdRef = useRef<string | null>(null);

  // ---- Verbal ack (ada_v2 NON_BLOCKING pattern) --------------------------
  // Pre-cached short phrases played the instant a turn POST succeeds so the
  // user hears confirmation immediately rather than staring at a silent
  // "thinking" state for 40+ seconds.
  const ackAudioRef = useRef<HTMLAudioElement | null>(null);
  const ackCacheRef = useRef<AckCache | null>(null);

  const [turns, setTurns] = useState<VoiceTurn[]>([]);
  const muted = state.phase === "muted";
  const machinePhase = state.phase;

  // ---- Agent selection ---------------------------------------------------
  // TODO(fre-968): Surface an agent picker. For v1 we prefer the hub agent
  // (Conrad) so the voice persona matches the configured TTS voice; the
  // agents list comes back in arbitrary order, so agents[0] was a different
  // agent on every session (FRE-1296 field test: turns ran on Cortex/Hunter).
  const { data: agents } = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.agents.list(selectedCompanyId)
      : ["agents", "none"],
    queryFn: () => agentsApi.list(selectedCompanyId as string),
    enabled: !!selectedCompanyId,
  });
  const agentId =
    agents?.find((a) => a.name?.trim().toLowerCase() === "conrad")?.id ??
    agents?.[0]?.id ??
    null;

  // ---- Session lifecycle (create on mount, end on unmount) ---------------
  useEffect(() => {
    if (!selectedCompanyId || !agentId) return;
    let cancelled = false;

    dispatch({ type: "START" });

    (async () => {
      try {
        const res = await fetch("/api/voice/session", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ companyId: selectedCompanyId, agentId }),
        });
        if (!res.ok) throw new Error(`session create failed: ${res.status}`);
        const body = (await res.json()) as { sessionId: string };
        if (cancelled) return;
        sessionIdRef.current = body.sessionId;
        setSessionId(body.sessionId);
        // Build the ack cache and warm it in the background. warm() is
        // best-effort - failures just mean next() returns null and no ack
        // plays (not a hard error).
        const cache = createAckCache((text) =>
          pluginsApi
            .bridgePerformAction(
              VOICE_MODE_PLUGIN_ID,
              "voice.speak",
              { text, voiceId: KENN_VOICE_ID },
              selectedCompanyId,
            )
            .then((res) => {
              const r = res as { data: { audioBase64: string; mime: string } };
              const b64 = r.data?.audioBase64 ?? "";
              const mime = r.data?.mime ?? "audio/mpeg";
              const bytes = base64ToBytes(b64);
              return new Blob([bytes.buffer as ArrayBuffer], { type: mime });
            }),
        );
        ackCacheRef.current = cache;
        void cache.warm();
      } catch (err) {
        if (cancelled) return;
        dispatch({
          type: "ERROR",
          message: err instanceof Error ? err.message : "session create failed",
        });
      }
    })();

    return () => {
      cancelled = true;
      const id = sessionIdRef.current;
      if (id) {
        // Fire-and-forget; the server endpoint is idempotent.
        void fetch(`/api/voice/session/${encodeURIComponent(id)}`, {
          method: "DELETE",
          credentials: "include",
        }).catch(() => {
          // ignore - unmount cleanup
        });
      }
    };
  }, [selectedCompanyId, agentId, dispatch]);

  // ---- VAD: capture speech, transcribe, post turn ------------------------
  const handleSpeechEnd = useCallback(
    async (audio: Float32Array) => {
      const activeSession = sessionIdRef.current;
      if (!activeSession || !agentId) return;
      // Only accept speech while listening. Without this gate, a background
      // noise blip during "thinking" replaced turnIdRef/runIdRef, so the
      // in-flight run's "succeeded" event no longer matched and the reply was
      // silently dropped (FRE-1296: 5 turns spawned in one minute, none
      // spoken). Barge-in during "speaking" dispatches BARGE_IN first, which
      // returns the machine to "listening" before speech-end fires.
      if (state.phase !== "listening") return;

      // Optimistically assign a turn id locally; the server's runId comes back
      // afterwards and we attach it via runIdRef.
      const localTurnId = crypto.randomUUID();
      turnIdRef.current = localTurnId;

      try {
        const wav = encodeWav(audio, VAD_SAMPLE_RATE);
        const audioBase64 = bytesToBase64(wav);
        const transcribeRes = (await pluginsApi.bridgePerformAction(
          VOICE_MODE_PLUGIN_ID,
          "voice.transcribe",
          { audioBase64, mime: "audio/wav" },
          selectedCompanyId,
        )) as { data: { transcript: string; audioId: string } };
        const transcript = transcribeRes.data?.transcript?.trim();
        if (!transcript) return;
        // STT on a noise blip yields short filler ("you", "uh") - don't burn
        // a full agent run on it.
        if (transcript.length < 3) return;

        setTurns((prev) => [
          ...prev,
          { id: `${localTurnId}-user`, role: "user", text: transcript },
        ]);
        // Audible confirmation that the user's speech was captured + transcribed.
        // Fires only after a non-empty transcript so the cue actually corresponds
        // to received input, not a discarded short utterance.
        cues.playSpeechReceived();
        dispatch({ type: "USER_SPEECH_END", turnId: localTurnId });

        const turnRes = await fetch(
          `/api/voice/session/${encodeURIComponent(activeSession)}/turn`,
          {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ transcript, agentId }),
          },
        );
        if (!turnRes.ok) throw new Error(`turn post failed: ${turnRes.status}`);
        const turnBody = (await turnRes.json()) as
          | { runId: string }
          | { status: "skipped" };
        if ("runId" in turnBody) {
          runIdRef.current = turnBody.runId;
          // Play a pre-cached verbal ack so the user hears instant confirmation
          // while the full 40s agent run runs in the background. Skip if the
          // previous answer is still playing (don't talk over it). The ack
          // must NOT change machine phase - it is not the answer.
          if (!ttsRef.current.isPlaying) {
            const ackUrl = ackCacheRef.current?.next() ?? null;
            if (ackUrl && ackAudioRef.current) {
              ackAudioRef.current.src = ackUrl;
              void ackAudioRef.current.play();
            }
          }
        } else {
          // Wakeup was deduped - drop back to listening without a turn.
          runIdRef.current = null;
          dispatch({ type: "BARGE_IN" });
        }
      } catch (err) {
        dispatch({
          type: "ERROR",
          message: err instanceof Error ? err.message : "turn failed",
        });
      }
    },
    [agentId, dispatch, selectedCompanyId, state.phase, cues],
  );

  const vad = useVad({
    onSpeechEnd: handleSpeechEnd,
    enabled: !!sessionId && machinePhase !== "muted" && machinePhase !== "error",
  });

  // ---- WS: subscribe to run.* events for the active runId ----------------
  useEffect(() => {
    if (!selectedCompanyId) return;
    let closed = false;
    let reconnectTimer: number | null = null;
    let socket: WebSocket | null = null;

    const connect = () => {
      if (closed) return;
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      const url = `${protocol}://${window.location.host}/api/companies/${encodeURIComponent(selectedCompanyId)}/events/ws`;
      socket = new WebSocket(url);

      socket.onmessage = async (msg) => {
        const raw = typeof msg.data === "string" ? msg.data : "";
        if (!raw) return;
        let event: LiveEvent;
        try {
          event = JSON.parse(raw) as LiveEvent;
        } catch {
          return;
        }
        const payload = event.payload ?? {};
        const runId = typeof payload["runId"] === "string" ? payload["runId"] : null;
        const activeRunId = runIdRef.current;
        const activeTurnId = turnIdRef.current;
        if (!runId || runId !== activeRunId || !activeTurnId) return;

        if (event.type === "heartbeat.run.status") {
          const status = typeof payload["status"] === "string" ? payload["status"] : "";
          if (status === "succeeded") {
            dispatch({ type: "SERVER_THINKING_DONE", turnId: activeTurnId });
            const text = await fetchFinalAssistantText(runId);
            if (text) {
              setTurns((prev) => [
                ...prev,
                { id: `${activeTurnId}-assistant`, role: "assistant", text },
              ]);
              await playAssistantSpeech(text, activeTurnId);
            } else {
              // Nothing to speak - return to listening so the user can retry.
              dispatch({ type: "TTS_END", turnId: activeTurnId });
            }
          } else if (
            status === "failed" ||
            status === "timed_out" ||
            status === "cancelled"
          ) {
            dispatch({ type: "ERROR", message: `run ${status}` });
          }
        }
      };

      socket.onerror = () => socket?.close();
      socket.onclose = () => {
        if (closed) return;
        reconnectTimer = window.setTimeout(connect, 1500);
      };
    };

    const playAssistantSpeech = async (text: string, turnId: string) => {
      try {
        const speakRes = (await pluginsApi.bridgePerformAction(
          VOICE_MODE_PLUGIN_ID,
          "voice.speak",
          { text, voiceId: KENN_VOICE_ID },
          selectedCompanyId,
        )) as { data: { audioBase64: string; mime: string } };
        const audioBase64 = speakRes.data?.audioBase64;
        if (!audioBase64) {
          dispatch({ type: "TTS_END", turnId });
          return;
        }
        const bytes = base64ToBytes(audioBase64);
        // Pause the ack clip before real answer audio starts so they don't overlap.
        ackAudioRef.current?.pause();
        await ttsRef.current.play(bytes);
        // Heuristic: play() resolves once playback starts. Listen for ended
        // via the isPlaying signal in a separate effect below.
      } catch (err) {
        dispatch({
          type: "ERROR",
          message: err instanceof Error ? err.message : "tts failed",
        });
      }
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (socket) {
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        if (socket.readyState === WebSocket.OPEN) socket.close(1000, "voice_mode_unmount");
      }
    };
  }, [selectedCompanyId, dispatch]);

  // ---- Mic-open cue: fire a soft tone the first time we enter `listening`
  // and on every transition back into `listening` (after thinking/speaking/
  // unmute). Tracks the previous phase in a ref so we play only on the edge,
  // not every render that sees phase === "listening".
  const prevPhaseRef = useRef<typeof state.phase | null>(null);
  useEffect(() => {
    const prev = prevPhaseRef.current;
    prevPhaseRef.current = state.phase;
    if (state.phase === "listening" && prev !== "listening") {
      cues.playMicOpen();
    }
  }, [state.phase, cues]);

  // ---- TTS end watcher: when isPlaying flips false during speaking, end turn
  const wasPlayingRef = useRef(false);
  useEffect(() => {
    const wasPlaying = wasPlayingRef.current;
    wasPlayingRef.current = tts.isPlaying;
    if (wasPlaying && !tts.isPlaying && state.phase === "speaking") {
      dispatch({ type: "TTS_END", turnId: state.turnId });
    }
  }, [tts.isPlaying, state, dispatch]);

  // ---- Barge-in: VAD detects user speech while assistant is speaking ----
  useEffect(() => {
    if (vad.state === "speaking" && state.phase === "speaking") {
      ackAudioRef.current?.pause();
      tts.stop();
      dispatch({ type: "BARGE_IN" });
    }
  }, [vad.state, state.phase, tts, dispatch]);

  // ---- Mute side-effect: pause/resume VAD ------------------------------
  useEffect(() => {
    if (state.phase === "muted") {
      vad.pause();
    } else {
      vad.resume();
    }
    // vad is a stable ref-backed object; we only want phase as a trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase]);

  // ---- Controls handlers ----------------------------------------------
  const handleEnd = useCallback(() => {
    const id = sessionIdRef.current;
    sessionIdRef.current = null;
    setSessionId(null);
    dispatch({ type: "STOP" });
    tts.stop();
    if (id) {
      void fetch(`/api/voice/session/${encodeURIComponent(id)}`, {
        method: "DELETE",
        credentials: "include",
      }).catch(() => {
        // ignore
      });
    }
    navigate("/dashboard");
  }, [dispatch, navigate, tts]);

  const handleToggleMute = useCallback(() => {
    if (state.phase === "muted") dispatch({ type: "UNMUTE" });
    else dispatch({ type: "MUTE" });
  }, [state.phase, dispatch]);

  const handleStop = useCallback(() => {
    ackAudioRef.current?.pause();
    tts.stop();
    if (state.phase === "speaking") {
      dispatch({ type: "BARGE_IN" });
    }
  }, [tts, state.phase, dispatch]);

  const orbPhase = machinePhaseToOrb(machinePhase);
  const statusLabel = phaseToStatusLabel(machinePhase);

  return (
    <div
      className="flex h-dvh flex-col bg-background text-foreground"
      data-testid="voice-mode-page"
    >
      {/* Hidden audio element for pre-cached verbal acks ("On it." etc.).
          Must NOT route through useStreamingTts so acks never interleave
          with answer audio. The ref is managed in handleSpeechEnd / paused
          in three places: answer start, barge-in, and STOP. */}
      <audio ref={ackAudioRef} aria-hidden="true" />
      <VoiceControls
        muted={muted}
        isSpeaking={tts.isPlaying}
        onEnd={handleEnd}
        onToggleMute={handleToggleMute}
        onStop={handleStop}
        className="border-b border-border"
      />

      {/* Orb takes the bulk of the viewport, vertically + horizontally
          centered. Larger size + centered position per Dom's request — the
          orb is the primary surface; transcript and controls are secondary. */}
      <div className="flex flex-1 flex-col items-center justify-center gap-6 px-4">
        <VoicePoweredOrb
          phase={orbPhase}
          getLevel={tts.getLevel}
          className="h-72 w-72 sm:h-80 sm:w-80"
        />

        {/* Mic-ready indicator. Shows a pulsing dot + readable phase label so
            the user always knows whether the mic is hot. The dot turns muted
            when muted/error so the colour change reinforces the label. */}
        <div
          className="flex items-center gap-2 text-sm text-muted-foreground"
          data-testid="voice-mode-status"
          data-phase={machinePhase}
        >
          <span
            aria-hidden="true"
            className={cn(
              "inline-block h-2 w-2 rounded-full",
              machinePhase === "listening" && "animate-pulse bg-emerald-500",
              machinePhase === "thinking" && "animate-pulse bg-amber-500",
              machinePhase === "speaking" && "bg-sky-500",
              machinePhase === "muted" && "bg-muted-foreground/60",
              machinePhase === "error" && "bg-destructive",
              machinePhase === "idle" && "bg-muted-foreground/40",
            )}
          />
          <span>{statusLabel}</span>
        </div>
      </div>

      <VoiceScrollback turns={turns} className="max-h-40 shrink-0 border-t border-border" />

      {state.phase === "error" ? (
        <div
          className="px-4 pb-4 text-center text-xs text-destructive"
          data-testid="voice-mode-error"
        >
          {state.message}
        </div>
      ) : null}
    </div>
  );
}

function phaseToStatusLabel(phase: "idle" | "listening" | "thinking" | "speaking" | "muted" | "error"): string {
  switch (phase) {
    case "listening":
      return "Listening — speak when ready";
    case "thinking":
      return "Thinking…";
    case "speaking":
      return "Speaking";
    case "muted":
      return "Muted — tap mic to unmute";
    case "error":
      return "Error — see message below";
    case "idle":
    default:
      return "Connecting…";
  }
}

export default VoiceMode;
