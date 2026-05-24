import { logger } from "../middleware/logger.js";

/**
 * FRE-947 P0.7: heartbeat recovery sequencing with per-phase error isolation.
 *
 * Reap first (clears stale `running` runs so resume isn't blocked by phantom
 * slot owners), then resume (claims queued runs whose owners crashed). If reap
 * throws, resume still runs — queued work predates the reap pass and is
 * independently driveable. The function logs at error severity per phase and
 * never rejects, so callers can `void runHeartbeatRecovery(...)`.
 */
export interface HeartbeatRecoveryDeps {
  reapOrphanedRuns: (opts?: { staleThresholdMs?: number }) => Promise<unknown>;
  resumeQueuedRuns: () => Promise<unknown>;
}

export async function runHeartbeatRecovery(
  heartbeat: HeartbeatRecoveryDeps,
  opts?: { staleThresholdMs?: number },
): Promise<void> {
  try {
    await heartbeat.reapOrphanedRuns(opts);
  } catch (err) {
    logger.error({ err, phase: "reapOrphanedRuns" }, "heartbeat recovery: phase failed; continuing");
  }

  try {
    await heartbeat.resumeQueuedRuns();
  } catch (err) {
    logger.error({ err, phase: "resumeQueuedRuns" }, "heartbeat recovery: phase failed");
  }
}
