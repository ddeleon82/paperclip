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
});
