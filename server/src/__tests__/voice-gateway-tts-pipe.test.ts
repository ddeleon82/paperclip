// Tests for TtsPipe — sequential sentence TTS pipe with barge-in cancel (FRE-1296).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTtsPipe, type TtsPipeDeps } from "../services/voice-gateway/tts-pipe.js";

// ---------------------------------------------------------------------------
// Controllable fake synthesize
// ---------------------------------------------------------------------------

/**
 * FakeSynth lets the test push chunks manually into the stream and close/error it
 * at will.  Call `instance()` to get both the ReadableStream (passed to the pipe)
 * and the controller handle so tests can drive it.
 */
interface SynthHandle {
  stream: ReadableStream<Uint8Array>;
  push(bytes: Uint8Array): void;
  close(): void;
  error(err: unknown): void;
}

function makeSynthHandle(): SynthHandle {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
  });
  return {
    stream,
    push(bytes) {
      ctrl.enqueue(bytes);
    },
    close() {
      ctrl.close();
    },
    error(err) {
      ctrl.error(err);
    },
  };
}

// ---------------------------------------------------------------------------
// Helper: build deps with vitest spies
// ---------------------------------------------------------------------------

interface FakeDeps extends TtsPipeDeps {
  _handles: SynthHandle[];
  _synthesizeSpy: ReturnType<typeof vi.fn>;
  _synthesizeFallbackSpy: ReturnType<typeof vi.fn>;
  _sendAudioStartSpy: ReturnType<typeof vi.fn>;
  _sendAudioChunkSpy: ReturnType<typeof vi.fn>;
  _sendAudioEndSpy: ReturnType<typeof vi.fn>;
}

function makeDeps(fallbackResult: Uint8Array | null = null): FakeDeps {
  const handles: SynthHandle[] = [];

  const synthesizeSpy = vi.fn((_sentence: string): ReadableStream<Uint8Array> => {
    const h = makeSynthHandle();
    handles.push(h);
    return h.stream;
  });

  const synthesizeFallbackSpy = vi.fn(
    (_sentence: string): Promise<Uint8Array | null> =>
      Promise.resolve(fallbackResult),
  );

  const sendAudioStartSpy = vi.fn();
  const sendAudioChunkSpy = vi.fn();
  const sendAudioEndSpy = vi.fn();

  const deps: FakeDeps = {
    _handles: handles,
    _synthesizeSpy: synthesizeSpy,
    _synthesizeFallbackSpy: synthesizeFallbackSpy,
    _sendAudioStartSpy: sendAudioStartSpy,
    _sendAudioChunkSpy: sendAudioChunkSpy,
    _sendAudioEndSpy: sendAudioEndSpy,
    synthesize: synthesizeSpy,
    synthesizeFallback: synthesizeFallbackSpy,
    sendAudioStart: sendAudioStartSpy,
    sendAudioChunk: sendAudioChunkSpy,
    sendAudioEnd: sendAudioEndSpy,
  };

  return deps;
}

// Flush all microtasks/promises
async function flushAll(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createTtsPipe", () => {
  // -------------------------------------------------------------------------
  // Basic ordering: two complete sentences processed sequentially
  // -------------------------------------------------------------------------
  describe("ordering", () => {
    it("synthesizes sentences in order and emits start/chunk/end for each", async () => {
      const deps = makeDeps();
      const pipe = createTtsPipe(deps);

      // Push two complete sentences
      pipe.pushTextDelta("Hello world. Goodbye world. ");
      await flushAll();

      // First sentence should have started synthesis
      expect(deps._synthesizeSpy).toHaveBeenCalledTimes(1);
      expect(deps._synthesizeSpy).toHaveBeenCalledWith("Hello world.");
      expect(deps._sendAudioStartSpy).toHaveBeenCalledWith(0);

      // Feed chunk for sentence 0
      const chunk0 = new Uint8Array([0x01, 0x02]);
      deps._handles[0].push(chunk0);
      deps._handles[0].close();
      await flushAll();

      expect(deps._sendAudioChunkSpy).toHaveBeenCalledWith(0, chunk0);
      expect(deps._sendAudioEndSpy).toHaveBeenCalledWith(0);

      // Now the second sentence should be synthesized
      expect(deps._synthesizeSpy).toHaveBeenCalledTimes(2);
      expect(deps._synthesizeSpy).toHaveBeenCalledWith(" Goodbye world.");
      expect(deps._sendAudioStartSpy).toHaveBeenCalledWith(1);

      const chunk1 = new Uint8Array([0x03, 0x04]);
      deps._handles[1].push(chunk1);
      deps._handles[1].close();
      await flushAll();

      expect(deps._sendAudioChunkSpy).toHaveBeenCalledWith(1, chunk1);
      expect(deps._sendAudioEndSpy).toHaveBeenCalledWith(1);
    });

    it("sends multiple chunks per sentence in order", async () => {
      const deps = makeDeps();
      const pipe = createTtsPipe(deps);

      pipe.pushTextDelta("Hello there. ");
      await flushAll();

      const a = new Uint8Array([0xaa]);
      const b = new Uint8Array([0xbb]);
      const c = new Uint8Array([0xcc]);
      deps._handles[0].push(a);
      deps._handles[0].push(b);
      deps._handles[0].push(c);
      deps._handles[0].close();
      await flushAll();

      const chunkCalls = deps._sendAudioChunkSpy.mock.calls;
      expect(chunkCalls).toHaveLength(3);
      expect(chunkCalls[0]).toEqual([0, a]);
      expect(chunkCalls[1]).toEqual([0, b]);
      expect(chunkCalls[2]).toEqual([0, c]);
    });

    it("seq numbering is monotonic across multiple sentences", async () => {
      const deps = makeDeps();
      const pipe = createTtsPipe(deps);

      pipe.pushTextDelta("One. Two. Three. ");
      await flushAll();
      deps._handles[0].close();
      await flushAll();
      deps._handles[1].close();
      await flushAll();
      deps._handles[2].close();
      await flushAll();

      const startCalls = deps._sendAudioStartSpy.mock.calls.map((c) => c[0]);
      expect(startCalls).toEqual([0, 1, 2]);
    });
  });

  // -------------------------------------------------------------------------
  // endTurn: flushes partial-sentence buffer remainder
  // -------------------------------------------------------------------------
  describe("endTurn()", () => {
    it("flushes a partial sentence (no terminal punctuation) as a final sentence", async () => {
      const deps = makeDeps();
      const pipe = createTtsPipe(deps);

      // Push text without terminal punctuation
      pipe.pushTextDelta("this is partial");
      await flushAll();

      // No synthesis yet — no complete sentence
      expect(deps._synthesizeSpy).toHaveBeenCalledTimes(0);

      pipe.endTurn();
      await flushAll();

      expect(deps._synthesizeSpy).toHaveBeenCalledWith("this is partial");
      expect(deps._sendAudioStartSpy).toHaveBeenCalledWith(0);

      deps._handles[0].close();
      await flushAll();

      expect(deps._sendAudioEndSpy).toHaveBeenCalledWith(0);
    });

    it("flushes remaining partial after complete sentences have been processed", async () => {
      const deps = makeDeps();
      const pipe = createTtsPipe(deps);

      pipe.pushTextDelta("First sentence. Partial tail");
      await flushAll();

      // First sentence synthesized
      deps._handles[0].close();
      await flushAll();

      pipe.endTurn();
      await flushAll();

      // Should also have synthesized the partial tail
      expect(deps._synthesizeSpy).toHaveBeenCalledTimes(2);
      expect(deps._synthesizeSpy.mock.calls[1][0]).toContain("Partial tail");

      deps._handles[1].close();
      await flushAll();

      expect(deps._sendAudioEndSpy).toHaveBeenCalledWith(1);
    });

    it("endTurn is a no-op when buffer is empty", async () => {
      const deps = makeDeps();
      const pipe = createTtsPipe(deps);

      pipe.pushTextDelta("Complete sentence. ");
      await flushAll();
      deps._handles[0].close();
      await flushAll();

      pipe.endTurn();
      await flushAll();

      // Still only one synthesis call
      expect(deps._synthesizeSpy).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // cancel(): barge-in stops in-flight synth, drops pending
  // -------------------------------------------------------------------------
  describe("cancel()", () => {
    it("cancels active stream mid-sentence — no more chunks are sent for that seq", async () => {
      const deps = makeDeps();
      const pipe = createTtsPipe(deps);

      pipe.pushTextDelta("Long sentence. ");
      await flushAll();

      expect(deps._sendAudioStartSpy).toHaveBeenCalledWith(0);

      // Cancel before the stream finishes
      pipe.cancel();
      await flushAll();

      // Push a chunk after cancel — should be suppressed
      if (deps._handles[0]) {
        deps._handles[0].push(new Uint8Array([0xff]));
        deps._handles[0].close();
        await flushAll();
      }

      expect(deps._sendAudioChunkSpy).not.toHaveBeenCalled();
      expect(deps._sendAudioEndSpy).not.toHaveBeenCalled();
    });

    it("drops pending (queued) sentences after cancel", async () => {
      const deps = makeDeps();
      const pipe = createTtsPipe(deps);

      // Two sentences; first occupies the synth slot, second is queued
      pipe.pushTextDelta("First sentence. Second sentence. ");
      await flushAll();

      // Only first should be started
      expect(deps._synthesizeSpy).toHaveBeenCalledTimes(1);

      pipe.cancel();
      await flushAll();

      // Even after completing the in-flight stream, second sentence is NOT synthesized
      if (deps._handles[0]) {
        deps._handles[0].close();
        await flushAll();
      }

      expect(deps._synthesizeSpy).toHaveBeenCalledTimes(1);
    });

    it("seq numbering continues after cancel (no reuse)", async () => {
      const deps = makeDeps();
      const pipe = createTtsPipe(deps);

      pipe.pushTextDelta("First. ");
      await flushAll();
      expect(deps._sendAudioStartSpy).toHaveBeenCalledWith(0);

      pipe.cancel();
      await flushAll();

      // Start a new turn after cancel
      pipe.pushTextDelta("New sentence. ");
      await flushAll();

      // seq should be 1 (continuing, not reset to 0)
      expect(deps._sendAudioStartSpy).toHaveBeenCalledWith(1);
    });
  });

  // -------------------------------------------------------------------------
  // Stream error: fallback path
  // -------------------------------------------------------------------------
  describe("stream error → synthesizeFallback", () => {
    it("on stream error uses fallback bytes for the SAME seq", async () => {
      const fallbackBytes = new Uint8Array([0xfe, 0xed]);
      const deps = makeDeps(fallbackBytes);
      const pipe = createTtsPipe(deps);

      pipe.pushTextDelta("Bad sentence. ");
      await flushAll();

      const seq = deps._sendAudioStartSpy.mock.calls[0][0];
      expect(seq).toBe(0);

      // Trigger error on the stream
      deps._handles[0].error(new Error("synth failed"));
      await flushAll();

      // Fallback should have been called
      expect(deps._synthesizeFallbackSpy).toHaveBeenCalledWith("Bad sentence.");

      // Fallback bytes sent on the same seq
      expect(deps._sendAudioChunkSpy).toHaveBeenCalledWith(0, fallbackBytes);
      expect(deps._sendAudioEndSpy).toHaveBeenCalledWith(0);
    });

    it("on stream error with fallback null — skips sentence, pipe continues", async () => {
      const deps = makeDeps(null); // fallback returns null
      const pipe = createTtsPipe(deps);

      pipe.pushTextDelta("Bad sentence. Good sentence. ");
      await flushAll();

      // Error on first sentence
      deps._handles[0].error(new Error("synth failed"));
      await flushAll();

      // No chunks for bad sentence
      expect(deps._sendAudioChunkSpy).not.toHaveBeenCalledWith(0, expect.anything());
      // sendAudioEnd is still called even when skipping (so the client knows seq 0 is done)
      // OR we skip it entirely — the spec says "skip the sentence", so no end either.
      // Either way the pipe must continue to the next sentence.

      // Second sentence should still be synthesized
      expect(deps._synthesizeSpy).toHaveBeenCalledTimes(2);
      expect(deps._sendAudioStartSpy).toHaveBeenCalledWith(1);

      deps._handles[1].close();
      await flushAll();

      expect(deps._sendAudioEndSpy).toHaveBeenCalledWith(1);
    });

    it("pipe continues normally after a skipped sentence", async () => {
      const deps = makeDeps(null);
      const pipe = createTtsPipe(deps);

      pipe.pushTextDelta("Skip this. Keep this. ");
      await flushAll();

      deps._handles[0].error(new Error("nope"));
      await flushAll();

      // Good second sentence
      const chunk = new Uint8Array([0x42]);
      deps._handles[1].push(chunk);
      deps._handles[1].close();
      await flushAll();

      expect(deps._sendAudioChunkSpy).toHaveBeenCalledWith(1, chunk);
      expect(deps._sendAudioEndSpy).toHaveBeenCalledWith(1);
    });
  });
});
