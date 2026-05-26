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
    "ui.dashboardWidget.register",
    "instance.settings.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui"
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      elevenlabsKeyRef: {
        type: "string",
        format: "secret-ref",
        title: "ElevenLabs API Key",
        description: "Bind a company secret (e.g. ELEVENLABS_API_KEY) that holds the ElevenLabs API key. The plugin reads this UUID and resolves the secret value at runtime."
      }
    },
    required: ["elevenlabsKeyRef"]
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
        // Composer mic/toggle controls — renders inline next to the Send/Create
        // button in IssueChatComposer (issue thread reply) and NewIssueDialog
        // (new issue creation). composerTrailing is entity-agnostic so the
        // same component mounts in both surfaces.
        type: "composerTrailing",
        id: "voice-composer-controls",
        displayName: "Voice Composer Controls",
        exportName: "VoiceComposerControlsSlot"
      },
      {
        // Plugin settings page — per-agent voice picker.
        // settingsPage is a valid slot type in PLUGIN_UI_SLOT_TYPES.
        type: "settingsPage",
        id: "voice-settings",
        displayName: "Voice Mode",
        exportName: "VoiceSettingsPanel"
      }
    ]
  }
};

export default manifest;
