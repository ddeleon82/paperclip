// FRE-1861 (part 2): coalesce issue_assigned + issue_execution_promoted wakes
// for the same (agent, issue) within a short window, wiring the previously
// dormant agent_wakeup_requests.idempotency_key and coalesced_count columns.
//
// One human action (assigning an issue) can emit both an "issue_assigned"
// wake and an "issue_execution_promoted" wake for the same issue seconds
// apart. Evidence from the FRE-1858 incident showed idempotency_key=null and
// coalesced_count=0 on every wake row — dedup across wake reasons was
// unobservable and unkeyed. This test locks in:
//   1. Wake rows for the assigned/promoted pair get a derived idempotency key.
//   2. A second wake in the pair for the same (agent, issue) coalesces onto
//      the surviving queued run instead of creating a second run.
//   3. The surviving wake row's coalesced_count is incremented so dedup is
//      visible in evidence queries.

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres wake-pair coalesce tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("enqueueWakeup - issue_assigned/issue_execution_promoted pair coalescing (FRE-1861)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wake-pair-coalesce-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    vi.clearAllMocks();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await db.execute(
      sql`TRUNCATE TABLE companies, agents, agent_wakeup_requests, heartbeat_runs, heartbeat_run_events, agent_runtime_state, issues RESTART IDENTITY CASCADE`,
    );
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedScenario() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    // Default maxConcurrentRuns = 1; the seeded running (non-issue) run below
    // occupies the only slot so newly enqueued runs stay queued and no real
    // execution is attempted in this test.
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Pairer",
      role: "engineer",
      status: "running",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "timer",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: {},
      startedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const seedIssue = async (n: number) => {
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: `Pair issue ${n}`,
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

  it("coalesces the assigned/promoted pair onto one run and wires idempotency_key + coalesced_count", async () => {
    const { agentId, seedIssue } = await seedScenario();
    const issueId = await seedIssue(1);
    const heartbeat = heartbeatService(db);

    const run1 = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId },
    });
    expect(run1).not.toBeNull();
    const run1Id = (run1 as { id: string }).id;

    const survivorWake = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.runId, run1Id))
      .then((rows) => rows[0] ?? null);
    expect(survivorWake?.idempotencyKey).toBe(`issue-exec:${agentId}:${issueId}`);
    expect(survivorWake?.status).toBe("queued");

    const run2 = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_execution_promoted",
      payload: { issueId },
      contextSnapshot: { issueId },
    });
    expect(run2).not.toBeNull();
    // Coalesced onto the surviving run — no second run created.
    expect((run2 as { id: string }).id).toBe(run1Id);

    const issueRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.agentId, agentId),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
        ),
      );
    expect(issueRuns).toHaveLength(1);

    const survivorAfter = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, survivorWake!.id))
      .then((rows) => rows[0] ?? null);
    expect(survivorAfter?.coalescedCount).toBeGreaterThanOrEqual(1);

    // The second wake is recorded as a coalesced audit row keyed like the survivor.
    const coalescedRows = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, agentId),
          eq(agentWakeupRequests.status, "coalesced"),
        ),
      );
    expect(coalescedRows).toHaveLength(1);
    expect(coalescedRows[0]?.runId).toBe(run1Id);
    expect(coalescedRows[0]?.idempotencyKey).toBe(`issue-exec:${agentId}:${issueId}`);
  });

  it("does not coalesce wakes for different issues", async () => {
    const { agentId, seedIssue } = await seedScenario();
    const issue1 = await seedIssue(1);
    const issue2 = await seedIssue(2);
    const heartbeat = heartbeatService(db);

    const run1 = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: issue1 },
      contextSnapshot: { issueId: issue1 },
    });
    const run2 = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_execution_promoted",
      payload: { issueId: issue2 },
      contextSnapshot: { issueId: issue2 },
    });

    expect((run1 as { id: string }).id).not.toBe((run2 as { id: string }).id);
  });

  it("does not derive an idempotency key for reasons outside the assigned/promoted pair", async () => {
    const { agentId, seedIssue } = await seedScenario();
    const issueId = await seedIssue(1);
    const heartbeat = heartbeatService(db);

    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_status_changed",
      payload: { issueId },
      contextSnapshot: { issueId },
    });
    expect(run).not.toBeNull();

    const wake = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.runId, (run as { id: string }).id))
      .then((rows) => rows[0] ?? null);
    expect(wake?.idempotencyKey).toBeNull();
  });
});
