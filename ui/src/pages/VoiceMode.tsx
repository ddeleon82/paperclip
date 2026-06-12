/**
 * VoiceMode.tsx — thin voice gateway client (FRE-1296 rip-and-replace).
 *
 * Architecture:
 *   useMicPcmStream → PCM16 chunks → useVoiceGatewaySocket → /api/voice/live
 *   /api/voice/live → tagged audio frames → createAudioFrameSink → <audio>
 *
 * All VAD, STT, TTS, and run-watching logic has moved to the server-side
 * Gemini Live gateway. This component only wires the three hooks together and
 * renders the existing presentational layer unchanged.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { useNavigate } from "@/lib/router";
import { cn } from "@/lib/utils";
import { useCompany } from "@/context/CompanyContext";
import { agentsApi } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";

import { useMicPcmStream } from "@/hooks/useMicPcmStream";
import {
  useVoiceGatewaySocket,
  type GatewaySocketCallbacks,
} from "@/hooks/useVoiceGatewaySocket";
import { createAudioFrameSink } from "@/hooks/audio-frame-queue";
import type { ServerMessage } from "@/hooks/useVoiceGatewaySocket";

import { VoicePoweredOrb } from "@/components/voice/VoicePoweredOrb";
import { VoiceScrollback, type VoiceTurn } from "@/components/voice/VoiceScrollback";
import { VoiceControls } from "@/components/voice/VoiceControls";

// ---------------------------------------------------------------------------
// Phase — matches VoicePoweredOrb's accepted Phase union
// ---------------------------------------------------------------------------

type Phase = "idle" | "listening" | "thinking" | "speaking" | "muted" | "error";

// Display phase shown to the user. "working" is derived, never stored: it
// overlays idle/listening/thinking while a voice-dispatched Conrad run is
// active (FRE-1361). The underlying machine phase is left untouched.
type DisplayPhase = Phase | "working";

function phaseToStatusLabel(phase: DisplayPhase): string {
  switch (phase) {
    case "listening": return "Listening — speak when ready";
    case "thinking":  return "Thinking…";
    case "speaking":  return "Speaking";
    case "working":   return "Conrad is working on it";
    case "muted":     return "Muted — tap mic to unmute";
    case "error":     return "Error — see message below";
    case "idle":
    default:          return "Connecting…";
  }
}

// ---------------------------------------------------------------------------
// VoiceMode
// ---------------------------------------------------------------------------

export function VoiceMode() {
  const { selectedCompanyId } = useCompany();
  const navigate = useNavigate();

  // ------ UI state --------------------------------------------------------
  const [phase, setPhase] = useState<Phase>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [turns, setTurns] = useState<VoiceTurn[]>([]);
  // isSpeaking drives the VoiceControls "stop" button highlight; fed by the
  // audio frame sink's onActivity callback rather than derived from phase so
  // it reflects actual playback, not just protocol messages.
  const [isSpeaking, setIsSpeaking] = useState(false);
  // Run IDs of voice-dispatched Conrad runs still in flight (FRE-1361).
  // Non-empty set + a passive machine phase = "working" display phase.
  const [activeRunIds, setActiveRunIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const muted = phase === "muted";

  // ------ agent selection (prefer Conrad) --------------------------------
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

  // ------ audio playback element -----------------------------------------
  // The audio element is the only playback surface; the frame sink writes
  // MP3 blobs into it as object URLs. stopPlayback() hard-pauses in-flight
  // audio for barge-in.
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const play = useCallback(async (blob: Blob): Promise<void> => {
    const el = audioRef.current;
    if (!el) return;
    const url = URL.createObjectURL(blob);
    el.src = url;
    try {
      await el.play();
      await new Promise<void>((resolve) => {
        el.addEventListener("ended", () => resolve(), { once: true });
        el.addEventListener("pause", () => resolve(), { once: true });
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  }, []);

  const stopPlayback = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    el.pause();
    el.src = "";
  }, []);

  // ------ audio frame sink (session-long, recreated on config change) ----
  const sinkRef = useRef<ReturnType<typeof createAudioFrameSink> | null>(null);

  useEffect(() => {
    const sink = createAudioFrameSink({
      play,
      stopPlayback,
      onActivity: setIsSpeaking,
    });
    sinkRef.current = sink;
    // No cleanup: the sink does not hold DOM resources; the audio element
    // teardown is handled by the element itself on unmount.
  }, [play, stopPlayback]);

  // ------ server message handler (stable via ref in hook) ----------------
  const handleServerMessage = useCallback((msg: ServerMessage) => {
    switch (msg.type) {
      case "ready":
      case "resumed":
        setPhase("listening");
        setErrorMessage(null);
        break;

      case "status":
        // status.state is "listening" | "thinking" | "speaking" — all valid
        // Phase values; cast is safe.
        setPhase(msg.state as Phase);
        break;

      case "transcript":
        if (msg.final) {
          setTurns((prev) => [
            ...prev,
            { id: crypto.randomUUID(), role: msg.role, text: msg.text },
          ]);
        }
        break;

      case "audio-start":
        sinkRef.current?.onAudioStart(msg.seq);
        break;

      case "audio-end":
        sinkRef.current?.onAudioEnd(msg.seq);
        break;

      case "interrupt":
        sinkRef.current?.interrupt();
        break;

      case "task-created":
      case "run-dispatched":
        // Track the run so the orb shows the "working" display phase while
        // Conrad executes. The gateway handles polling and speaks the outcome.
        setActiveRunIds((prev) => {
          if (prev.has(msg.runId)) return prev;
          const next = new Set(prev);
          next.add(msg.runId);
          return next;
        });
        break;

      case "run-complete":
        // Gateway has already spoken the outcome; just clear the working state.
        setActiveRunIds((prev) => {
          if (!prev.has(msg.runId)) return prev;
          const next = new Set(prev);
          next.delete(msg.runId);
          return next;
        });
        break;

      case "error":
        setPhase("error");
        setErrorMessage(msg.message);
        break;

      case "superseded":
        // Another session from this user replaced ours (e.g. second tab).
        setPhase("idle");
        break;
    }
  }, []);

  const handleAudioFrame = useCallback((seq: number, bytes: Uint8Array) => {
    sinkRef.current?.onAudioChunk(seq, bytes);
  }, []);

  const handleOpen = useCallback(() => {
    // Socket opened (or reconnected). Gateway sends "ready"/"resumed"
    // immediately after, which flips phase to "listening". Nothing to do here
    // except ensure we're not stuck in error from a prior drop.
    setPhase("idle");
  }, []);

  const handleClose = useCallback((reason: "superseded" | "error" | "normal") => {
    if (reason === "error") {
      setPhase("error");
      setErrorMessage("Connection lost — reconnecting…");
    } else if (reason === "superseded") {
      setPhase("idle");
    }
    // "normal" means we closed it ourselves (handleEnd); no state change.
  }, []);

  // ------ socket ----------------------------------------------------------
  const socketEnabled = !!selectedCompanyId && !!agentId;

  const callbacks: GatewaySocketCallbacks = {
    onServerMessage: handleServerMessage,
    onAudioFrame: handleAudioFrame,
    onOpen: handleOpen,
    onClose: handleClose,
  };

  const { send, sendAudio } = useVoiceGatewaySocket({
    companyId: selectedCompanyId ?? "",
    agentId: agentId ?? "",
    enabled: socketEnabled,
    callbacks,
  });

  // ------ mic → gateway --------------------------------------------------
  // Mic capture is enabled only when the socket is up and the user is not
  // muted/errored/idle. In those phases the gateway ignores audio anyway,
  // but we also save getUserMedia CPU.
  const micEnabled =
    socketEnabled &&
    phase !== "muted" &&
    phase !== "error" &&
    phase !== "idle";

  useMicPcmStream({
    onChunk: sendAudio,
    enabled: micEnabled,
  });

  // ------ controls -------------------------------------------------------
  const handleEnd = useCallback(() => {
    send({ type: "end" });
    stopPlayback();
    sinkRef.current?.interrupt();
    navigate("/dashboard");
  }, [send, stopPlayback, navigate]);

  const handleToggleMute = useCallback(() => {
    if (phase === "muted") {
      send({ type: "unmute" });
      setPhase("listening");
    } else {
      send({ type: "mute" });
      setPhase("muted");
    }
  }, [phase, send]);

  const handleStop = useCallback(() => {
    // Barge-in: hard-stop current audio and restart mic listening.
    stopPlayback();
    sinkRef.current?.interrupt();
  }, [stopPlayback]);

  // ------ render ---------------------------------------------------------
  // "working" overlays passive phases only; speaking/muted/error always win
  // so live conversation feedback is never masked by background work.
  const displayPhase: DisplayPhase =
    activeRunIds.size > 0 &&
    (phase === "idle" || phase === "listening" || phase === "thinking")
      ? "working"
      : phase;
  const statusLabel = phaseToStatusLabel(displayPhase);

  return (
    <div
      className="flex h-dvh flex-col bg-background text-foreground"
      data-testid="voice-mode-page"
    >
      {/* Single playback element for all server-synthesized TTS audio. */}
      <audio ref={audioRef} aria-hidden="true" />

      <VoiceControls
        muted={muted}
        isSpeaking={isSpeaking}
        onEnd={handleEnd}
        onToggleMute={handleToggleMute}
        onStop={handleStop}
        className="border-b border-border"
      />

      <div className="flex flex-1 flex-col items-center justify-center gap-6 px-4">
        <VoicePoweredOrb
          phase={displayPhase}
          className="h-72 w-72 sm:h-80 sm:w-80"
        />

        <div
          className="flex items-center gap-2 text-sm text-muted-foreground"
          data-testid="voice-mode-status"
          data-phase={displayPhase}
        >
          <span
            aria-hidden="true"
            className={cn(
              "inline-block h-2 w-2 rounded-full",
              displayPhase === "listening" && "animate-pulse bg-emerald-500",
              displayPhase === "thinking"  && "animate-pulse bg-amber-500",
              displayPhase === "speaking"  && "bg-sky-500",
              displayPhase === "working"   && "animate-pulse bg-violet-500",
              displayPhase === "muted"     && "bg-muted-foreground/60",
              displayPhase === "error"     && "bg-destructive",
              displayPhase === "idle"      && "bg-muted-foreground/40",
            )}
          />
          <span>{statusLabel}</span>
        </div>
      </div>

      <VoiceScrollback
        turns={turns}
        className="max-h-40 shrink-0 border-t border-border"
      />

      {phase === "error" && errorMessage ? (
        <div
          className="px-4 pb-4 text-center text-xs text-destructive"
          data-testid="voice-mode-error"
        >
          {errorMessage}
        </div>
      ) : null}
    </div>
  );
}
