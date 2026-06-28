import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { PLUGIN_ID, WEBHOOK_KEYS, JOB_KEYS, DEFAULT_CONFIG } from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.4.0",
  displayName: "Telegram Bot",
  description:
    "Telegram bot for managing issues, querying agents, receiving notifications, and delivering voice briefings via Telegram chat.",
  author: "Freedom & Coffee",
  categories: ["connector"],

  capabilities: [
    // Inbound
    "webhooks.receive",

    // Outbound HTTP (Telegram Bot API calls)
    "http.outbound",

    // Secrets (bot token)
    "secrets.read-ref",

    // Issues
    "issues.read",
    "issues.create",
    "issues.update",
    "issue.comments.read",
    "issue.comments.create",

    // Agents
    "agents.read",
    "agents.invoke",
    "agent.sessions.create",
    "agent.sessions.list",
    "agent.sessions.send",
    "agent.sessions.close",

    // Events (notifications)
    "events.subscribe",

    // Scheduled jobs (polling)
    "jobs.schedule",

    // State (chat mapping, user prefs)
    "plugin.state.read",
    "plugin.state.write",

    // Context
    "companies.read",
    "projects.read",

    // Logging
    "activity.log.write",
  ],

  entrypoints: {
    worker: "./dist/worker.js",
  },

  instanceConfigSchema: {
    type: "object",
    properties: {
      botTokenRef: {
        type: "string",
        description: "Secret reference for the Telegram Bot API token (from BotFather)",
      },
      allowedChatIds: {
        type: "string",
        description:
          "Comma-separated Telegram chat IDs allowed to interact with the bot. Leave empty to allow all.",
      },
      defaultCompanyId: {
        type: "string",
        description: "Default company ID for issue creation and queries",
      },
      defaultProjectId: {
        type: "string",
        description: "Default project ID for issue creation (optional)",
      },
      notificationChatId: {
        type: "string",
        description: "Telegram chat ID where issue notifications are sent",
      },
      enableNotifications: {
        type: "boolean",
        description: "Enable outbound notifications for issue events",
      },
      elevenLabsKeyRef: {
        type: "string",
        description:
          "Secret reference for the ElevenLabs API key (required for /briefing voice messages)",
      },
      elevenLabsVoiceId: {
        type: "string",
        description:
          "ElevenLabs voice ID for TTS. Defaults to Kenn Akomea (VjSFSNiy9sK85Z9QRu3d) if not set.",
      },
    },
    required: ["botTokenRef", "defaultCompanyId"],
  },

  webhooks: [
    {
      endpointKey: WEBHOOK_KEYS.telegramUpdates,
      displayName: "Telegram Updates",
      description:
        "Receives webhook updates from the Telegram Bot API. Configure this URL as your bot's webhook in BotFather.",
    },
  ],

  jobs: [
    {
      jobKey: JOB_KEYS.pollUpdates,
      displayName: "Poll Telegram Updates",
      description:
        "Polls the Telegram Bot API for new messages when no webhook URL is available. Runs every minute.",
      schedule: "*/1 * * * *",
    },
  ],
};

export default manifest;
