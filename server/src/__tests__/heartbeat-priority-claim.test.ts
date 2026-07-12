// FRE-2086: priority-aware claiming for the per-agent issue mutex.
//
// Root cause (from FRE-2073 recovery): startNextQueuedRunForAgent fed queued
// runs to selectClaimableQueuedRuns in createdAt ASC (plain FIFO) order, and the
// mutex claims the FIRST issue-scoped run it sees. A critical-priority wake that
// arrived after a stale medium/high backlog (including a wake for a CANCELLED
// issue) therefore queued behind that backlog and starved while Dom waited.
//
// selectClaimableQueuedRuns now reorders competing issue-scoped runs by
// linked-issue priority (critical first), ties broken by input order (oldest
// requested first). Non-issue runs and their slot semantics are unchanged.

import { describe, expect, it, vi } from "vitest";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

import {
  issuePriorityClaimRank,
  selectClaimableQueuedRuns,
} from "../services/heartbeat.ts";

function run(id: string, issueId: string | null = null, priorityRank: number | null = null) {
  return {
    id,
    contextSnapshot: issueId ? { issueId } : {},
    issuePriorityRank: issueId ? priorityRank : null,
  };
}

describe("issuePriorityClaimRank (FRE-2086)", () => {
  it("ranks critical most urgent and low least urgent", () => {
    expect(issuePriorityClaimRank("critical")).toBe(0);
    expect(issuePriorityClaimRank("high")).toBe(1);
    expect(issuePriorityClaimRank("medium")).toBe(2);
    expect(issuePriorityClaimRank("low")).toBe(3);
  });

  it("sorts unknown/unset priorities after every known priority", () => {
    const unknown = issuePriorityClaimRank("bogus");
    expect(unknown).toBeGreaterThan(issuePriorityClaimRank("low"));
    expect(issuePriorityClaimRank(null)).toBe(unknown);
    expect(issuePriorityClaimRank(undefined)).toBe(unknown);
  });
});

describe("selectClaimableQueuedRuns - priority-aware issue claiming (FRE-2086)", () => {
  it("claims the highest-priority issue run even when it was queued last", () => {
    // createdAt ASC order: stale low, then medium, then a late-arriving critical.
    const selected = selectClaimableQueuedRuns({
      queuedRuns: [
        run("low", "issue-low", issuePriorityClaimRank("low")),
        run("med", "issue-med", issuePriorityClaimRank("medium")),
        run("crit", "issue-crit", issuePriorityClaimRank("critical")),
      ],
      runningRuns: [],
      maxConcurrentRuns: 1,
      isRunLive: () => false,
    });
    expect(selected.map((r) => r.id)).toEqual(["crit"]);
  });

  it("breaks priority ties by input order (oldest requested first)", () => {
    const selected = selectClaimableQueuedRuns({
      queuedRuns: [
        run("high-old", "issue-a", issuePriorityClaimRank("high")),
        run("high-new", "issue-b", issuePriorityClaimRank("high")),
      ],
      runningRuns: [],
      maxConcurrentRuns: 1,
      isRunLive: () => false,
    });
    expect(selected.map((r) => r.id)).toEqual(["high-old"]);
  });

  it("still claims only one issue run per pass regardless of priority", () => {
    const selected = selectClaimableQueuedRuns({
      queuedRuns: [
        run("crit", "issue-crit", issuePriorityClaimRank("critical")),
        run("high", "issue-high", issuePriorityClaimRank("high")),
      ],
      runningRuns: [],
      maxConcurrentRuns: 3,
      isRunLive: () => false,
    });
    expect(selected.map((r) => r.id)).toEqual(["crit"]);
  });

  it("does not reorder non-issue runs and preserves their FIFO order", () => {
    const selected = selectClaimableQueuedRuns({
      queuedRuns: [run("n1"), run("n2"), run("n3")],
      runningRuns: [],
      maxConcurrentRuns: 3,
      isRunLive: () => false,
    });
    expect(selected.map((r) => r.id)).toEqual(["n1", "n2", "n3"]);
  });

  it("keeps a non-issue run's slot position while promoting the best issue run", () => {
    // Non-issue run sits between two issue runs; only the issue runs reorder,
    // the non-issue run stays in place.
    const selected = selectClaimableQueuedRuns({
      queuedRuns: [
        run("low", "issue-low", issuePriorityClaimRank("low")),
        run("n1"),
        run("crit", "issue-crit", issuePriorityClaimRank("critical")),
      ],
      runningRuns: [],
      maxConcurrentRuns: 3,
      isRunLive: () => false,
    });
    // crit takes the issue slot (position of the first issue run), n1 fills a
    // non-issue slot; the low-priority issue run is skipped by the mutex.
    expect(selected.map((r) => r.id)).toEqual(["crit", "n1"]);
  });

  it("treats missing priority rank as least urgent", () => {
    const selected = selectClaimableQueuedRuns({
      queuedRuns: [
        run("unknown", "issue-x", null),
        run("high", "issue-y", issuePriorityClaimRank("high")),
      ],
      runningRuns: [],
      maxConcurrentRuns: 1,
      isRunLive: () => false,
    });
    expect(selected.map((r) => r.id)).toEqual(["high"]);
  });
});
