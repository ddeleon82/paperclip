import { logger } from "../middleware/logger.js";
import { HttpError } from "../errors.js";

// FRE-1864: agent states for which enqueueWakeup throws 409 "Agent is not
// invokable in its current state". A wake to such an assignee can never
// succeed by retrying, so it is skipped (WARN), not propagated.
const NON_INVOKABLE_AGENT_STATUSES = new Set(["paused", "terminated", "pending_approval"]);

function isNonInvokableAssigneeError(err: unknown): boolean {
  if (!(err instanceof HttpError) || err.status !== 409) return false;
  const details = err.details as { status?: unknown } | undefined;
  return typeof details?.status === "string" && NON_INVOKABLE_AGENT_STATUSES.has(details.status);
}

type WakeupTriggerDetail = "manual" | "ping" | "callback" | "system";
type WakeupSource = "timer" | "assignment" | "on_demand" | "automation";

export interface IssueAssignmentWakeupDeps {
  wakeup: (
    agentId: string,
    opts: {
      source?: WakeupSource;
      triggerDetail?: WakeupTriggerDetail;
      reason?: string | null;
      payload?: Record<string, unknown> | null;
      requestedByActorType?: "user" | "agent" | "system";
      requestedByActorId?: string | null;
      contextSnapshot?: Record<string, unknown>;
    },
  ) => Promise<unknown>;
}

export function queueIssueAssignmentWakeup(input: {
  heartbeat: IssueAssignmentWakeupDeps;
  issue: { id: string; assigneeAgentId: string | null; status: string };
  reason: string;
  mutation: string;
  contextSource: string;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
}) {
  if (!input.issue.assigneeAgentId || input.issue.status === "backlog") return;

  // FRE-947 P0.5: never silently swallow assignment wake failures. Prior
  // behavior `.catch(() => null)` made callers see a resolved promise and
  // treat dropped wakes as successes, so assignees never re-entered the issue.
  // Surface the error loudly and propagate; the caller's transaction / API
  // handler decides whether to retry, alert, or fail the mutation.
  return input.heartbeat
    .wakeup(input.issue.assigneeAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: input.reason,
      payload: { issueId: input.issue.id, mutation: input.mutation },
      requestedByActorType: input.requestedByActorType,
      requestedByActorId: input.requestedByActorId ?? null,
      contextSnapshot: { issueId: input.issue.id, source: input.contextSource },
    })
    .catch((err) => {
      // FRE-1864: a paused/terminated/pending_approval assignee is an expected
      // state, not a failure — the issue mutation already succeeded and the
      // wake is best-effort. Under the previous unconditional rethrow, the
      // fire-and-forget caller in routes/issues.ts (issue create) turned this
      // 409 into an unhandled rejection that crashed the entire server.
      if (isNonInvokableAssigneeError(err)) {
        logger.warn(
          {
            issueId: input.issue.id,
            mutation: input.mutation,
            assigneeAgentId: input.issue.assigneeAgentId,
            agentStatus: (err as HttpError).details,
          },
          "assignee agent not invokable; assignment wake skipped",
        );
        return null;
      }
      // FRE-947 P0.5: all other failures stay loud and propagate.
      logger.error(
        { err, issueId: input.issue.id, mutation: input.mutation },
        "failed to wake assignee on issue assignment",
      );
      throw err;
    });
}
