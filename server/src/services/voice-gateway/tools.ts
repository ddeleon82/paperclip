/**
 * Tool router for the voice gateway (FRE-1296).
 *
 * Routes function calls from Gemini Live to their implementations:
 * - dispatch_to_conrad: wakes Conrad with the user's request
 * - check_run: polls a running Conrad heartbeat
 * - board_snapshot: cheap read-only board summary
 */

import { VOICE_SYSTEM_PROMPT } from "../voice-prompt.js";

const DEFAULT_VOICE_WAKEUP_MODEL = "claude-sonnet-4-6";

// ---------------------------------------------------------------------------
// Dependency interfaces (injected; never imported directly so tests stay hermetic)
// ---------------------------------------------------------------------------

export interface ToolDeps {
  wakeup(agentId: string, opts: Record<string, unknown>): Promise<{ id: string } | null>;
  getRunStatus(runId: string): Promise<{ status: string } | null>;
  boardSnapshot(companyId: string): Promise<{
    counts: Record<string, number>;
    recent: Array<{ identifier: string; title: string; status: string }>;
  }>;
  createIssue(
    companyId: string,
    input: { title: string; body: string },
  ): Promise<{ id: string; identifier: string } | null>;
}

export interface ToolCallResult {
  response: Record<string, unknown>;
  dispatchedRunId?: string;
  createdTask?: { identifier: string; title: string };
}

// ---------------------------------------------------------------------------
// Tool router
// ---------------------------------------------------------------------------

export async function routeToolCall(
  deps: ToolDeps,
  ctx: { companyId: string; agentId: string; sessionId: string; userId: string },
  call: { name: string; args: Record<string, unknown> },
): Promise<ToolCallResult> {
  switch (call.name) {
    case "dispatch_to_conrad": {
      const prompt = typeof call.args.prompt === "string" ? call.args.prompt.trim() : "";
      if (!prompt) {
        return { response: { error: "empty prompt" } };
      }

      const modelOverride = process.env.VOICE_WAKEUP_MODEL?.trim() || DEFAULT_VOICE_WAKEUP_MODEL;

      const run = await deps.wakeup(ctx.agentId, {
        source: "voice_session",
        triggerDetail: "system",
        reason: "voice_turn",
        payload: { transcript: prompt, voiceSessionId: ctx.sessionId },
        requestedByActorType: "user",
        requestedByActorId: ctx.userId,
        contextSnapshot: {
          voiceSessionId: ctx.sessionId,
          voiceSystemPromptOverride: VOICE_SYSTEM_PROMPT,
          modelOverride,
          voiceTurn: { transcript: prompt, instructions: VOICE_SYSTEM_PROMPT },
        },
      });

      if (!run) {
        return { response: { error: "dispatch failed" } };
      }

      return {
        response: { runId: run.id, status: "dispatched" },
        dispatchedRunId: run.id,
      };
    }

    case "check_run": {
      const runId = typeof call.args.runId === "string" ? call.args.runId : "";
      const result = await deps.getRunStatus(runId);
      if (!result) {
        return { response: { error: "unknown run" } };
      }
      return { response: { status: result.status } };
    }

    case "board_snapshot": {
      const snapshot = await deps.boardSnapshot(ctx.companyId);
      return { response: snapshot };
    }

    case "create_task": {
      const title = typeof call.args.title === "string" ? call.args.title.trim() : "";
      if (!title) {
        return { response: { error: "empty title" } };
      }

      const detail = typeof call.args.detail === "string" ? call.args.detail.trim() : "";

      const created = await deps.createIssue(ctx.companyId, { title, body: detail });
      if (!created) {
        return { response: { error: "task creation failed" } };
      }

      const { identifier } = created;
      const dispatchPrompt = detail
        ? `Work board task ${identifier}: ${title}. ${detail}`
        : `Work board task ${identifier}: ${title}.`;

      const modelOverride = process.env.VOICE_WAKEUP_MODEL?.trim() || DEFAULT_VOICE_WAKEUP_MODEL;

      const run = await deps.wakeup(ctx.agentId, {
        source: "voice_session",
        triggerDetail: "system",
        reason: "voice_turn",
        payload: { transcript: dispatchPrompt, voiceSessionId: ctx.sessionId },
        requestedByActorType: "user",
        requestedByActorId: ctx.userId,
        contextSnapshot: {
          voiceSessionId: ctx.sessionId,
          voiceSystemPromptOverride: VOICE_SYSTEM_PROMPT,
          modelOverride,
          voiceTurn: { transcript: dispatchPrompt, instructions: VOICE_SYSTEM_PROMPT },
        },
      });

      if (!run) {
        return {
          response: { identifier, error: "dispatch failed" },
          createdTask: { identifier, title },
        };
      }

      return {
        response: { identifier, runId: run.id, status: "dispatched" },
        dispatchedRunId: run.id,
        createdTask: { identifier, title },
      };
    }

    default:
      return { response: { error: "unknown tool" } };
  }
}

// ---------------------------------------------------------------------------
// Real dep factories (used in wiring; NOT unit-tested here)
// ---------------------------------------------------------------------------

/**
 * Creates real ToolDeps backed by the heartbeat service and drizzle DB.
 * Tested indirectly via Task 10 integration and Task 12 E2E.
 */
export function makeToolDeps(
  db: import("@paperclipai/db").Db,
  heartbeat: {
    wakeup(agentId: string, opts: Record<string, unknown>): Promise<{ id: string } | null>;
    getRun(runId: string): Promise<{ status: string } | null>;
  },
): ToolDeps {
  return {
    wakeup: (agentId, opts) => heartbeat.wakeup(agentId, opts),
    getRunStatus: (runId) => heartbeat.getRun(runId),
    boardSnapshot: async (companyId) => {
      const { issues } = await import("@paperclipai/db");
      const { eq, desc } = await import("drizzle-orm");

      // Count by status
      const rows = await db
        .select({
          status: issues.status,
        })
        .from(issues)
        .where(eq(issues.companyId, companyId));

      const counts: Record<string, number> = {};
      for (const row of rows) {
        counts[row.status] = (counts[row.status] ?? 0) + 1;
      }

      // 10 most recently updated
      const recent = await db
        .select({
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
        })
        .from(issues)
        .where(eq(issues.companyId, companyId))
        .orderBy(desc(issues.updatedAt))
        .limit(10);

      return {
        counts,
        recent: recent.map((r) => ({
          identifier: r.identifier ?? "",
          title: r.title,
          status: r.status,
        })),
      };
    },
    createIssue: async (companyId, input) => {
      const { issueService } = await import("../issues.js");
      const svc = issueService(db);
      try {
        const issue = await svc.create(companyId, {
          title: input.title,
          description: input.body || null,
          status: "todo",
        });
        return { id: issue.id, identifier: issue.identifier ?? "" };
      } catch (err) {
        console.warn("[voice-gateway] createIssue failed", err);
        return null;
      }
    },
  };
}
