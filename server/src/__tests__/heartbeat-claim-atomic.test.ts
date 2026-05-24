// FRE-947 P0.8: claimQueuedRun's two writes (heartbeatRuns → running and
// agentWakeupRequests → claimed) must be atomic. Prior code did them as two
// independent statements; if the second failed mid-flight (DB hiccup, deadlock,
// transient connection loss) the run was left at "running" while the wakeup
// stayed "queued", producing an orphan that confused reapOrphanedRuns.
//
// This test exercises the happy path through the public API
// (heartbeat.resumeQueuedRuns) and asserts the post-claim invariant: both
// rows MUST be in the synced state. This is a regression guard. The full
// atomicity-under-failure property is enforced by Postgres transaction
// semantics around the `db.transaction(...)` wrapper in claimQueuedRun, and
// is documented in the code comment at the call site.

import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  heartbeatRunEvents,
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
    `Skipping embedded Postgres heartbeat claim-atomic tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("claimQueuedRun - atomic run+wakeup write (FRE-947 P0.8)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-claim-atomic-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await db.execute(
      sql`TRUNCATE TABLE companies, agents, agent_wakeup_requests, heartbeat_runs, heartbeat_run_events RESTART IDENTITY CASCADE`,
    );
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedQueuedRunWithWakeup() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupId = randomUUID();
    const now = new Date("2026-05-23T00:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "TST",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Claimer",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "test",
      payload: {},
      status: "queued",
      requestedAt: now,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId: wakeupId,
      contextSnapshot: {},
      createdAt: now,
      updatedAt: now,
    });

    return { companyId, agentId, runId, wakeupId };
  }

  it("post-claim, both heartbeat_runs.status and agent_wakeup_requests.status are in synced state", async () => {
    const { runId, wakeupId } = await seedQueuedRunWithWakeup();
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();

    // Poll until both rows have moved past "queued" together (deterministic,
    // unlike a fixed sleep — robust on slow CI). Cap at 2s; failure prints
    // last observed state for diagnosis.
    let run: typeof heartbeatRuns.$inferSelect | null = null;
    let wakeup: typeof agentWakeupRequests.$inferSelect | null = null;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      run = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      wakeup = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupId))
        .then((rows) => rows[0] ?? null);
      if (run?.status !== "queued" && wakeup?.status !== "queued") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // Both rows must have moved past "queued" together. The exact terminal status
    // depends on whether executeRun has finished its async work (running → succeeded/failed),
    // but the invariant under test is: they must NEVER be in the split state where
    // the run is past "queued" but the wakeup is still "queued".
    expect(run?.status).not.toBe("queued");
    expect(wakeup?.status).not.toBe("queued");
    // The wakeup must be "claimed" (or a later terminal state set by executeRun).
    expect(["claimed", "completed", "failed"]).toContain(wakeup?.status);
  });
});
