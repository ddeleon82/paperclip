/**
 * useVoiceComposerAutoPlay — FRE-968 Task 19.
 *
 * Mounted by IssueChatThread for the currently visible issue. When the
 * LiveUpdatesProvider receives a `heartbeat.run.status` event with
 * `invocationSource === "voice"` and `status === "succeeded"`, it dispatches a
 * `voice-mode:run-succeeded` CustomEvent (see LiveUpdatesProvider.tsx). This
 * hook listens for that event, ignores succeeded runs for issues other than
 * the one currently mounted, then fetches the latest agent reply comment and
 * speaks it via the voice-mode plugin's `voice.speak` action.
 *
 * Why mount it inside IssueChatThread: scopes auto-play to the page the user
 * is looking at. If the user navigates away between voice-sending and the run
 * completing, no audio plays.
 *
 * This is the composer counterpart to the /voice tab's own auto-play, which
 * lives inside VoiceMode.tsx. The two paths share the same plugin action +
 * useStreamingTts hook so playback behavior stays consistent.
 */
import { useEffect, useRef } from "react";

import { issuesApi } from "@/api/issues";
import { pluginsApi } from "@/api/plugins";
import { useStreamingTts } from "@/hooks/useStreamingTts";

const VOICE_MODE_PLUGIN_ID = "voice-mode";
const KENN_VOICE_ID = "VjSFSNiy9sK85Z9QRu3d";

interface VoiceRunSucceededDetail {
  runId: string;
  issueId: string;
  agentId: string;
}

function isVoiceRunDetail(value: unknown): value is VoiceRunSucceededDetail {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.runId === "string" &&
    typeof v.issueId === "string" &&
    typeof v.agentId === "string"
  );
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export interface UseVoiceComposerAutoPlayOptions {
  /** Issue currently visible. Only matching events trigger TTS. */
  issueId: string | null;
  /** Company id required by the plugin bridge action call. */
  companyId: string | null;
  /** Voice id override. Defaults to Kenn Akomea. */
  voiceId?: string;
}

export function useVoiceComposerAutoPlay({
  issueId,
  companyId,
  voiceId = KENN_VOICE_ID,
}: UseVoiceComposerAutoPlayOptions) {
  const tts = useStreamingTts();
  // Keep a ref to tts so the listener effect can stay stable even if the
  // hook's identity changes between renders. Same pattern as VoiceMode.tsx.
  const ttsRef = useRef(tts);
  useEffect(() => {
    ttsRef.current = tts;
  }, [tts]);

  useEffect(() => {
    if (!issueId || !companyId) return;

    let cancelled = false;

    const handler = async (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (!isVoiceRunDetail(detail)) return;
      if (detail.issueId !== issueId) return;

      try {
        // Pull the most recent comment authored by the run's agent. Order
        // desc + limit 1 keeps the response small. The server-side wakeup
        // for voice-tagged comments only completes after the agent has
        // posted its reply, so by the time `status === "succeeded"` fires
        // the comment is already persisted.
        const comments = await issuesApi.listComments(issueId, {
          order: "desc",
          limit: 5,
        });
        if (cancelled) return;

        const reply = comments.find(
          (c) => c.authorAgentId === detail.agentId && typeof c.body === "string" && c.body.trim().length > 0,
        );
        if (!reply) return;

        const speakRes = (await pluginsApi.bridgePerformAction(
          VOICE_MODE_PLUGIN_ID,
          "voice.speak",
          { text: reply.body, voiceId },
          companyId,
        )) as { data: { audioBase64: string; mime: string } };
        if (cancelled) return;

        const audioBase64 = speakRes.data?.audioBase64;
        if (!audioBase64) return;

        await ttsRef.current.play(base64ToBytes(audioBase64));
      } catch (err) {
        // Auto-play is best-effort. A failure here must never break the
        // composer page, so swallow + log.
        // eslint-disable-next-line no-console
        console.error("[voice-mode] auto-play failed:", err);
      }
    };

    window.addEventListener("voice-mode:run-succeeded", handler);
    return () => {
      cancelled = true;
      window.removeEventListener("voice-mode:run-succeeded", handler);
      ttsRef.current.stop();
    };
  }, [issueId, companyId, voiceId]);
}
