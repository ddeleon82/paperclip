import { logger } from "../middleware/logger.js";

/**
 * FRE-947 P0.6: per-iteration resilience for scheduler loops.
 *
 * Runs `fn(item)` for every entry in `items`. If `fn` throws, logs at error
 * severity (with `iter` label and optional `itemId`) then proceeds to the
 * next item. The loop never aborts.
 *
 * Use this in heartbeat scheduler passes (resumeQueuedRuns, reapOrphanedRuns,
 * tickTimers) where a single bad row must not wedge the whole tick.
 */
export async function safeForEach<T>(
  items: readonly T[],
  iter: string,
  fn: (item: T) => Promise<void>,
  idFor?: (item: T) => string | undefined,
): Promise<void> {
  for (const item of items) {
    try {
      await fn(item);
    } catch (err) {
      const payload: Record<string, unknown> = { err, iter };
      if (idFor) {
        const id = idFor(item);
        if (id !== undefined) payload.itemId = id;
      }
      logger.error(payload, "safeForEach iteration failed; continuing");
    }
  }
}
