// FRE-947 P0.3 regression coverage.
//
// Verifies that heartbeatService.resumeQueuedRuns() resurrects orphaned
// `deferred_issue_execution` wake requests when the heartbeat run that was
// blocking the issue has reached a terminal status (or the issue's
// executionRunId has already been cleared) but the deferred wake itself was
// never promoted, e.g. after a host crash between issue-release and
// promote-next-deferred.
//
// Negative case: when the blocker run is still `running`, the deferred wake
// must stay pending. We do not steal execution from a live run.

import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentRuntimeState,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/registry.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat resume-deferred-wakes tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("resumeQueuedRuns - deferred wake resurrection (FRE-947 P0.3)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  // Barrier: holds the mock adapter's execute() open during test assertions,
  // then released in afterEach so executeRun can finish its cleanup writes
  // (setRunStatus, setWakeupStatus, releaseIssueExecutionAndPromote) before
  // the TRUNCATE. Without this, two failure modes arise:
  //
  // 1. Real adapter: spawns a real Claude Code process that connects to
  //    PAPERCLIP_API_URL (production) with test credentials that don't exist
  //    there. The process hangs, preventing the test runner from exiting.
  //
  // 2. Instant no-op: executeRun finishes its writes before the test's
  //    assertion queries return, producing non-deterministic status values
  //    and breaking the executionRunId invariant check.
  let releaseExecuteBarrier: (() => void) | null = null;
  let executeBarrierPromise: Promise<void> = Promise.resolve();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-resume-deferred-");
    db = createDb(tempDb.connectionString);
    // Register a barrier-based mock adapter for `claude_local`. It holds until
    // afterEach releases it, keeping the in-flight DB state visible to test
    // assertions and avoiding real process spawning.
    registerServerAdapter({
      type: "claude_local",
      supportsLocalAgentJwt: true,
      async execute() {
        await executeBarrierPromise;
        return { exitCode: 0, signal: null, timedOut: false };
      },
      async testEnvironment() {
        return {
          adapterType: "claude_local",
          status: "pass" as const,
          checks: [],
          testedAt: new Date().toISOString(),
        };
      },
    });
  }, 120_000);

  beforeEach(() => {
    // Reset barrier for each test so the mock holds during assertions.
    executeBarrierPromise = new Promise<void>((resolve) => {
      releaseExecuteBarrier = resolve;
    });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    // Release any in-flight adapter.execute() so executeRun can complete its
    // post-execution writes before the table truncation below.
    releaseExecuteBarrier?.();
    releaseExecuteBarrier = null;
    // Wait a tick so any fire-and-forget executeRun started by
    // startNextQueuedRunForAgent finishes its async DB writes before TRUNCATE.
    // Otherwise the in-flight inserts race against table cleanup and produce
    // noisy (but non-fatal) FK errors in the test log.
    await new Promise((resolve) => setTimeout(resolve, 50));
    // TRUNCATE ... CASCADE is the only sane reset given the breadth of FK fanout
    // from companies / agents (run_events, cost_events, runtime_state, etc.).
    await db.execute(
      sql`TRUNCATE TABLE companies, agents, agent_wakeup_requests, heartbeat_runs, heartbeat_run_events, agent_runtime_state, issues RESTART IDENTITY CASCADE`,
    );
  });

  afterAll(async () => {
    unregisterServerAdapter("claude_local");
    await tempDb?.cleanup();
  });

  async function seedScenario(input: {
    blockerStatus: "running" | "failed" | "succeeded" | "cancelled" | "timed_out";
    clearIssueExecutionRunId?: boolean;
    deferredAgentStatus?: "idle" | "paused" | "running";
  }) {
    const companyId = randomUUID();
    const blockerAgentId = randomUUID();
    const deferredAgentId = randomUUID();
    const blockerRunId = randomUUID();
    const deferredWakeId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const now = new Date("2026-05-23T00:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: blockerAgentId,
        companyId,
        name: "Blocker",
        role: "engineer",
        status: "idle",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: deferredAgentId,
        companyId,
        name: "Deferred",
        role: "engineer",
        status: input.deferredAgentStatus ?? "idle",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(heartbeatRuns).values({
      id: blockerRunId,
      companyId,
      agentId: blockerAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: input.blockerStatus,
      contextSnapshot: { issueId },
      startedAt: now,
      finishedAt: input.blockerStatus === "running" ? null : now,
      updatedAt: now,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Resurrect deferred wake on resume",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: blockerAgentId,
      executionRunId: input.clearIssueExecutionRunId ? null : blockerRunId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    await db.insert(agentWakeupRequests).values({
      id: deferredWakeId,
      companyId,
      agentId: deferredAgentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "deferred_issue_execution",
      requestedAt: now,
    });

    return { companyId, blockerAgentId, deferredAgentId, blockerRunId, deferredWakeId, issueId };
  }

  it("promotes an orphaned deferred wake when its blocker is a terminal run", async () => {
    const { deferredWakeId, deferredAgentId, issueId } = await seedScenario({
      blockerStatus: "failed",
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();

    const wake = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, deferredWakeId))
      .then((rows) => rows[0] ?? null);
    // After promotion the wake transitions to "queued"; startNextQueuedRunForAgent
    // (called from the promotion path) then claims it synchronously, so the visible
    // end-state may be "queued" or "claimed" depending on race ordering. Either is
    // a successful resurrection - "deferred_issue_execution" means we failed.
    expect(wake?.status).not.toBe("deferred_issue_execution");
    expect(["queued", "claimed", "running"]).toContain(wake?.status);
    expect(wake?.runId).not.toBeNull();
    expect(wake?.reason).toBe("issue_execution_promoted");

    // The newly created heartbeat run for the deferred agent should exist.
    const newRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, deferredAgentId));
    expect(newRuns).toHaveLength(1);
    expect(["queued", "running"]).toContain(newRuns[0]?.status);

    // The promoted run must carry "issue_execution_promoted" in its contextSnapshot.
    // If it inherited the original "issue_assigned" reason the adapter would call
    // shouldResetTaskSessionForWake() → true and discard the agent's saved session.
    const promotedSnapshot = newRuns[0]?.contextSnapshot as Record<string, unknown> | null;
    expect(promotedSnapshot?.wakeReason).toBe("issue_execution_promoted");

    // Issue execution slot is now held by the promoted run.
    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBe(newRuns[0]?.id ?? null);
  });

  it("promotes an orphaned deferred wake when the issue's executionRunId is already null", async () => {
    const { deferredWakeId, deferredAgentId } = await seedScenario({
      blockerStatus: "succeeded",
      clearIssueExecutionRunId: true,
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();

    const wake = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, deferredWakeId))
      .then((rows) => rows[0] ?? null);
    expect(wake?.status).not.toBe("deferred_issue_execution");
    expect(wake?.runId).not.toBeNull();

    const newRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, deferredAgentId));
    expect(newRuns).toHaveLength(1);
  });

  it("does NOT promote a deferred wake while the blocker run is still running", async () => {
    const { deferredWakeId, deferredAgentId } = await seedScenario({
      blockerStatus: "running",
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();

    const wake = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, deferredWakeId))
      .then((rows) => rows[0] ?? null);
    expect(wake?.status).toBe("deferred_issue_execution");
    expect(wake?.runId).toBeNull();

    const newRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, deferredAgentId));
    expect(newRuns).toHaveLength(0);
  });

  it("fails-not-stalls a deferred wake whose agent is paused at resume time", async () => {
    const { deferredWakeId } = await seedScenario({
      blockerStatus: "failed",
      deferredAgentStatus: "paused",
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();

    const wake = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, deferredWakeId))
      .then((rows) => rows[0] ?? null);
    // Per the existing promotion contract, paused/terminated/pending_approval agents
    // get their deferred wakes marked failed rather than left pending forever.
    expect(wake?.status).toBe("failed");
    expect(wake?.error).toContain("not invokable");
  });

  it("resurrects work for a paused agent after it is resumed", async () => {
    // Simulate the full lifecycle:
    // 1. Blocker finishes → promotion fails the deferred wake because agent is paused.
    // 2. Agent is set back to idle (resumed).
    // 3. resurrectDeferredWakesForAgent is called → should queue a fresh wakeup.
    const { deferredAgentId, issueId } = await seedScenario({
      blockerStatus: "failed",
      deferredAgentStatus: "paused",
    });
    const heartbeat = heartbeatService(db);

    // Step 1: Promotion attempt — deferred wake is failed because agent is paused.
    await heartbeat.resumeQueuedRuns();

    const failedWake = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, deferredAgentId))
      .then((rows) => rows[0] ?? null);
    expect(failedWake?.status).toBe("failed");

    // Step 2: Resume the agent (simulate the route's DB update).
    await db
      .update(agents)
      .set({ status: "idle", pauseReason: null, pausedAt: null, updatedAt: new Date() })
      .where(eq(agents.id, deferredAgentId));

    // Step 3: Call resurrectDeferredWakesForAgent — should queue a new wakeup.
    await heartbeat.resurrectDeferredWakesForAgent(deferredAgentId);

    // A new wakeup request should exist for the agent targeting the issue.
    const allWakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, deferredAgentId));

    const fresh = allWakes.find((w) => w.status !== "failed");
    expect(fresh).toBeDefined();
    expect(["queued", "claimed", "running"]).toContain(fresh?.status);
    expect(fresh?.reason).toBe("agent_resumed");

    // The issue's payload should reference the correct issue.
    const freshPayload = fresh?.payload as Record<string, unknown> | null;
    expect(freshPayload?.issueId).toBe(issueId);
  });

  it("does NOT promote a deferred wake whose company no longer exists (FK guard)", async () => {
    // Simulate the scenario where a deferred wake references a company that has
    // since been deleted (e.g. after a data purge or stale cross-instance wake delivery).
    // The agents.company_id FK prevents normal CASCADE deletion, so we use
    // session_replication_role='replica' to bypass FK enforcement during test setup only.
    // The guard in promoteDeferredWakesForIssue (if (!promotionCompanyExists) return null)
    // must bail out cleanly rather than letting the transaction hit a FK violation on
    // heartbeat_runs.company_id.
    const { companyId, deferredAgentId } = await seedScenario({
      blockerStatus: "failed",
    });
    const heartbeat = heartbeatService(db);

    // Bypass FK enforcement to simulate orphaned company (test setup only).
    // Use bare db.execute() calls (same pattern as the resurrectDeferredWakesForAgent
    // test below) — wrapping in db.transaction() causes SET LOCAL to be processed
    // through a different code path in postgres.js where the session-level flag does
    // not propagate to the subsequent DELETE, resulting in a spurious FK error.
    await db.execute(sql`SET LOCAL session_replication_role = 'replica'`);
    await db.execute(sql`DELETE FROM companies WHERE id = ${companyId}`);
    await db.execute(sql`SET LOCAL session_replication_role = 'origin'`);

    // Should not throw — the company-existence guard returns null before any FK-violating insert.
    await expect(heartbeat.resumeQueuedRuns()).resolves.toBeUndefined();

    // No new heartbeat runs should have been created for the deferred agent.
    const newRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, deferredAgentId));
    expect(newRuns).toHaveLength(0);
  });

  it("does NOT create duplicate wakeups if one is already queued for the issue", async () => {
    // Same scenario as above: agent paused → deferred failed → agent resumed.
    // But before resurrectDeferredWakesForAgent runs, someone already queued a
    // wakeup for the agent+issue. We must not create a second one.
    const { deferredAgentId, issueId, companyId } = await seedScenario({
      blockerStatus: "failed",
      deferredAgentStatus: "paused",
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();

    // Resume the agent.
    await db
      .update(agents)
      .set({ status: "idle", pauseReason: null, pausedAt: null, updatedAt: new Date() })
      .where(eq(agents.id, deferredAgentId));

    // Pre-seed an existing queued wakeup for the same agent+issue.
    await db.insert(agentWakeupRequests).values({
      id: randomUUID(),
      companyId,
      agentId: deferredAgentId,
      source: "automation",
      triggerDetail: "system",
      reason: "prior_queue_entry",
      payload: { issueId },
      status: "queued",
      requestedAt: new Date(),
    });

    await heartbeat.resurrectDeferredWakesForAgent(deferredAgentId);

    // Should still have exactly one non-failed wakeup (the pre-seeded one).
    const nonFailed = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, deferredAgentId))
      .then((rows) => rows.filter((r) => r.status !== "failed"));

    expect(nonFailed).toHaveLength(1);
    expect(nonFailed[0]?.reason).toBe("prior_queue_entry");
  });

  it("does NOT throw when resumeQueuedRuns encounters a fully deleted company", async () => {
    // Regression: if a company is deleted (with CASCADE removing child rows) after a
    // deferred wake was queued, resumeQueuedRuns must handle the absence gracefully
    // rather than surfacing a FK violation mid-transaction.
    const { companyId } = await seedScenario({ blockerStatus: "failed" });
    const heartbeat = heartbeatService(db);

    // Delete the company and all child rows in reverse-FK order.
    // Postgres foreign keys on this schema do not carry ON DELETE CASCADE, so we
    // must remove dependents before removing the parent to avoid constraint errors.
    await db.execute(sql`DELETE FROM heartbeat_run_events WHERE company_id = ${companyId}`);
    await db.execute(sql`DELETE FROM heartbeat_runs WHERE company_id = ${companyId}`);
    await db.execute(sql`DELETE FROM agent_wakeup_requests WHERE company_id = ${companyId}`);
    await db.execute(sql`DELETE FROM issues WHERE company_id = ${companyId}`);
    await db.execute(sql`DELETE FROM agent_runtime_state WHERE agent_id IN (SELECT id FROM agents WHERE company_id = ${companyId})`);
    await db.execute(sql`DELETE FROM agents WHERE company_id = ${companyId}`);
    await db.execute(sql`DELETE FROM companies WHERE id = ${companyId}`);

    // Must not throw — orphan candidate query finds no rows and exits silently.
    await expect(heartbeat.resumeQueuedRuns()).resolves.toBeUndefined();

    // No heartbeat runs should have been created for this (now-deleted) company.
    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(sql`company_id = ${companyId}`);
    expect(runs).toHaveLength(0);
  });

  it("does NOT throw when resurrectDeferredWakesForAgent finds its company deleted", async () => {
    // Regression: if a company row is removed from the DB while its agent records
    // still exist (orphaned via direct-DB cleanup / bypassed FKs), calling
    // resurrectDeferredWakesForAgent must log a warning and return cleanly rather
    // than hitting a FK constraint on heartbeat_runs.company_id.
    const { deferredAgentId, companyId } = await seedScenario({
      blockerStatus: "failed",
      deferredAgentStatus: "idle",
    });
    const heartbeat = heartbeatService(db);

    // Remove only the company row, leaving agents/issues/wakeups intact.
    // SET LOCAL only applies within a transaction, so we wrap the delete in one.
    // This bypasses FK triggers for the duration of the transaction, producing an
    // orphaned-agent state without cascading to child rows.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = 'replica'`);
      await tx.execute(sql`DELETE FROM companies WHERE id = ${companyId}`);
    });

    // Must not throw — the company-existence guard short-circuits and returns.
    await expect(
      heartbeat.resurrectDeferredWakesForAgent(deferredAgentId),
    ).resolves.toBeUndefined();

    // No new (non-deferred) wakeup requests should have been created.
    const allWakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, deferredAgentId));
    const nonDeferred = allWakes.filter((w) => w.status !== "deferred_issue_execution");
    expect(nonDeferred).toHaveLength(0);
  });

  it("FRE-947 P0.9: resumeQueuedRuns skips a queued run whose company was deleted after queuing", async () => {
    // Regression: a heartbeat_run existed in "queued" state for a company that was
    // subsequently deleted. resumeQueuedRuns → startNextQueuedRunForAgent → executeRun
    // must detect the missing company and mark the run as "failed" WITHOUT emitting any
    // FK-violating INSERTs into heartbeat_run_events or company_skills. Before P0.9,
    // this produced "heartbeat execution setup failed" FK errors in the server log.
    //
    // Approach: seed a queued heartbeat_run directly (bypassing promotion), then
    // delete the company before resumeQueuedRuns fires.
    const { deferredAgentId, companyId } = await seedScenario({
      blockerStatus: "succeeded",
    });
    const heartbeat = heartbeatService(db);

    // Seed a queued run for the deferred agent directly (simulating a run that was
    // promoted while the company still existed, then the company was deleted).
    const preQueuedRunId = randomUUID();
    const wakeId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeId,
      companyId,
      agentId: deferredAgentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_execution_promoted",
      payload: {},
      status: "queued",
      requestedAt: new Date(),
    });
    await db.insert(heartbeatRuns).values({
      id: preQueuedRunId,
      companyId,
      agentId: deferredAgentId,
      wakeupRequestId: wakeId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      contextSnapshot: { wakeReason: "issue_execution_promoted" },
      updatedAt: new Date(),
    });

    // Delete the company (bypassing FKs via replica role, test-only).
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = 'replica'`);
      await tx.execute(sql`DELETE FROM companies WHERE id = ${companyId}`);
    });

    // resumeQueuedRuns must not throw. The P0.9 guard inside executeRun detects the
    // missing company and marks the run failed cleanly.
    await expect(heartbeat.resumeQueuedRuns()).resolves.toBeUndefined();

    // Allow the fire-and-forget executeRun inside startNextQueuedRunForAgent to settle.
    await new Promise((resolve) => setTimeout(resolve, 200));

    // The run must be marked "failed" with the company_not_found error code.
    const finalRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, preQueuedRunId))
      .then((rows) => rows[0] ?? null);
    expect(finalRun?.status).toBe("failed");
    expect(finalRun?.errorCode).toBe("company_not_found");

    // No FK-violating heartbeat_run_events rows must exist for this run.
    const events = await db
      .select()
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, preQueuedRunId));
    expect(events).toHaveLength(0);
  });
});
