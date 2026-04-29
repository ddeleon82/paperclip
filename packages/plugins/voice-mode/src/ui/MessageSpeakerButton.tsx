/**
 * MessageSpeakerButton — TTS play/stop button rendered per comment.
 *
 * Slot type: commentAnnotation
 * The host provides comment ID via context.entityId (entityType: "comment").
 *
 * Behavior:
 * - Auto-plays once on mount when voice mode is enabled (sessionStorage dedup).
 * - Renders a Play (Volume2) / Stop (Square) toggle button.
 * - Per-agent voice lookup via voice.agentVoices.get KV (Task 13); falls back
 *   to Kenn Akomea if no override is set.
 */
import React, { useEffect, useState, useCallback } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import type { PluginCommentAnnotationProps } from "@paperclipai/plugin-sdk/ui";
import { useVoiceMode } from "./useVoiceMode";
import { useVoiceActions } from "./api";
import { KENN_VOICE_ID } from "../shared/voices";

// ---------------------------------------------------------------------------
// Inline SVG icons — avoids any runtime icon-lib overhead in the UI bundle.
// Matching pattern from VoiceComposerControls.tsx.
// ---------------------------------------------------------------------------

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

function SquareIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sessionPlayedKey(commentId: string): string {
  return `paperclip:voiceMode:played:${commentId}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MessageSpeakerButton({ context }: PluginCommentAnnotationProps) {
  const commentId = context.entityId;
  // The comment text is not directly in props — we fall back to reading the
  // DOM text of the comment element in the host page. This is intentional for
  // V1: the host does not pass comment body through PluginCommentAnnotationProps.
  // The component mounts adjacent to the comment body node; we use a data attr
  // selector as a best-effort approach. If nothing is found we skip TTS.
  const [commentText, setCommentText] = useState<string>("");
  const [voiceId, setVoiceId] = useState<string>(KENN_VOICE_ID);

  const { enabled, isSpeaking, playAudio, stopSpeaking } = useVoiceMode();
  const { speakText } = useVoiceActions();

  // voice.agentVoices.get — registered in Task 13
  const getAgentVoices = usePluginAction("voice.agentVoices.get");

  // Load per-agent voice override on mount
  useEffect(() => {
    getAgentVoices({})
      .then((raw) => {
        const map = (raw ?? {}) as Record<string, string>;
        // context.entityType is "comment"; no agentId in PluginCommentAnnotationProps.
        // Use parentEntityId (issue id) as a proxy scope key for now — in a
        // future iteration the host will expose an agentId directly.
        const parentId = context.parentEntityId ?? "";
        if (parentId && map[parentId]) {
          setVoiceId(map[parentId]);
        }
      })
      .catch(() => {
        // fallback: keep KENN_VOICE_ID
      });
    // getAgentVoices identity is stable per React render cycle; safe dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commentId]);

  // Best-effort: extract comment text from the nearest data-comment-id DOM node.
  // This is a V1 heuristic. Replace with a proper prop or usePluginData call
  // once the host exposes comment body via the SDK.
  useEffect(() => {
    const el =
      document.querySelector(`[data-comment-id="${commentId}"]`) ??
      document.querySelector(`[data-entity-id="${commentId}"]`);
    if (el) {
      setCommentText((el.textContent ?? "").trim());
    }
  }, [commentId]);

  // Auto-play once on mount if voice mode is enabled and this comment hasn't
  // been played yet in this browser session.
  useEffect(() => {
    if (!enabled) return;
    const key = sessionPlayedKey(commentId);
    if (sessionStorage.getItem(key) !== null) return;
    if (!commentText) return;

    // Mark played immediately — prevents double-fire on re-renders.
    sessionStorage.setItem(key, "1");

    let cancelled = false;
    speakText(commentText, voiceId)
      .then((blob) => {
        if (!cancelled) return playAudio(blob);
      })
      .catch(() => {
        // ignore auto-play errors silently
      });

    return () => {
      cancelled = true;
    };
    // Only fire when commentText first resolves + enabled state. voiceId
    // updates happen before text resolves in practice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, commentText]);

  const handleClick = useCallback(async () => {
    if (isSpeaking) {
      stopSpeaking();
      return;
    }
    if (!commentText) return;
    try {
      const blob = await speakText(commentText, voiceId);
      await playAudio(blob);
    } catch {
      // silently ignore TTS errors in V1
    }
  }, [isSpeaking, commentText, voiceId, speakText, playAudio, stopSpeaking]);

  const label = isSpeaking ? "Stop speaking" : "Play message";

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => void handleClick()}
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "0.25rem",
        background: "none",
        border: "none",
        cursor: "pointer",
        color: isSpeaking ? "var(--color-accent, #3b82f6)" : "inherit",
        opacity: 0.7,
      }}
    >
      {isSpeaking ? <SquareIcon size={14} /> : <Volume2Icon size={14} />}
    </button>
  );
}
