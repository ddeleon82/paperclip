// ui/src/hooks/useAckPlayer.test.ts
import { describe, expect, it, vi } from "vitest";
import { createAckCache } from "./useAckPlayer";

describe("ack cache", () => {
  it("fetches each ack phrase exactly once and returns cached blob URLs after", async () => {
    const speak = vi.fn().mockResolvedValue(new Blob(["mp3"], { type: "audio/mpeg" }));
    const toUrl = vi.fn().mockReturnValue("blob:fake-url");
    const cache = createAckCache(speak, toUrl);

    await cache.warm();
    expect(speak).toHaveBeenCalledTimes(cache.phrases.length);

    const first = cache.next();
    const second = cache.next();
    expect(first).toBe("blob:fake-url");
    expect(second).toBe("blob:fake-url");
    // No additional fetches after warm.
    expect(speak).toHaveBeenCalledTimes(cache.phrases.length);
  });

  it("next() returns null before warm() resolves (never blocks a turn)", () => {
    const speak = vi.fn(() => new Promise<Blob>(() => {}));
    const cache = createAckCache(speak, () => "blob:x");
    expect(cache.next()).toBeNull();
  });

  it("warm() tolerates individual fetch failures (partial cache still serves)", async () => {
    const speak = vi
      .fn()
      .mockResolvedValueOnce(new Blob(["ok"]))
      .mockRejectedValue(new Error("tts down"));
    const cache = createAckCache(speak, () => "blob:ok");
    await cache.warm();
    expect(cache.next()).toBe("blob:ok");
  });
});
