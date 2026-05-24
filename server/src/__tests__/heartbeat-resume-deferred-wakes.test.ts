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
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-resume-deferred-");
    db = createDb(tempDb.connectionString);
    // Register a no-op mock adapter for `claude_local` so that
    // startNextQueuedRunForAgent / executeRun triggered by the heartbeat service
    // does NOT spawn a real Claude Code process. Tests only assert DB state;
    // they do not need (or want) a live process connecting to the production API
    // with ephemeral test credentials that don't exist in production.
    registerServerAdapter({
      type: "claude_local",
      supportsLocalAgentJwt: true,
      async execute() {
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
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
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
    await db.execute(sql`SET session_replication_role = 'replica'`);
    await db.execute(sql`DELETE FROM companies WHERE id = ${companyId}`);
    await db.execute(sql`SET session_replication_role = 'origin'`);

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
});
