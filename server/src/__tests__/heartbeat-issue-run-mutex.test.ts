// FRE-1861: cross-source per-agent mutual exclusion for issue-scoped runs.
//
// Root cause of FRE-1858: agents configured with maxConcurrentRuns > 1 could
// claim multiple issue-scoped runs concurrently (assignment-source wakes
// claiming instantly while automation-source runs were live). All issue-scoped
// runs for one agent mutate the same agent workspace, so two live issue runs
// are a two-writer race regardless of which issue each run nominally targets.
//
// selectClaimableQueuedRuns is the pure claim-selection policy used by
// startNextQueuedRunForAgent. Invariant: at most ONE issue-scoped run may be
// live per agent at any time, across all wake sources. Non-issue runs (timer,
// voice, chat without issue scope) keep plain slot semantics.
//
// Liveness (FRE-1767): a "running" DB row that is not live in-process (server
// restarted; orphan awaiting reap) must NOT hold the issue mutex forever.

import { describe, expect, it, vi } from "vitest";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

import { selectClaimableQueuedRuns } from "../services/heartbeat.ts";

function run(id: string, issueId: string | null = null) {
  return { id, contextSnapshot: issueId ? { issueId } : {} };
}

describe("selectClaimableQueuedRuns - issue-scoped per-agent mutex (FRE-1861)", () => {
  it("claims only one issue-scoped run per pass even with free slots", () => {
    const selected = selectClaimableQueuedRuns({
      queuedRuns: [run("a", "issue-1"), run("b", "issue-2")],
      runningRuns: [],
      maxConcurrentRuns: 3,
      isRunLive: () => false,
    });
    expect(selected.map((r) => r.id)).toEqual(["a"]);
  });

  it("skips issue-scoped queued runs while another issue-scoped run is live", () => {
    const selected = selectClaimableQueuedRuns({
      queuedRuns: [run("b", "issue-2")],
      runningRuns: [run("a", "issue-1")],
      maxConcurrentRuns: 3,
      isRunLive: (id) => id === "a",
    });
    expect(selected).toEqual([]);
  });

  it("does not let an orphaned (non-live) running issue run block claims (FRE-1767 liveness)", () => {
    const selected = selectClaimableQueuedRuns({
      queuedRuns: [run("b", "issue-2")],
      runningRuns: [run("a", "issue-1")],
      maxConcurrentRuns: 3,
      isRunLive: () => false,
    });
    expect(selected.map((r) => r.id)).toEqual(["b"]);
  });

  it("claims non-issue runs normally while an issue run is live", () => {
    const selected = selectClaimableQueuedRuns({
      queuedRuns: [run("b", "issue-2"), run("n")],
      runningRuns: [run("a", "issue-1")],
      maxConcurrentRuns: 3,
      isRunLive: (id) => id === "a",
    });
    expect(selected.map((r) => r.id)).toEqual(["n"]);
  });

  it("preserves slot exhaustion semantics for non-issue runs", () => {
    const selected = selectClaimableQueuedRuns({
      queuedRuns: [run("n2")],
      runningRuns: [run("n1")],
      maxConcurrentRuns: 1,
      isRunLive: () => false,
    });
    expect(selected).toEqual([]);
  });

  it("claims an issue run when only non-issue runs are live and a slot is free", () => {
    const selected = selectClaimableQueuedRuns({
      queuedRuns: [run("a", "issue-1")],
      runningRuns: [run("n1")],
      maxConcurrentRuns: 2,
      isRunLive: (id) => id === "n1",
    });
    expect(selected.map((r) => r.id)).toEqual(["a"]);
  });

  it("caps total claims at available slots", () => {
    const selected = selectClaimableQueuedRuns({
      queuedRuns: [run("n1"), run("n2"), run("n3")],
      runningRuns: [run("n0")],
      maxConcurrentRuns: 3,
      isRunLive: (id) => id === "n0",
    });
    expect(selected.map((r) => r.id)).toEqual(["n1", "n2"]);
  });
});
