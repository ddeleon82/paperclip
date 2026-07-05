// FRE-1861 integration coverage: cross-source per-agent mutual exclusion for
// issue-scoped runs, exercised through the public heartbeat API against
// embedded Postgres.
//
// Incident (FRE-1858, 2026-07-05): agent with maxConcurrentRuns=3 had an
// assignment-source run (issue_assigned) claim instantly while an
// automation-source issue run was live, then a second automation run claimed
// when a slot freed — two live sessions mutating one agent workspace.
//
// Invariant under test: regardless of wake source (automation, assignment,
// on_demand), at most one issue-scoped run may be live per agent. Non-issue
// runs keep slot semantics. Orphaned "running" rows (not live in-process)
// must not hold the mutex (FRE-1767).

import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
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
    `Skipping embedded Postgres cross-source mutex tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("startNextQueuedRunForAgent - cross-source issue-run mutex (FRE-1861)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  // Barrier adapter (same pattern as heartbeat-resume-deferred-wakes.test.ts):
  // holds adapter.execute() open so claimed runs stay live in-process during
  // assertions, then releases in afterEach so executeRun can finish cleanly.
  let releaseExecuteBarrier: (() => void) | null = null;
  let executeBarrierPromise: Promise<void> = Promise.resolve();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cross-source-mutex-");
    db = createDb(tempDb.connectionString);
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
    executeBarrierPromise = new Promise<void>((resolve) => {
      releaseExecuteBarrier = resolve;
    });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    releaseExecuteBarrier?.();
    releaseExecuteBarrier = null;
    await new Promise((resolve) => setTimeout(resolve, 100));
    await db.execute(
      sql`TRUNCATE TABLE companies, agents, agent_wakeup_requests, heartbeat_runs, heartbeat_run_events, agent_runtime_state, issues RESTART IDENTITY CASCADE`,
    );
  });

  afterAll(async () => {
    unregisterServerAdapter("claude_local");
    await tempDb?.cleanup();
  });

  async function getRunStatus(runId: string) {
    return db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]?.status ?? null);
  }

  async function seedBase(opts?: { maxConcurrentRuns?: number }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Muxer",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { maxConcurrentRuns: opts?.maxConcurrentRuns ?? 3 } },
      permissions: {},
    });

    const seedIssue = async (n: number) => {
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: `Mutex issue ${n}`,
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        issueNumber: n,
        identifier: `${issuePrefix}-${n}`,
      });
      return issueId;
    };

    return { companyId, agentId, seedIssue };
  }

  async function seedQueuedRun(input: {
    companyId: string;
    agentId: string;
    issueId?: string | null;
    createdAt: Date;
    source?: string;
  }) {
    const runId = randomUUID();
    const wakeupId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupId,
      companyId: input.companyId,
      agentId: input.agentId,
      source: input.source ?? "automation",
      triggerDetail: "system",
      reason: "test",
      payload: input.issueId ? { issueId: input.issueId } : {},
      status: "queued",
      requestedAt: input.createdAt,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: input.source ?? "automation",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId: wakeupId,
      contextSnapshot: input.issueId ? { issueId: input.issueId } : {},
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    });
    return runId;
  }

  it("serializes issue-scoped runs across sources while letting non-issue runs claim", async () => {
    const { companyId, agentId, seedIssue } = await seedBase({ maxConcurrentRuns: 3 });
    const issue1 = await seedIssue(1);
    const issue2 = await seedIssue(2);
    const issue3 = await seedIssue(3);

    const t0 = new Date("2026-07-05T00:00:00.000Z");
    const runA = await seedQueuedRun({ companyId, agentId, issueId: issue1, createdAt: t0, source: "automation" });
    const runB = await seedQueuedRun({
      companyId,
      agentId,
      issueId: issue2,
      createdAt: new Date(t0.getTime() + 1000),
      source: "assignment",
    });
    const runN = await seedQueuedRun({
      companyId,
      agentId,
      issueId: null,
      createdAt: new Date(t0.getTime() + 2000),
      source: "timer",
    });

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();

    // In-pass mutex: only ONE issue-scoped run claimed; non-issue run claims too.
    expect(await getRunStatus(runA)).toBe("running");
    expect(await getRunStatus(runB)).toBe("queued");
    expect(await getRunStatus(runN)).toBe("running");

    // Cross-pass mutex: another resume pass while runA is live in-process must
    // still not claim runB.
    await heartbeat.resumeQueuedRuns();
    expect(await getRunStatus(runB)).toBe("queued");

    // Cross-source: a fresh assignment wake for a third issue queues but does
    // not claim while runA is live.
    const wakeRun = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: issue3 },
      contextSnapshot: { issueId: issue3 },
    });
    expect(wakeRun).not.toBeNull();
    expect(await getRunStatus((wakeRun as { id: string }).id)).toBe("queued");

    // Release the barrier: runA finishes, mutex frees, runB claims.
    releaseExecuteBarrier?.();
    const deadline = Date.now() + 10_000;
    let runBStatus: string | null = "queued";
    while (Date.now() < deadline) {
      runBStatus = await getRunStatus(runB);
      if (runBStatus !== "queued") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(runBStatus).not.toBe("queued");
  }, 30_000);

  it("does not let an orphaned running issue row block claims (FRE-1767 liveness)", async () => {
    const { companyId, agentId, seedIssue } = await seedBase({ maxConcurrentRuns: 3 });
    const issue1 = await seedIssue(1);
    const issue2 = await seedIssue(2);

    // Orphan: running in the DB but never executed in this process, so it is
    // not registered live in-process. Must not hold the issue mutex.
    const orphanRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: orphanRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId: issue1 },
      startedAt: new Date("2026-07-05T00:00:00.000Z"),
      createdAt: new Date("2026-07-05T00:00:00.000Z"),
      updatedAt: new Date("2026-07-05T00:00:00.000Z"),
    });

    const queuedRunId = await seedQueuedRun({
      companyId,
      agentId,
      issueId: issue2,
      createdAt: new Date("2026-07-05T00:01:00.000Z"),
    });

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();

    expect(await getRunStatus(queuedRunId)).toBe("running");
  }, 30_000);
});
