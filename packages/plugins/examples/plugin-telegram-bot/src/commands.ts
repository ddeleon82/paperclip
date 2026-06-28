/**
 * Telegram command handlers.
 *
 * Each handler receives the parsed command context and the Paperclip plugin
 * context, executes the relevant SDK calls, and returns a response string.
 */

import type { PluginContext, Issue, Agent } from "@paperclipai/plugin-sdk";
import type { TelegramMessage, TelegramClient } from "./telegram.js";
import { escapeHtml } from "./telegram.js";
import { COMMANDS } from "./constants.js";
import {
  createVoiceClient,
  composeBriefingText,
  DEFAULT_VOICE_ID,
  type BriefingData,
  type VoiceClient,
} from "./voice.js";

export interface PluginConfig {
  botTokenRef: string;
  allowedChatIds: string;
  defaultCompanyId: string;
  defaultProjectId: string;
  notificationChatId: string;
  enableNotifications: boolean;
  elevenLabsKeyRef: string;
  elevenLabsVoiceId: string;
}

interface CommandContext {
  message: TelegramMessage;
  args: string;
  config: PluginConfig;
  ctx: PluginContext;
  telegram: TelegramClient;
}

type CommandHandler = (cmdCtx: CommandContext) => Promise<string>;

const handlers: Record<string, CommandHandler> = {
  [COMMANDS.start]: handleStart,
  [COMMANDS.help]: handleHelp,
  [COMMANDS.issues]: handleIssues,
  [COMMANDS.create]: handleCreate,
  [COMMANDS.status]: handleStatus,
  [COMMANDS.ask]: handleAsk,
  [COMMANDS.briefing]: handleBriefing,
};

export function getCommandHandler(command: string): CommandHandler | undefined {
  return handlers[command];
}

// ---------------------------------------------------------------------------
// /start
// ---------------------------------------------------------------------------

async function handleStart({ message, ctx, config }: CommandContext): Promise<string> {
  const chatId = message.chat.id;
  const userName = message.from?.first_name ?? "there";

  // Store the chat registration in plugin state
  await ctx.state.set(
    { scopeKind: "instance", stateKey: `chat-registered-${chatId}` },
    {
      chatId,
      userId: message.from?.id,
      username: message.from?.username,
      firstName: message.from?.first_name,
      registeredAt: new Date().toISOString(),
    },
  );

  ctx.logger.info("New chat registered", { chatId, username: message.from?.username });

  return [
    `Hey ${escapeHtml(userName)}. I'm the Freedom & Coffee Telegram bot, connected to Paperclip.`,
    "",
    "Here's what I can do:",
    "",
    "/issues — List recent issues",
    "/create &lt;title&gt; — Create a new issue",
    "/status — System status overview",
    "/ask &lt;question&gt; — Query an agent",
    "/briefing — Voice briefing of current status",
    "/help — Show this message again",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// /help
// ---------------------------------------------------------------------------

async function handleHelp(): Promise<string> {
  return [
    "<b>Available Commands</b>",
    "",
    "/issues — List recent issues (last 10)",
    "/create &lt;title&gt; — Create a new issue",
    "/status — System status overview",
    "/ask &lt;question&gt; — Query an agent",
    "/briefing — Voice briefing of current status",
    "/help — Show this message",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// /issues
// ---------------------------------------------------------------------------

async function handleIssues({ ctx, config }: CommandContext): Promise<string> {
  const companyId = config.defaultCompanyId;
  if (!companyId) return "No default company configured. Set defaultCompanyId in plugin settings.";

  const issues = await ctx.issues.list({
    companyId,
    limit: 10,
    offset: 0,
  });

  if (issues.length === 0) return "No issues found.";

  const lines = issues.map((issue: Issue, i: number) => {
    const status = statusEmoji(issue.status);
    const priority = priorityLabel(issue.priority);
    return `${i + 1}. ${status} <b>${escapeHtml(issue.title)}</b> [${priority}] — ${issue.status}`;
  });

  return [`<b>Recent Issues</b> (${issues.length})`, "", ...lines].join("\n");
}

// ---------------------------------------------------------------------------
// /create <title>
// ---------------------------------------------------------------------------

async function handleCreate({ args, ctx, config }: CommandContext): Promise<string> {
  if (!args.trim()) {
    return "Usage: /create &lt;issue title&gt;\n\nExample: /create Fix login page timeout";
  }

  const companyId = config.defaultCompanyId;
  if (!companyId) return "No default company configured. Set defaultCompanyId in plugin settings.";

  const projectId = config.defaultProjectId || undefined;

  const issue = await ctx.issues.create({
    companyId,
    projectId,
    title: args.trim(),
  });

  await ctx.activity.log({
    companyId,
    entityType: "issue",
    entityId: issue.id,
    message: `Issue created via Telegram bot: "${issue.title}"`,
    metadata: { source: "telegram" },
  });

  ctx.logger.info("Issue created via Telegram", { issueId: issue.id, title: issue.title });

  return [
    `Issue created.`,
    "",
    `<b>${escapeHtml(issue.title)}</b>`,
    `ID: <code>${issue.id}</code>`,
    `Status: ${issue.status}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// /status
// ---------------------------------------------------------------------------

async function handleStatus({ ctx, config }: CommandContext): Promise<string> {
  const companyId = config.defaultCompanyId;
  if (!companyId) return "No default company configured.";

  const [projects, issues, agents] = await Promise.all([
    ctx.projects.list({ companyId, limit: 100, offset: 0 }),
    ctx.issues.list({ companyId, limit: 100, offset: 0 }),
    ctx.agents.list({ companyId, limit: 100, offset: 0 }),
  ]);

  const todoCount = issues.filter((i: Issue) => i.status === "todo").length;
  const inProgressCount = issues.filter((i: Issue) => i.status === "in_progress").length;
  const doneCount = issues.filter((i: Issue) => i.status === "done").length;

  return [
    "<b>System Status</b>",
    "",
    `Projects: ${projects.length}`,
    `Agents: ${agents.length}`,
    "",
    "<b>Issues</b>",
    `  Todo: ${todoCount}`,
    `  In Progress: ${inProgressCount}`,
    `  Done: ${doneCount}`,
    `  Total: ${issues.length}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// /ask <question>
// ---------------------------------------------------------------------------

async function handleAsk({ args, ctx, config, telegram, message }: CommandContext): Promise<string> {
  if (!args.trim()) {
    return "Usage: /ask &lt;your question&gt;\n\nExample: /ask What's the status of FRE-28?";
  }

  const companyId = config.defaultCompanyId;
  if (!companyId) return "No default company configured.";

  // Find an available agent to invoke
  const agents = await ctx.agents.list({ companyId, limit: 50, offset: 0 });
  if (agents.length === 0) return "No agents available to answer your question.";

  // Use the first available agent (in a future version, route by keyword)
  const agent = agents[0]!;

  // Show typing indicator
  await telegram.sendChatAction(message.chat.id, "typing");

  try {
    const result = await ctx.agents.invoke(agent.id, companyId, {
      prompt: args.trim(),
      reason: "Telegram bot /ask command",
    });

    return [
      `Agent <b>${escapeHtml(agent.name)}</b> invoked.`,
      "",
      `Run ID: <code>${result.runId}</code>`,
      "",
      "The agent is processing your question. You'll receive a notification when it completes.",
    ].join("\n");
  } catch (err) {
    ctx.logger.error("Agent invocation failed", { error: String(err) });
    return "Failed to invoke agent. It may be busy or paused.";
  }
}

// ---------------------------------------------------------------------------
// /briefing — Voice briefing
// ---------------------------------------------------------------------------

/** Cached voice client per ElevenLabs key. Reused across requests. */
let voiceClient: VoiceClient | null = null;
let voiceClientKeyRef = "";

async function ensureVoiceClient(ctx: PluginContext, config: PluginConfig): Promise<VoiceClient> {
  if (voiceClient && voiceClientKeyRef === config.elevenLabsKeyRef) return voiceClient;

  if (!config.elevenLabsKeyRef) {
    throw new Error("elevenLabsKeyRef not configured. Add your ElevenLabs API key secret reference in plugin settings.");
  }

  const apiKey = await ctx.secrets.resolve(config.elevenLabsKeyRef);
  const voiceId = config.elevenLabsVoiceId || DEFAULT_VOICE_ID;
  voiceClient = createVoiceClient(ctx.logger, apiKey, voiceId);
  voiceClientKeyRef = config.elevenLabsKeyRef;
  return voiceClient;
}

async function handleBriefing({ message, ctx, config, telegram }: CommandContext): Promise<string> {
  const companyId = config.defaultCompanyId;
  if (!companyId) return "No default company configured. Set defaultCompanyId in plugin settings.";

  // Show typing / upload indicator
  await telegram.sendChatAction(message.chat.id, "record_voice");

  // Gather briefing data in parallel
  const [projects, issues, agents] = await Promise.all([
    ctx.projects.list({ companyId, limit: 100, offset: 0 }),
    ctx.issues.list({ companyId, limit: 100, offset: 0 }),
    ctx.agents.list({ companyId, limit: 100, offset: 0 }),
  ]);

  const todoCount = issues.filter((i: Issue) => i.status === "todo").length;
  const inProgressCount = issues.filter((i: Issue) => i.status === "in_progress").length;
  const doneCount = issues.filter((i: Issue) => i.status === "done").length;
  const urgentCount = issues.filter((i: Issue) => i.priority === "critical").length;

  // Top priority items: critical and high priority in-progress or todo
  const topItems = issues
    .filter((i: Issue) => i.status !== "done" && i.status !== "cancelled")
    .sort((a: Issue, b: Issue) => {
      const prio = (v: string) => {
        switch (v) {
          case "critical": return 4;
          case "high": return 3;
          case "medium": return 2;
          case "low": return 1;
          default: return 0;
        }
      };
      return prio(b.priority) - prio(a.priority);
    })
    .slice(0, 3)
    .map((i: Issue) => ({
      title: i.title,
      status: i.status,
      priority: priorityLabel(i.priority),
    }));

  const briefingData: BriefingData = {
    issues: {
      total: issues.length,
      todo: todoCount,
      inProgress: inProgressCount,
      done: doneCount,
      urgent: urgentCount,
      topItems,
    },
    agents: {
      total: agents.length,
      active: agents.filter((a: Agent) => a.status === "active" || a.status === "running").length,
    },
    projects: projects.length,
  };

  const briefingText = composeBriefingText(briefingData);

  // Try to generate and send voice
  let voice: VoiceClient;
  try {
    voice = await ensureVoiceClient(ctx, config);
  } catch {
    // ElevenLabs not configured — fall back to text-only briefing
    ctx.logger.warn("Voice client not available, sending text-only briefing");
    return `<b>Briefing</b> (text-only — voice not configured)\n\n${escapeHtml(briefingText)}`;
  }

  await telegram.sendChatAction(message.chat.id, "upload_voice");

  try {
    const audioBytes = await voice.synthesize(briefingText);
    await telegram.sendVoice(message.chat.id, audioBytes, {
      caption: "Daily briefing",
      parse_mode: "HTML",
    });

    // Return empty — voice was sent directly; no text follow-up needed
    // unless we want a transcript too
    return "";
  } catch (err) {
    ctx.logger.error("Voice briefing generation failed, falling back to text", {
      error: String(err),
    });
    return `<b>Briefing</b> (voice generation failed)\n\n${escapeHtml(briefingText)}`;
  }
}

// ---------------------------------------------------------------------------
// Fallback for unrecognized text (not a command)
// ---------------------------------------------------------------------------

export async function handlePlainMessage(
  message: TelegramMessage,
  ctx: PluginContext,
  config: PluginConfig,
): Promise<string> {
  const text = message.text ?? "";

  // If it looks like an issue title (short, no special chars), offer to create it
  if (text.length > 3 && text.length < 200 && !text.startsWith("/")) {
    return [
      "I got your message. Did you want to create an issue from it?",
      "",
      `Use: /create ${escapeHtml(text)}`,
    ].join("\n");
  }

  return "I didn't understand that. Type /help to see available commands.";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusEmoji(status: string): string {
  switch (status) {
    case "todo":
      return "[ ]";
    case "in_progress":
      return "[~]";
    case "done":
      return "[x]";
    case "cancelled":
      return "[-]";
    default:
      return "[?]";
  }
}

function priorityLabel(priority: string | undefined): string {
  switch (priority) {
    case "critical":
      return "CRIT";
    case "high":
      return "HIGH";
    case "medium":
      return "MED";
    case "low":
      return "LOW";
    default:
      return "---";
  }
}
