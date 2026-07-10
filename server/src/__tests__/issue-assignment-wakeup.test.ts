// FRE-947 P0.5: queueIssueAssignmentWakeup must surface enqueue failures
// rather than silently swallowing them with .catch(() => null). Prior behavior
// returned a resolved-null promise on any wakeup error, so callers treated
// dropped assignment wakes as successes and the assignee never re-entered the
// issue.
//
// New contract: the returned promise rejects when the underlying wakeup throws,
// and `logger.error` is emitted (severity bumped from warn). Callers must
// handle the rejection; passing `rethrowOnError: false` is no longer a way to
// hide the failure — the catch-and-null pathway has been removed.

import { describe, expect, it, vi } from "vitest";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.ts";
import { conflict } from "../errors.ts";

vi.mock("../middleware/logger.js", () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

import { logger } from "../middleware/logger.js";

describe("queueIssueAssignmentWakeup (FRE-947 P0.5: surface failures)", () => {
  it("rejects when the underlying wakeup rejects", async () => {
    const boom = new Error("wakeup boom");
    const heartbeat = {
      wakeup: vi.fn().mockRejectedValue(boom),
    };

    const promise = queueIssueAssignmentWakeup({
      heartbeat,
      issue: { id: "issue-1", assigneeAgentId: "agent-1", status: "todo" },
      reason: "assigned",
      mutation: "assign",
      contextSource: "test",
    });

    await expect(promise).rejects.toBe(boom);
  });

  it("logs at error severity when wakeup fails (not warn)", async () => {
    const boom = new Error("wakeup boom");
    const heartbeat = {
      wakeup: vi.fn().mockRejectedValue(boom),
    };

    await expect(
      queueIssueAssignmentWakeup({
        heartbeat,
        issue: { id: "issue-err-log", assigneeAgentId: "agent-1", status: "todo" },
        reason: "assigned",
        mutation: "assign",
        contextSource: "test",
      }),
    ).rejects.toBe(boom);

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: boom, issueId: "issue-err-log" }),
      "failed to wake assignee on issue assignment",
    );
  });

  it("returns undefined (no wakeup) when there is no assignee", async () => {
    const heartbeat = { wakeup: vi.fn() };
    const result = queueIssueAssignmentWakeup({
      heartbeat,
      issue: { id: "issue-2", assigneeAgentId: null, status: "todo" },
      reason: "assigned",
      mutation: "assign",
      contextSource: "test",
    });
    expect(result).toBeUndefined();
    expect(heartbeat.wakeup).not.toHaveBeenCalled();
  });

  it("returns undefined when issue is in backlog (no wake fired)", async () => {
    const heartbeat = { wakeup: vi.fn() };
    const result = queueIssueAssignmentWakeup({
      heartbeat,
      issue: { id: "issue-3", assigneeAgentId: "agent-1", status: "backlog" },
      reason: "assigned",
      mutation: "assign",
      contextSource: "test",
    });
    expect(result).toBeUndefined();
    expect(heartbeat.wakeup).not.toHaveBeenCalled();
  });

  // FRE-1864: a 409 "agent not invokable" (paused/terminated/pending_approval
  // assignee) is an expected state, not a failure. It must resolve (skip) with
  // a WARN, never reject — the unconditional rethrow turned this into an
  // unhandled rejection at the fire-and-forget issue-create call site and
  // crashed the entire server.
  it("resolves null + warns (no rethrow) when assignee agent is paused (FRE-1864)", async () => {
    const notInvokable = conflict("Agent is not invokable in its current state", { status: "paused" });
    const heartbeat = {
      wakeup: vi.fn().mockRejectedValue(notInvokable),
    };

    const result = await queueIssueAssignmentWakeup({
      heartbeat,
      issue: { id: "issue-paused", assigneeAgentId: "agent-paused", status: "todo" },
      reason: "assigned",
      mutation: "create",
      contextSource: "test",
    });

    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ issueId: "issue-paused", assigneeAgentId: "agent-paused" }),
      "assignee agent not invokable; assignment wake skipped",
    );
    expect(logger.error).not.toHaveBeenCalledWith(
      expect.objectContaining({ issueId: "issue-paused" }),
      expect.anything(),
    );
  });

  it("resolves null for terminated and pending_approval assignees too (FRE-1864)", async () => {
    for (const status of ["terminated", "pending_approval"]) {
      const heartbeat = {
        wakeup: vi.fn().mockRejectedValue(conflict("Agent is not invokable in its current state", { status })),
      };
      await expect(
        queueIssueAssignmentWakeup({
          heartbeat,
          issue: { id: `issue-${status}`, assigneeAgentId: "agent-1", status: "todo" },
          reason: "assigned",
          mutation: "create",
          contextSource: "test",
        }),
      ).resolves.toBeNull();
    }
  });

  it("still rejects on 409s that are NOT non-invokable-agent (e.g. budget block) (FRE-1864)", async () => {
    const budgetBlocked = conflict("Budget exceeded", { scopeType: "company", scopeId: "c-1" });
    const heartbeat = {
      wakeup: vi.fn().mockRejectedValue(budgetBlocked),
    };

    await expect(
      queueIssueAssignmentWakeup({
        heartbeat,
        issue: { id: "issue-budget", assigneeAgentId: "agent-1", status: "todo" },
        reason: "assigned",
        mutation: "create",
        contextSource: "test",
      }),
    ).rejects.toBe(budgetBlocked);
  });

  it("passes through the wakeup result on success", async () => {
    const heartbeat = {
      wakeup: vi.fn().mockResolvedValue({ kind: "queued" as const }),
    };

    const result = await queueIssueAssignmentWakeup({
      heartbeat,
      issue: { id: "issue-4", assigneeAgentId: "agent-1", status: "in_progress" },
      reason: "assigned",
      mutation: "assign",
      contextSource: "test",
    });

    expect(result).toEqual({ kind: "queued" });
    expect(heartbeat.wakeup).toHaveBeenCalledTimes(1);
    expect(heartbeat.wakeup).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({
        source: "assignment",
        triggerDetail: "system",
        reason: "assigned",
        payload: { issueId: "issue-4", mutation: "assign" },
        contextSnapshot: { issueId: "issue-4", source: "test" },
      }),
    );
  });
});
