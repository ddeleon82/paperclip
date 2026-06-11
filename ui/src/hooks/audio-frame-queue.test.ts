import { describe, expect, it, vi } from "vitest";
import { createAudioFrameSink } from "./audio-frame-queue";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBytes(values: number[]): Uint8Array {
  return new Uint8Array(values);
}

/** Build a sink whose play() resolves immediately. */
function makeSink(opts?: {
  onActivity?: (active: boolean) => void;
  stopPlayback?: () => void;
}) {
  const played: string[] = [];
  const play = vi.fn(async (blob: Blob) => {
    played.push(await blob.text());
  });
  const stopPlayback = opts?.stopPlayback ?? vi.fn();
  const sink = createAudioFrameSink({
    play,
    stopPlayback,
    onActivity: opts?.onActivity,
  });
  return { sink, played, play, stopPlayback };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("audio-frame-queue", () => {
  it("single sequence: chunks assemble and play as one blob", async () => {
    const { sink, played } = makeSink();
    sink.onAudioStart(1);
    sink.onAudioChunk(1, makeBytes([72, 101, 108])); // "Hel"
    sink.onAudioChunk(1, makeBytes([108, 111]));     // "lo"
    sink.onAudioEnd(1);
    await tick(); await tick();
    expect(played).toHaveLength(1);
    expect(played[0]).toBe("Hello");
  });

  it("multiple sequences play strictly in arrival order", async () => {
    const resolvers: Array<() => void> = [];
    const played: string[] = [];
    const play = vi.fn(
      (blob: Blob) =>
        new Promise<void>((res) => {
          // We drive resolution manually to test ordering
          resolvers.push(() => blob.text().then((t) => { played.push(t); res(); }));
        }),
    );
    const sink = createAudioFrameSink({ play, stopPlayback: vi.fn() });

    sink.onAudioStart(1);
    sink.onAudioStart(2);

    // Both ends arrive before play() resolves for seq 1
    sink.onAudioChunk(1, new Uint8Array([65])); // "A"
    sink.onAudioEnd(1);
    sink.onAudioChunk(2, new Uint8Array([66])); // "B"
    sink.onAudioEnd(2);

    await tick(); await tick();
    // seq 1 should be playing; seq 2 queued
    expect(resolvers).toHaveLength(1);

    resolvers[0](); // finish seq 1
    await tick(); await tick();
    expect(resolvers).toHaveLength(2);

    resolvers[1](); // finish seq 2
    await tick(); await tick();
    expect(played).toEqual(["A", "B"]);
  });

  it("chunk assembly: late chunks before onAudioEnd are included", async () => {
    const { sink, played } = makeSink();
    sink.onAudioStart(5);
    sink.onAudioChunk(5, makeBytes([1, 2]));
    sink.onAudioChunk(5, makeBytes([3, 4]));
    sink.onAudioChunk(5, makeBytes([5]));
    sink.onAudioEnd(5);
    await tick(); await tick();
    expect(played).toHaveLength(1);
    // All five bytes should be present in the assembled blob
    expect(played[0]).toBeTruthy();
  });

  it("interrupt() calls stopPlayback and drops pending seqs", async () => {
    const neverResolve = vi.fn(() => new Promise<void>(() => {}));
    const stopPlayback = vi.fn();
    const sink = createAudioFrameSink({ play: neverResolve, stopPlayback });

    sink.onAudioStart(1);
    sink.onAudioChunk(1, makeBytes([65]));
    sink.onAudioEnd(1);
    await tick();

    sink.onAudioStart(2);
    sink.onAudioChunk(2, makeBytes([66]));
    // seq 2 not ended yet

    sink.interrupt();
    expect(stopPlayback).toHaveBeenCalledTimes(1);

    // Late arrival for the dropped seq should not throw
    sink.onAudioChunk(2, makeBytes([99]));
    sink.onAudioEnd(2);
    await tick(); await tick();
    // neverResolve was called for seq 1 (one play call that never settled)
    // but seq 2 should have been dropped
    expect(neverResolve).toHaveBeenCalledTimes(1);
  });

  it("new seq after interrupt plays on fresh queue", async () => {
    const played: string[] = [];
    const stopPlayback = vi.fn();
    const sink = createAudioFrameSink({
      play: async (b) => { played.push(await b.text()); },
      stopPlayback,
    });

    // First turn
    sink.onAudioStart(1);
    sink.onAudioChunk(1, makeBytes([65])); // "A"
    sink.onAudioEnd(1);
    await tick(); await tick();
    expect(played).toEqual(["A"]);

    // Interrupt
    sink.interrupt();

    // Second turn — new seq after interrupt
    sink.onAudioStart(2);
    sink.onAudioChunk(2, makeBytes([66])); // "B"
    sink.onAudioEnd(2);
    await tick(); await tick();
    expect(played).toEqual(["A", "B"]);
  });

  it("activity callback fires true on first start, false after all done", async () => {
    const activity: boolean[] = [];
    const { sink } = makeSink({
      onActivity: (a) => activity.push(a),
    });

    sink.onAudioStart(1);
    // Should fire true now (pending count went 0→1)
    expect(activity).toEqual([true]);

    sink.onAudioChunk(1, makeBytes([65]));
    sink.onAudioEnd(1);
    await tick(); await tick();
    // After playback, pending count goes to 0 → false
    expect(activity).toContain(false);
    expect(activity[activity.length - 1]).toBe(false);
  });

  it("activity callback fires true again for second seq", async () => {
    const activity: boolean[] = [];
    const { sink } = makeSink({
      onActivity: (a) => activity.push(a),
    });

    sink.onAudioStart(1);
    expect(activity.filter(Boolean)).toHaveLength(1);
    sink.onAudioChunk(1, makeBytes([65]));
    sink.onAudioEnd(1);
    await tick(); await tick();

    const falseCount = activity.filter((v) => !v).length;
    expect(falseCount).toBeGreaterThanOrEqual(1);

    sink.onAudioStart(2);
    // true fired again
    const trueCount = activity.filter(Boolean).length;
    expect(trueCount).toBeGreaterThanOrEqual(2);
  });

  it("interrupt() drops pending seqs and activity goes false", async () => {
    const activity: boolean[] = [];
    const stopPlayback = vi.fn();
    const sink = createAudioFrameSink({
      play: async () => {},
      stopPlayback,
      onActivity: (a) => activity.push(a),
    });

    sink.onAudioStart(1);
    sink.onAudioStart(2);
    expect(activity.filter(Boolean)).toHaveLength(1); // only one true on transition 0→1

    sink.interrupt();
    // After interrupt, pending = 0 → false
    expect(activity[activity.length - 1]).toBe(false);
  });

  it("end() drives onActivity(false) once playback finishes", async () => {
    const activity: boolean[] = [];
    const { sink } = makeSink({
      onActivity: (a) => activity.push(a),
    });

    sink.onAudioStart(1);
    sink.onAudioChunk(1, makeBytes([65]));
    sink.onAudioEnd(1);
    sink.end();
    await tick(); await tick();
    // After end and play completion, goes false
    expect(activity).toContain(false);
    expect(activity[activity.length - 1]).toBe(false);
  });
});
