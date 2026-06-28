export const PLUGIN_ID = "freedomandcoffee.telegram-bot";

export const WEBHOOK_KEYS = {
  telegramUpdates: "telegram-updates",
} as const;

export const JOB_KEYS = {
  pollUpdates: "poll-telegram-updates",
} as const;

export const COMMANDS = {
  start: "/start",
  help: "/help",
  issues: "/issues",
  create: "/create",
  status: "/status",
  ask: "/ask",
  briefing: "/briefing",
} as const;

export const DEFAULT_CONFIG = {
  botTokenRef: "",
  allowedChatIds: "",
  defaultCompanyId: "",
  defaultProjectId: "",
  notificationChatId: "",
  enableNotifications: true,
  elevenLabsKeyRef: "",
  elevenLabsVoiceId: "",
} as const;

export const TELEGRAM_API_BASE = "https://api.telegram.org";
