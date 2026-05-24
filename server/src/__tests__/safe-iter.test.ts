// FRE-947 P0.6: per-iteration resilience for heartbeat scheduler loops.
//
// Prior behavior: resumeQueuedRuns, reapOrphanedRuns, and tickTimers used bare
// `for (...) { await fn(item) }` loops with no try/catch. A single throw on
// iteration N aborted iterations N+1..end, meaning one bad row (corrupt agent,
// transient DB hiccup, FK violation) silently dropped wakes for every other
// agent in the pass until the next scheduler tick.
//
// New contract: `safeForEach(items, label, fn, idFor?)` runs `fn` for every
// item; if `fn` throws, it logs at error severity with the item id and label
// then continues to the next item. The loop never aborts. Errors surface in
// logs (loud), but a single bad row no longer wedges the whole pass.

import { describe, expect, it, vi } from "vitest";
import { safeForEach } from "../services/safe-iter.ts";

vi.mock("../middleware/logger.js", () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

import { logger } from "../middleware/logger.js";

describe("safeForEach (FRE-947 P0.6: per-iter resilience)", () => {
  it("calls fn for every item when no errors", async () => {
    const seen: number[] = [];
    await safeForEach([1, 2, 3], "test", async (n) => {
      seen.push(n);
    });
    expect(seen).toEqual([1, 2, 3]);
  });

  it("continues to remaining items when one iteration throws", async () => {
    const seen: number[] = [];
    await safeForEach([1, 2, 3], "test", async (n) => {
      if (n === 2) throw new Error("boom on 2");
      seen.push(n);
    });
    expect(seen).toEqual([1, 3]);
  });

  it("logs at error severity when an iteration throws", async () => {
    const boom = new Error("kaboom");
    await safeForEach(
      [{ id: "a" }, { id: "b" }],
      "reapOrphan",
      async (item) => {
        if (item.id === "a") throw boom;
      },
      (item) => item.id,
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: boom, itemId: "a", iter: "reapOrphan" }),
      "safeForEach iteration failed; continuing",
    );
  });

  it("omits itemId from log payload when no idFor provided", async () => {
    const boom = new Error("no-id");
    await safeForEach(["x"], "tick", async () => {
      throw boom;
    });
    const call = (logger.error as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0]?.err === boom,
    );
    expect(call).toBeDefined();
    expect(call?.[0]).not.toHaveProperty("itemId");
    expect(call?.[0]).toMatchObject({ iter: "tick" });
  });

  it("does not throw even if every iteration throws", async () => {
    await expect(
      safeForEach([1, 2, 3], "all-fail", async () => {
        throw new Error("always");
      }),
    ).resolves.toBeUndefined();
  });

  it("processes items sequentially (preserves order, awaits each)", async () => {
    const events: string[] = [];
    await safeForEach([10, 20, 30], "seq", async (n) => {
      events.push(`start-${n}`);
      await new Promise((r) => setTimeout(r, 5));
      events.push(`end-${n}`);
    });
    expect(events).toEqual([
      "start-10",
      "end-10",
      "start-20",
      "end-20",
      "start-30",
      "end-30",
    ]);
  });
});
