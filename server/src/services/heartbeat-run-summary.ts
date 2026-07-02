import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

function truncateSummaryText(value: unknown, maxLength = 500) {
  if (typeof value !== "string") return null;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function readNumericField(record: Record<string, unknown>, key: string) {
  return key in record ? record[key] ?? null : undefined;
}

function readCommentText(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function summarizeHeartbeatRunResultJson(
  resultJson: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) {
    return null;
  }

  const summary: Record<string, unknown> = {};
  const textFields = ["summary", "result", "message", "error"] as const;
  for (const key of textFields) {
    const value = truncateSummaryText(resultJson[key]);
    if (value !== null) {
      summary[key] = value;
    }
  }

  const numericFieldAliases = ["total_cost_usd", "cost_usd", "costUsd"] as const;
  for (const key of numericFieldAliases) {
    const value = readNumericField(resultJson, key);
    if (value !== undefined && value !== null) {
      summary[key] = value;
    }
  }

  return Object.keys(summary).length > 0 ? summary : null;
}

export function buildHeartbeatRunIssueComment(
  resultJson: Record<string, unknown> | null | undefined,
): string | null {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) {
    return null;
  }

  return (
    readCommentText(resultJson.summary)
    ?? readCommentText(resultJson.result)
    ?? readCommentText(resultJson.message)
    ?? null
  );
}

function formatRunDuration(durationMs: number | null | undefined): string | null {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) {
    return null;
  }
  const totalSeconds = Math.round(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}

/**
 * Issue comment for heartbeat runs that ended without a summary (FRE-1365).
 *
 * Success runs post the agent-authored summary via buildHeartbeatRunIssueComment.
 * timed_out/failed runs previously emitted zero external signal; this builds the
 * failure notice posted in their place. Returns null for every other outcome so
 * cancelled (supersession) and succeeded runs never produce failure spam.
 */
export function buildHeartbeatRunFailureComment(input: {
  outcome: string;
  durationMs?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  checkpointNextStep?: string | null;
  recoveryWakeQueued: boolean;
}): string | null {
  if (input.outcome !== "timed_out" && input.outcome !== "failed") {
    return null;
  }

  const verb = input.outcome === "timed_out" ? "timed out" : "failed";
  const duration = formatRunDuration(input.durationMs);
  const lines: string[] = [];

  let headline = `**Heartbeat run ${verb}**`;
  if (duration) headline += ` after ${duration}`;
  if (readCommentText(input.errorCode)) headline += ` (\`${input.errorCode!.trim()}\`)`;
  headline += ".";
  lines.push(headline);

  const errorMessage = readCommentText(input.errorMessage);
  if (errorMessage) {
    lines.push("", `Error: ${truncateSummaryText(errorMessage, 1000)}`);
  }

  const nextStep = readCommentText(input.checkpointNextStep);
  if (nextStep) {
    lines.push("", `Last checkpoint next_step: \`${nextStep}\` — resume from there.`);
  }

  lines.push(
    "",
    input.recoveryWakeQueued
      ? "_Automated failure notice: the run ended before it could post a summary. A recovery wake has been queued for the assignee._"
      : "_Automated failure notice: the run ended before it could post a summary. No recovery wake queued (previous recovery attempt also ended abnormally) — manual attention needed._",
  );

  return lines.join("\n");
}

const CHECKPOINT_IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]+$/;

function defaultCheckpointRoot(): string {
  return (
    process.env.PAPERCLIP_AGENT_CHECKPOINT_ROOT
    ?? join(homedir(), "freedom-and-coffee", "state", "sessions")
  );
}

/**
 * Best-effort read of the agent-side FRE-1268 checkpoint next_step for an issue.
 *
 * Checkpoints live on the agent host at <root>/<issue-identifier>/checkpoint.json
 * (root overridable via PAPERCLIP_AGENT_CHECKPOINT_ROOT). Any failure — missing
 * file, malformed JSON, bad identifier — resolves to null; this must never make
 * run finalization throw.
 */
export async function readAgentCheckpointNextStep(
  issueIdentifier: string | null | undefined,
  rootDir?: string,
): Promise<string | null> {
  const identifier = readCommentText(issueIdentifier);
  if (!identifier || !CHECKPOINT_IDENTIFIER_PATTERN.test(identifier)) {
    return null;
  }

  try {
    const raw = await readFile(
      join(rootDir ?? defaultCheckpointRoot(), identifier, "checkpoint.json"),
      "utf8",
    );
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return readCommentText((parsed as Record<string, unknown>).next_step);
  } catch {
    return null;
  }
}
