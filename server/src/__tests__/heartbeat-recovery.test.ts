// FRE-947 P0.7: heartbeat recovery chain must not let one phase swallow the next.
//
// Prior shape in index.ts:
//   heartbeat.reapOrphanedRuns().then(() => heartbeat.resumeQueuedRuns()).catch(...)
// If reapOrphanedRuns rejected, resumeQueuedRuns NEVER RAN for that tick. The
// outer .catch logged the reap error and silently dropped every queued wake
// the resume pass would have claimed. The next tick (5 min later for the
// periodic scheduler, never for startup) was the only chance.
//
// New contract via runHeartbeatRecovery(heartbeat, opts):
//   - Always runs reap first (in-memory state empty → safe to mark stale runs failed).
//   - Then ALWAYS runs resume, even if reap threw (queued runs predate reap and
//     are independently driveable).
//   - Each phase logs at error severity with its phase label if it throws.
//   - The function never rejects: callers can `void runHeartbeatRecovery(...)`
//     without UnhandledPromiseRejection risk.

import { describe, expect, it, vi } from "vitest";
import { runHeartbeatRecovery } from "../services/heartbeat-recovery.ts";

vi.mock("../middleware/logger.js", () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

import { logger } from "../middleware/logger.js";

describe("runHeartbeatRecovery (FRE-947 P0.7: isolate reap and resume)", () => {
  it("runs reap then resume on the happy path", async () => {
    const order: string[] = [];
    const heartbeat = {
      reapOrphanedRuns: vi.fn(async () => {
        order.push("reap");
        return { reaped: 0, runIds: [] };
      }),
      resumeQueuedRuns: vi.fn(async () => {
        order.push("resume");
      }),
    };

    await runHeartbeatRecovery(heartbeat);

    expect(order).toEqual(["reap", "resume"]);
    expect(heartbeat.reapOrphanedRuns).toHaveBeenCalledTimes(1);
    expect(heartbeat.resumeQueuedRuns).toHaveBeenCalledTimes(1);
  });

  it("still runs resume when reap throws", async () => {
    const reapBoom = new Error("reap exploded");
    const heartbeat = {
      reapOrphanedRuns: vi.fn().mockRejectedValue(reapBoom),
      resumeQueuedRuns: vi.fn(async () => {}),
    };

    await runHeartbeatRecovery(heartbeat);

    expect(heartbeat.resumeQueuedRuns).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: reapBoom, phase: "reapOrphanedRuns" }),
      expect.stringContaining("heartbeat recovery"),
    );
  });

  it("logs and does not throw when resume throws", async () => {
    const resumeBoom = new Error("resume exploded");
    const heartbeat = {
      reapOrphanedRuns: vi.fn(async () => ({ reaped: 0, runIds: [] })),
      resumeQueuedRuns: vi.fn().mockRejectedValue(resumeBoom),
    };

    await expect(runHeartbeatRecovery(heartbeat)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: resumeBoom, phase: "resumeQueuedRuns" }),
      expect.stringContaining("heartbeat recovery"),
    );
  });

  it("logs both phases when both throw, and still resolves", async () => {
    const reapBoom = new Error("reap exploded");
    const resumeBoom = new Error("resume exploded");
    const heartbeat = {
      reapOrphanedRuns: vi.fn().mockRejectedValue(reapBoom),
      resumeQueuedRuns: vi.fn().mockRejectedValue(resumeBoom),
    };

    await expect(runHeartbeatRecovery(heartbeat)).resolves.toBeUndefined();

    const errorCalls = (logger.error as ReturnType<typeof vi.fn>).mock.calls;
    expect(errorCalls.some((c) => c[0]?.err === reapBoom && c[0]?.phase === "reapOrphanedRuns")).toBe(true);
    expect(errorCalls.some((c) => c[0]?.err === resumeBoom && c[0]?.phase === "resumeQueuedRuns")).toBe(true);
  });

  it("forwards opts to reapOrphanedRuns", async () => {
    const heartbeat = {
      reapOrphanedRuns: vi.fn(async () => ({ reaped: 0, runIds: [] })),
      resumeQueuedRuns: vi.fn(async () => {}),
    };

    await runHeartbeatRecovery(heartbeat, { staleThresholdMs: 1234 });

    expect(heartbeat.reapOrphanedRuns).toHaveBeenCalledWith({ staleThresholdMs: 1234 });
  });
});
