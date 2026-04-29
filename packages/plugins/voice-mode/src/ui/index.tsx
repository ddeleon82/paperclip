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
  type PluginToolbarButtonProps,
} from "@paperclipai/plugin-sdk/ui";
import { VoiceComposerControls } from "./VoiceComposerControls";
export { MessageSpeakerButton } from "./MessageSpeakerButton";

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
  function handleTranscript(text: string) {
    // Dispatch event for core to pick up and submit as a comment.
    // When Task 11 adds the real chat-composer-trailing slot, this slot will
    // receive an `onAutoSend` prop directly and this event dispatch will be
    // replaced by a direct prop call.
    window.dispatchEvent(
      new CustomEvent("voice-mode:auto-send", { detail: text }),
    );
  }

  return <VoiceComposerControls onTranscript={handleTranscript} />;
}
