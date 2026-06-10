import { describe, expect, it, vi } from "vitest";
import { createTtsQueue } from "./useSentenceTtsQueue";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("sentence TTS queue", () => {
  it("synthesizes sentences in parallel but plays strictly in order", async () => {
    const resolvers: Array<(b: Blob) => void> = [];
    const speak = vi.fn(() => new Promise<Blob>((res) => resolvers.push(res)));
    const played: string[] = [];
    const play = vi.fn(async (b: Blob) => {
      played.push(await b.text());
    });
    const q = createTtsQueue(speak, play);

    q.enqueue("One.");
    q.enqueue("Two.");
    expect(speak).toHaveBeenCalledTimes(2); // parallel synth
    // Resolve out of order: Two finishes first.
    resolvers[1](new Blob(["Two."]));
    await tick();
    expect(played).toEqual([]); // must wait for One
    resolvers[0](new Blob(["One."]));
    await tick(); await tick();
    expect(played).toEqual(["One.", "Two."]); // ordered playback
  });

  it("drain() drops everything pending (barge-in)", async () => {
    const speak = vi.fn(() => new Promise<Blob>(() => {}));
    const play = vi.fn();
    const q = createTtsQueue(speak, play);
    q.enqueue("Doomed.");
    q.drain();
    await tick();
    expect(play).not.toHaveBeenCalled();
  });

  it("a failed synthesis skips the sentence, later ones still play", async () => {
    const speak = vi
      .fn()
      .mockRejectedValueOnce(new Error("tts 500"))
      .mockResolvedValueOnce(new Blob(["Second."]));
    const played: string[] = [];
    const q = createTtsQueue(speak, async (b) => {
      played.push(await b.text());
    });
    q.enqueue("First.");
    q.enqueue("Second.");
    await tick(); await tick();
    expect(played).toEqual(["Second."]);
  });

  it("onIdle fires when the queue empties after end()", async () => {
    const speak = vi.fn().mockResolvedValue(new Blob(["x"]));
    const onIdle = vi.fn();
    const q = createTtsQueue(speak, async () => {}, onIdle);
    q.enqueue("Only.");
    q.end();
    await tick(); await tick();
    expect(onIdle).toHaveBeenCalledTimes(1);
  });
});
