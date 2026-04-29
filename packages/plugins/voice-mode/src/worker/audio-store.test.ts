import { describe, it, expect, beforeEach, vi } from "vitest";
import { createAudioStore } from "./audio-store";

describe("audioStore", () => {
  beforeEach(() => vi.useFakeTimers());

  it("stores audio bytes under a generated id and retrieves them", async () => {
    const store = createAudioStore({ ttlMs: 24 * 60 * 60 * 1000 });
    const id = await store.put(new Uint8Array([1, 2, 3]));
    const got = await store.get(id);
    expect(got).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("returns null after TTL elapses", async () => {
    const store = createAudioStore({ ttlMs: 24 * 60 * 60 * 1000 });
    const id = await store.put(new Uint8Array([9]));
    vi.advanceTimersByTime(25 * 60 * 60 * 1000);
    expect(await store.get(id)).toBeNull();
  });

  it("sweep() removes expired entries", async () => {
    const store = createAudioStore({ ttlMs: 1000 });
    const id = await store.put(new Uint8Array([1]));
    vi.advanceTimersByTime(2000);
    await store.sweep();
    expect(await store.get(id)).toBeNull();
  });
});
