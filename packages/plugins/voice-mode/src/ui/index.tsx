/**
 * Voice Mode plugin UI entry.
 *
 * Exports slot components referenced in src/manifest.ts ui.slots[].exportName.
 * The Paperclip plugin host loads this module and mounts the named exports into
 * the declared slot positions.
 *
 * Slot registry (see manifest.ts for details + known deviations from plan):
 *
 *   DashboardWidget            — dashboardWidget "health-widget"
 *   VoiceComposerControlsSlot  — toolbarButton on issue (interim; Task 11 adds
 *                                real chat-composer-trailing slot to core)
 *   MessageSpeakerButton       — commentAnnotation on comment (interim; Task 12
 *                                implements full TTS play/stop)
 */
import React from "react";
import {
  usePluginAction,
  usePluginData,
  type PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";
import { VoiceComposerControls } from "./VoiceComposerControls";
import { useVoiceMode } from "./useVoiceMode";
export { MessageSpeakerButton } from "./MessageSpeakerButton";
export { VoiceSettingsPanel } from "./VoiceSettingsPanel.js";

// PluginToolbarButtonProps is not yet in the SDK — use PluginWidgetProps as
// a structural stand-in (same shape: { context: PluginHostContext }).
// Replace once the SDK adds a typed toolbarButton prop interface.
type PluginToolbarButtonProps = PluginWidgetProps;

// ---------------------------------------------------------------------------
// DashboardWidget — health status (pre-existing scaffold)
// ---------------------------------------------------------------------------

type HealthData = {
  status: "ok" | "degraded" | "error";
  checkedAt: string;
};

export function DashboardWidget(_props: PluginWidgetProps) {
  const { data, loading, error } = usePluginData<HealthData>("health");
  const ping = usePluginAction("ping");

  if (loading) return <div>Loading plugin health...</div>;
  if (error) return <div>Plugin error: {error.message}</div>;

  return (
    <div style={{ display: "grid", gap: "0.5rem" }}>
      <strong>Voice Mode</strong>
      <div>Health: {data?.status ?? "unknown"}</div>
      <div>Checked: {data?.checkedAt ?? "never"}</div>
      <button onClick={() => void ping()}>Ping Worker</button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// VoiceComposerControlsSlot — mic + voice-mode toggle
//
// Slot type: toolbarButton (issue) — interim until Task 11 adds
// chat-composer-trailing to core. The `onTranscript` callback auto-submits
// the transcribed text as a comment. In the toolbarButton context the host
// does not provide a submit callback via props; the component dispatches a
// CustomEvent("voice-mode:auto-send", { detail: text }) that the core
// IssueChatThread must listen to (Task 11 wiring).
// ---------------------------------------------------------------------------

export function VoiceComposerControlsSlot(_props: PluginToolbarButtonProps) {
  const { enabled } = useVoiceMode();

  function handleTranscript(text: string) {
    // Always echo into the composer first so the user sees what was heard.
    window.dispatchEvent(new CustomEvent("voice-mode:transcript-insert", { detail: text }));
    if (enabled) {
      // After a brief delay, fire auto-send so the user sees the words land
      // in the composer before submission. 300ms gives a glance without
      // feeling laggy. The auto-send detail carries `origin: "voice"` so the
      // host can forward it as the `x-paperclip-origin` request header, which
      // the server uses to tag the resulting heartbeat wakeup with
      // `invocation_source = "voice"` (Task 18, FRE-968). Both host listeners
      // (CommentThread.tsx and IssueChatThread.tsx) tolerate the legacy bare
      // string payload as well.
      window.setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent("voice-mode:auto-send", {
            detail: { text, origin: "voice" as const },
          }),
        );
      }, 300);
    }
  }

  return <VoiceComposerControls onTranscript={handleTranscript} />;
}
