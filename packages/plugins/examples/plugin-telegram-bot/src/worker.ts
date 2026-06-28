/**
 * Telegram Bot Plugin — Worker
 *
 * Phase 1: Text commands, issue management, agent queries, and outbound notifications.
 * Phase 2: Voice briefings via ElevenLabs TTS.
 */

import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginHealthDiagnostics,
  type PluginWebhookInput,
  type PluginEvent,
  type PluginJobContext,
} from "@paperclipai/plugin-sdk";
import { PLUGIN_ID, WEBHOOK_KEYS, JOB_KEYS } from "./constants.js";
import {
  createTelegramClient,
  parseCommand,
  isChatAllowed,
  escapeHtml,
  type TelegramUpdate,
  type TelegramClient,
} from "./telegram.js";
import { getCommandHandler, handlePlainMessage, type PluginConfig } from "./commands.js";
import { handleConversation, handleVoiceMessage } from "./conversation.js";

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let currentCtx: PluginContext | null = null;
let telegramClient: TelegramClient | null = null;
let botToken: string | null = null;
let cachedConfig: PluginConfig | null = null;

let stats = {
  messagesReceived: 0,
  commandsHandled: 0,
  notificationsSent: 0,
  errors: 0,
  lastMessageAt: "",
  pollCycles: 0,
};

const POLL_OFFSET_STATE_KEY = "telegram-poll-offset";

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

async function getConfig(ctx: PluginContext): Promise<PluginConfig> {
  const raw = await ctx.config.get();
  return {
    botTokenRef: (raw.botTokenRef as string) ?? "",
    allowedChatIds: (raw.allowedChatIds as string) ?? "",
    defaultCompanyId: (raw.defaultCompanyId as string) ?? "",
    defaultProjectId: (raw.defaultProjectId as string) ?? "",
    notificationChatId: (raw.notificationChatId as string) ?? "",
    enableNotifications: raw.enableNotifications !== false,
    elevenLabsKeyRef: (raw.elevenLabsKeyRef as string) ?? "",
    elevenLabsVoiceId: (raw.elevenLabsVoiceId as string) ?? "",
  };
}

async function ensureTelegramClient(ctx: PluginContext, config: PluginConfig): Promise<TelegramClient> {
  if (telegramClient && botToken) return telegramClient;

  if (!config.botTokenRef) {
    throw new Error("botTokenRef not configured. Add your Telegram bot token secret reference in plugin settings.");
  }

  botToken = await ctx.secrets.resolve(config.botTokenRef);
  telegramClient = createTelegramClient(ctx.http, ctx.logger, botToken);
  return telegramClient;
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin = definePlugin({
  async setup(ctx) {
    currentCtx = ctx;
    ctx.logger.info("Telegram Bot plugin starting up");

    cachedConfig = await getConfig(ctx);

    // -----------------------------------------------------------------------
    // Event subscriptions — outbound notifications
    // -----------------------------------------------------------------------

    ctx.events.on("issue.created", async (event: PluginEvent) => {
      await sendNotification(ctx, event, "created");
    });

    ctx.events.on("issue.updated", async (event: PluginEvent) => {
      await sendNotification(ctx, event, "updated");
    });

    // -----------------------------------------------------------------------
    // Polling job — fetches updates from Telegram when no webhook is set
    // -----------------------------------------------------------------------

    ctx.jobs.register(JOB_KEYS.pollUpdates, async (job: PluginJobContext) => {
      ctx.logger.debug("Polling Telegram for updates", { runId: job.runId });

      const config = cachedConfig ?? (await getConfig(ctx));
      let telegram: TelegramClient;
      try {
        telegram = await ensureTelegramClient(ctx, config);
      } catch (err) {
        ctx.logger.error("Poll: failed to init Telegram client", { error: String(err) });
        return;
      }

      // Load last offset from state
      const offsetKey = { scopeKind: "instance" as const, stateKey: POLL_OFFSET_STATE_KEY };
      const storedOffset = await ctx.state.get(offsetKey);
      let offset: number | undefined;
      if (storedOffset != null && typeof storedOffset === "number") {
        offset = storedOffset;
      }

      try {
        const updates = await telegram.getUpdates(offset);

        if (updates.length > 0) {
          ctx.logger.info(`Poll: received ${updates.length} update(s)`, { runId: job.runId });

          for (const update of updates) {
            try {
              await handleTelegramUpdate(ctx, update);
            } catch (err) {
              ctx.logger.error("Poll: error handling update", {
                updateId: update.update_id,
                error: String(err),
              });
            }
          }

          // Store offset = last update_id + 1 so we don't reprocess
          const newOffset = updates[updates.length - 1]!.update_id + 1;
          await ctx.state.set(offsetKey, newOffset);
        }

        stats.pollCycles++;
      } catch (err) {
        ctx.logger.error("Poll: getUpdates failed", { error: String(err) });
        stats.errors++;
      }
    });

    // Delete any stale webhook so Telegram allows getUpdates polling.
    // Fire-and-forget: this performs secret resolution + a network call to
    // api.telegram.org, which must NOT block initialize — the host enforces a
    // 15s initialize timeout and a slow/hung fetch here previously left the
    // plugin stuck in status=error (FRE-1318). getUpdates retries on first poll.
    const startupConfig = cachedConfig;
    void (async () => {
      try {
        const telegram = await ensureTelegramClient(ctx, startupConfig);
        await telegram.deleteWebhook();
      } catch (err) {
        ctx.logger.warn("Could not delete webhook on startup (will retry on first poll)", {
          error: String(err),
        });
      }
    })();

    ctx.logger.info("Telegram Bot plugin ready (polling mode)", {
      hasNotificationChat: Boolean(cachedConfig.notificationChatId),
      notificationsEnabled: cachedConfig.enableNotifications,
    });
  },

  async onHealth(): Promise<PluginHealthDiagnostics> {
    return {
      status: botToken ? "ok" : "degraded",
      message: botToken
        ? `Telegram bot active (polling). ${stats.messagesReceived} messages received, ${stats.commandsHandled} commands handled, ${stats.pollCycles} poll cycles.`
        : "Bot token not yet resolved. Waiting for first poll cycle to initialize.",
      details: {
        ...stats,
        hasBotToken: Boolean(botToken),
        hasNotificationChat: Boolean(cachedConfig?.notificationChatId),
      },
    };
  },

  async onConfigChanged(newConfig) {
    const ctx = currentCtx;
    if (!ctx) return;

    cachedConfig = await getConfig(ctx);

    // Reset client so the next request picks up new token if changed
    telegramClient = null;
    botToken = null;

    ctx.logger.info("Config updated, Telegram client will reinitialize on next request");
  },

  async onValidateConfig(config) {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!config.botTokenRef || typeof config.botTokenRef !== "string") {
      errors.push("botTokenRef is required. Create a secret with your Telegram bot token and reference it here.");
    }

    if (!config.defaultCompanyId || typeof config.defaultCompanyId !== "string") {
      errors.push("defaultCompanyId is required.");
    }

    if (!config.notificationChatId) {
      warnings.push(
        "notificationChatId is not set. Outbound notifications (issue created/updated) will not be sent.",
      );
    }

    return { ok: errors.length === 0, errors, warnings };
  },

  async onWebhook(input: PluginWebhookInput) {
    const ctx = currentCtx;
    if (!ctx) throw new Error("Plugin context not initialized");

    if (input.endpointKey !== WEBHOOK_KEYS.telegramUpdates) {
      throw new Error(`Unknown webhook endpoint: ${input.endpointKey}`);
    }

    const update = input.parsedBody as TelegramUpdate;
    if (!update) {
      ctx.logger.warn("Received empty webhook payload");
      return;
    }

    await handleTelegramUpdate(ctx, update);
  },

  async onShutdown() {
    currentCtx?.logger.info("Telegram Bot plugin shutting down", { stats });
  },
});

// ---------------------------------------------------------------------------
// Telegram update handler
// ---------------------------------------------------------------------------

async function handleTelegramUpdate(ctx: PluginContext, update: TelegramUpdate): Promise<void> {
  const message = update.message ?? update.edited_message;
  if (!message) {
    ctx.logger.debug("Ignoring non-message update", { updateId: update.update_id });
    return;
  }

  stats.messagesReceived++;
  stats.lastMessageAt = new Date().toISOString();

  const config = cachedConfig ?? (await getConfig(ctx));
  const chatId = message.chat.id;

  // Access control
  if (!isChatAllowed(chatId, config.allowedChatIds)) {
    ctx.logger.warn("Unauthorized chat attempted access", {
      chatId,
      username: message.from?.username,
    });
    return;
  }

  let telegram: TelegramClient;
  try {
    telegram = await ensureTelegramClient(ctx, config);
  } catch (err) {
    ctx.logger.error("Failed to initialize Telegram client", { error: String(err) });
    stats.errors++;
    return;
  }

  // Parse and route
  const parsed = parseCommand(message);
  let response: string;

  try {
    if (parsed) {
      const handler = getCommandHandler(parsed.command);
      if (handler) {
        stats.commandsHandled++;
        response = await handler({
          message,
          args: parsed.args,
          config,
          ctx,
          telegram,
        });
      } else {
        response = `Unknown command: ${escapeHtml(parsed.command)}\n\nType /help for available commands.`;
      }
    } else if (message.voice) {
      response = await handleVoiceMessage(message, ctx, config, telegram);
    } else if (message.text) {
      response = await handleConversation(message, message.text, ctx, config, telegram);
    } else {
      response = "I can only process text and voice messages right now. Type /help to get started.";
    }

    // Some commands (e.g. /briefing) send responses directly and return empty
    if (response) {
      await telegram.sendMessage(chatId, response, { parse_mode: "HTML" });
    }
  } catch (err) {
    stats.errors++;
    ctx.logger.error("Error handling Telegram message", {
      chatId,
      error: String(err),
      command: parsed?.command,
    });

    // Try to send an error message to the user
    try {
      await telegram.sendMessage(chatId, "Something went wrong processing your request. Please try again.");
    } catch {
      // If we can't even send the error message, just log it
      ctx.logger.error("Failed to send error message to chat", { chatId });
    }
  }
}

// ---------------------------------------------------------------------------
// Outbound notifications
// ---------------------------------------------------------------------------

async function sendNotification(
  ctx: PluginContext,
  event: PluginEvent,
  action: "created" | "updated",
): Promise<void> {
  const config = cachedConfig ?? (await getConfig(ctx));

  if (!config.enableNotifications || !config.notificationChatId) return;

  let telegram: TelegramClient;
  try {
    telegram = await ensureTelegramClient(ctx, config);
  } catch (err) {
    ctx.logger.error("Cannot send notification — Telegram client not initialized", {
      error: String(err),
    });
    return;
  }

  const payload = event.payload as Record<string, unknown> | undefined;
  const title = (payload?.title as string) ?? "Untitled";
  const status = (payload?.status as string) ?? "";
  const issueId = event.entityId ?? "";

  let text: string;
  if (action === "created") {
    text = [
      `<b>New Issue Created</b>`,
      "",
      `<b>${escapeHtml(title)}</b>`,
      issueId ? `ID: <code>${issueId}</code>` : "",
    ]
      .filter(Boolean)
      .join("\n");
  } else {
    text = [
      `<b>Issue Updated</b>`,
      "",
      `<b>${escapeHtml(title)}</b>`,
      status ? `Status: ${escapeHtml(status)}` : "",
      issueId ? `ID: <code>${issueId}</code>` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  try {
    await telegram.sendMessage(config.notificationChatId, text, { parse_mode: "HTML" });
    stats.notificationsSent++;
  } catch (err) {
    ctx.logger.error("Failed to send Telegram notification", {
      chatId: config.notificationChatId,
      error: String(err),
    });
    stats.errors++;
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

export default plugin;
runWorker(plugin, import.meta.url);
