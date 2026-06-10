/**
 * Ordered TTS playback queue (ada_v2 audio-queue pattern, ada.py:322,667).
 * Sentences are synthesized in parallel the moment they are enqueued, but
 * audio plays strictly in enqueue order. drain() implements barge-in: drop
 * everything not yet played. end() + empty queue fires onIdle exactly once,
 * which is what flips the machine back to "listening" via TTS_END.
 */
export interface TtsQueue {
  enqueue(sentence: string): void;
  /** No more sentences coming; fire onIdle when playback finishes. */
  end(): void;
  /** Barge-in: drop all pending audio immediately. */
  drain(): void;
}

export function createTtsQueue(
  speak: (text: string) => Promise<Blob>,
  play: (blob: Blob) => Promise<void>,
  onIdle?: () => void,
): TtsQueue {
  type Slot = { blob: Blob | null; failed: boolean; done: boolean };
  let slots: Slot[] = [];
  let playing = false;
  let ended = false;
  let generation = 0;
  let idleFired = false;
  // Once drain() is called the queue is permanently closed. Per-turn instances
  // are never reused after barge-in, so post-drain enqueue/end are always bugs.
  let closed = false;

  const pump = async (gen: number) => {
    if (playing) return;
    playing = true;
    try {
      while (gen === generation) {
        const slot = slots[0];
        if (!slot) {
          if (ended && !idleFired) {
            idleFired = true;
            onIdle?.();
          }
          return;
        }
        if (!slot.done) return; // head still synthesizing; resolver re-pumps
        slots.shift();
        if (slot.blob && !slot.failed) {
          try {
            await play(slot.blob);
          } catch {
            // AbortError from barge-in pause while play() is pending, or any
            // other play rejection. Skip this sentence; the pump continues to
            // the next slot rather than propagating an unhandled rejection.
          }
        }
      }
    } finally {
      playing = false;
      // Re-check: head may have resolved while we were playing.
      if (gen === generation && slots[0]?.done) void pump(gen);
      // If the queue just drained and we're ended, fire idle.
      if (gen === generation && slots.length === 0 && ended && !idleFired) {
        idleFired = true;
        onIdle?.();
      }
    }
  };

  return {
    enqueue(sentence: string) {
      // No-op after drain(): the per-turn run.log handler may still fire but
      // any synth or playback it would start belongs to the dead turn.
      if (closed) return;
      const gen = generation;
      const slot: Slot = { blob: null, failed: false, done: false };
      slots.push(slot);
      speak(sentence)
        .then((b) => {
          slot.blob = b;
        })
        .catch(() => {
          slot.failed = true;
        })
        .finally(() => {
          slot.done = true;
          if (gen === generation) void pump(gen);
        });
    },
    end() {
      // No-op after drain(): onIdle must not fire for a closed queue.
      if (closed) return;
      ended = true;
      void pump(generation);
    },
    drain() {
      // Seal the queue permanently. Bumping generation stops any in-flight pump
      // loop. Dropping slots releases blob references. closed=true makes future
      // enqueue/end calls inert so streamed run.log events that arrive after
      // barge-in cannot synthesize or play new audio.
      closed = true;
      generation += 1;
      slots = [];
      // Do NOT reset ended/idleFired: the queue is terminal, not reusable.
    },
  };
}
