import React, { useEffect, useCallback, useState } from "react";
import { useVoiceMode } from "./useVoiceMode";
import { useVoiceActions } from "./api";

const DEFAULT_VOICE_ID = "VjSFSNiy9sK85Z9QRu3d"; // Kenn Akomea

// ---------------------------------------------------------------------------
// Simple inline SVG icons (avoids lucide-react runtime dep in UI bundle)
// ---------------------------------------------------------------------------

function MicIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="22" />
    </svg>
  );
}

function SpinnerIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ animation: "voice-mode-spin 0.9s linear infinite" }}
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}

function MicOffIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="2" y1="2" x2="22" y2="22" />
      <path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2" />
      <path d="M5 10v2a7 7 0 0 0 12 5" />
      <path d="M15 9.34V5a3 3 0 0 0-5.68-1.33" />
      <path d="M9 9v3a3 3 0 0 0 5.12 2.12" />
      <line x1="12" y1="19" x2="12" y2="22" />
    </svg>
  );
}

function Volume2Icon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Component props
// ---------------------------------------------------------------------------

export interface VoiceComposerControlsProps {
  /** Called when a transcript is ready (from mic click or spacebar push-to-talk). */
  onTranscript: (text: string) => void;
  /** Voice ID for TTS output. Defaults to Kenn Akomea. */
  voiceId?: string;
}

// ---------------------------------------------------------------------------
// VoiceComposerControls
// ---------------------------------------------------------------------------

export function VoiceComposerControls({
  onTranscript,
  voiceId = DEFAULT_VOICE_ID,
}: VoiceComposerControlsProps) {
  const {
    enabled,
    toggle,
    isRecording,
    isSpeaking,
    startRecording,
    stopRecording,
    playAudio,
    stopSpeaking,
  } = useVoiceMode();

  const { transcribeAudio } = useVoiceActions();
  const [transcribing, setTranscribing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Handle blob from spacebar push-to-talk (dispatched by useVoiceMode)
  const handleTranscribeBlob = useCallback(
    async (blob: Blob) => {
      setTranscribing(true);
      setErrorMsg(null);
      try {
        const { transcript } = await transcribeAudio(blob);
        if (transcript) {
          onTranscript(transcript);
        } else {
          setErrorMsg("No speech detected");
        }
      } catch (err) {
        const raw = err instanceof Error ? err.message : "Transcription failed";
        setErrorMsg(raw.length > 80 ? raw.slice(0, 77) + "..." : raw);
        // Also log for DevTools debugging
        console.error("[voice-mode] transcribe failed:", err);
      } finally {
        setTranscribing(false);
      }
    },
    [transcribeAudio, onTranscript],
  );

  // Auto-clear error after 5s so it doesn't get stuck
  useEffect(() => {
    if (!errorMsg) return;
    const t = window.setTimeout(() => setErrorMsg(null), 5000);
    return () => window.clearTimeout(t);
  }, [errorMsg]);

  useEffect(() => {
    const handler = (e: Event) => {
      const blob = (e as CustomEvent<Blob>).detail;
      if (blob instanceof Blob) void handleTranscribeBlob(blob);
    };
    window.addEventListener("voice-mode:transcribe", handler);
    return () => window.removeEventListener("voice-mode:transcribe", handler);
  }, [handleTranscribeBlob]);

  // Click-to-toggle recording. Mic works regardless of voice-mode toggle:
  // toggle off = transcript inserted into composer for review
  // toggle on  = transcript auto-sent
  const handleMicClick = async () => {
    if (transcribing) return;
    if (isSpeaking) {
      stopSpeaking();
      return;
    }
    if (isRecording) {
      const blob = await stopRecording();
      if (blob) await handleTranscribeBlob(blob);
    } else {
      await startRecording();
    }
  };

  const micLabel = transcribing
    ? "Transcribing..."
    : isRecording
      ? "Stop recording"
      : "Record voice input";

  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}
      className="voice-composer-controls"
    >
      <style>{`@keyframes voice-mode-spin { to { transform: rotate(360deg); } }`}</style>

      {/* Voice mode toggle */}
      <button
        type="button"
        aria-label={`Voice mode ${enabled ? "on" : "off"}`}
        onClick={toggle}
        title={enabled ? "Voice mode: on (auto-sends)" : "Voice mode: off (inserts text)"}
        style={{
          display: "flex",
          alignItems: "center",
          padding: "0.25rem",
          background: "none",
          border: "none",
          cursor: "pointer",
          opacity: enabled ? 1 : 0.5,
          color: enabled ? "inherit" : "gray",
        }}
      >
        <Volume2Icon size={16} />
      </button>

      {/* Mic button */}
      <button
        type="button"
        aria-label={micLabel}
        onClick={() => void handleMicClick()}
        disabled={transcribing}
        title={micLabel}
        style={{
          display: "flex",
          alignItems: "center",
          padding: "0.25rem",
          background: "none",
          border: "none",
          cursor: transcribing ? "not-allowed" : "pointer",
          color: isRecording ? "red" : transcribing ? "#888" : "inherit",
          opacity: 1,
        }}
      >
        {transcribing
          ? <SpinnerIcon size={16} />
          : isRecording
            ? <MicOffIcon size={16} />
            : <MicIcon size={16} />}
      </button>

      {/* Inline error message — auto-clears after 5s. Surfaces transcription
          failures (e.g. missing ElevenLabs key, network error) instead of
          silently swallowing them. */}
      {errorMsg ? (
        <span
          role="alert"
          style={{
            fontSize: "0.75rem",
            color: "#dc2626",
            marginLeft: "0.5rem",
            whiteSpace: "nowrap",
          }}
        >
          {errorMsg}
        </span>
      ) : null}
    </div>
  );
}
