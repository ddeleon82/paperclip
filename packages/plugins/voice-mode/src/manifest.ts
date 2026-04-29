import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "voice-mode",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Voice Mode",
  description: "Voice input (STT) and output (TTS) for Paperclip issue chat",
  author: "Plugin Author",
  categories: ["connector"],
  capabilities: [
    "events.subscribe",
    "plugin.state.read",
    "plugin.state.write",
    "http.outbound",
    "secrets.read-ref",
    "ui.action.register",
    "ui.commentAnnotation.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui"
  },
  ui: {
    slots: [
      {
        // Dashboard health widget (existing)
        type: "dashboardWidget",
        id: "health-widget",
        displayName: "Voice Mode Health",
        exportName: "DashboardWidget"
      },
      {
        // Composer mic/toggle controls.
        //
        // NOTE: `chat-composer-trailing` does NOT exist in core slot types.
        // The closest available slot is `toolbarButton` on the `issue` entity,
        // which renders in the issue toolbar. Task 11 will need to add a real
        // `chat-composer-trailing` slot to core IssueChatThread.tsx and add it
        // to the slot type registry — at that point change this to:
        //   type: "chat-composer-trailing"
        //   entityTypes: ["issue"]
        //
        // Using toolbarButton on issue as the interim mount point so the slot
        // is declared and the component is wired. The UX will land in the
        // toolbar rather than the composer until Task 11 adds core slot support.
        type: "toolbarButton",
        id: "voice-composer-controls",
        displayName: "Voice Composer Controls",
        exportName: "VoiceComposerControlsSlot",
        entityTypes: ["issue"]
      },
      {
        // Per-comment TTS play button.
        //
        // NOTE: `chat-message-actions` does NOT exist in core slot types.
        // Using `commentAnnotation` (renders below each comment in the timeline)
        // as the interim mount point. Task 11/12 should evaluate whether a
        // dedicated `chat-message-actions` slot is needed or `commentAnnotation`
        // is sufficient for the TTS button UX.
        type: "commentAnnotation",
        id: "voice-message-speaker",
        displayName: "Voice Message Speaker",
        exportName: "MessageSpeakerButton",
        entityTypes: ["comment"]
      }
    ]
  }
};

export default manifest;
