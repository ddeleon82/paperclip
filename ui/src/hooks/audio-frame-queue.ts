/**
 * audio-frame-queue.ts
 *
 * Adapts server-pushed tagged audio frames (audio-start / audio-chunk /
 * audio-end messages) onto the existing ordered TTS queue so that MP3 segments
 * are played strictly in sequence, regardless of network reordering.
 *
 * Reference: server/src/services/voice-gateway/protocol.ts for the wire types.
 */

import { createTtsQueue, type TtsQueue } from "./useSentenceTtsQueue";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface AudioFrameSink {
  /** Server sent audio-start for this sequence number. */
  onAudioStart(seq: number): void;
  /** Server sent an audio chunk for this sequence number. */
  onAudioChunk(seq: number, bytes: Uint8Array): void;
  /** Server sent audio-end; assembles chunks and resolves the play promise. */
  onAudioEnd(seq: number): void;
  /**
   * Barge-in: drain + stopPlayback + clear pending map + install a fresh
   * TtsQueue. The existing queue is terminal after drain(); the sink is
   * session-long and must survive multiple turns.
   */
  interrupt(): void;
  /** Signal end of current turn; fires onActivity(false) when playback finishes. */
  end(): void;
}

export function createAudioFrameSink(opts: {
  play: (blob: Blob) => Promise<void>;
  /**
   * Hard-stops the CURRENTLY PLAYING audio (pauses the element and settles
   * the in-flight play() promise). Without this, barge-in only drops queued
   * sentences while the current one keeps speaking.
   */
  stopPlayback: () => void;
  /**
   * Fires with `true` when the sink has audio queued or playing, `false` when
   * it goes idle. Implemented via a pending-count that increments on
   * onAudioStart and decrements when a slot finishes playing or is dropped.
   */
  onActivity?: (active: boolean) => void;
}): AudioFrameSink {
  const { play, stopPlayback, onActivity } = opts;

  // ---------------------------------------------------------------------------
  // Pending-slot map — keyed by seq number
  // ---------------------------------------------------------------------------
  type Slot = {
    chunks: Uint8Array[];
    resolve: (b: Blob) => void;
    reject: (e: Error) => void;
  };
  let pending = new Map<number, Slot>();

  // ---------------------------------------------------------------------------
  // Activity tracking
  // ---------------------------------------------------------------------------
  let pendingCount = 0;

  const incPending = () => {
    pendingCount += 1;
    if (pendingCount === 1) onActivity?.(true);
  };

  const decPending = () => {
    if (pendingCount <= 0) return;
    pendingCount -= 1;
    if (pendingCount === 0) onActivity?.(false);
  };

  // ---------------------------------------------------------------------------
  // TTS queue — wrap play() so each slot's Blob becomes the "spoken" content
  // ---------------------------------------------------------------------------
  let queue: TtsQueue = buildQueue();

  function buildQueue(): TtsQueue {
    return createTtsQueue(
      // speak: given the seq (as string), return the Blob promise for that slot
      (seqStr: string) => {
        const seq = Number(seqStr);
        const slot = pending.get(seq);
        if (!slot) {
          // Already dropped by interrupt(); return a never-resolving promise
          // — the drain() that cleared it will have bumped generation already,
          // so the pump will never try to play this.
          return new Promise<Blob>(() => {});
        }
        return new Promise<Blob>((res, rej) => {
          // Patch resolvers so onAudioEnd can fire them
          const original = slot;
          original.resolve = res;
          original.reject = rej;
        });
      },
      // play: wrap the caller's play() and decrement pending when done
      async (blob: Blob) => {
        try {
          await play(blob);
        } finally {
          decPending();
        }
      },
    );
  }

  // ---------------------------------------------------------------------------
  // AudioFrameSink implementation
  // ---------------------------------------------------------------------------
  return {
    onAudioStart(seq: number) {
      // Register the slot so speak() can attach resolvers to it
      const slot: Slot = {
        chunks: [],
        resolve: () => {},
        reject: () => {},
      };
      pending.set(seq, slot);
      incPending();

      // Enqueue into the TTS queue; the "speak" function above will return
      // a promise that resolves only when onAudioEnd fires for this seq.
      queue.enqueue(String(seq));
    },

    onAudioChunk(seq: number, bytes: Uint8Array) {
      const slot = pending.get(seq);
      if (!slot) return; // dropped by interrupt()
      slot.chunks.push(bytes);
    },

    onAudioEnd(seq: number) {
      const slot = pending.get(seq);
      if (!slot) return; // dropped by interrupt()
      pending.delete(seq);
      const blob = new Blob(slot.chunks, { type: "audio/mpeg" });
      slot.resolve(blob);
    },

    interrupt() {
      // 1. Drain the current queue (makes it terminal / closed)
      queue.drain();
      // 2. Hard-stop whatever is currently playing
      stopPlayback();
      // 3. Drop all pending seqs (late chunks/ends for these are ignored)
      const dropped = pending.size;
      pending.clear();
      // 4. Reset activity counter for the dropped slots
      //    (the in-flight play() for the current slot will still call decPending
      //     via the finally block, but stopPlayback should have rejected that
      //     promise; we reset here to be safe)
      if (pendingCount > 0) {
        pendingCount = 0;
        onActivity?.(false);
      }
      // Suppress lint — dropped variable is intentionally unused in logic
      void dropped;
      // 5. Install a fresh queue for the next turn
      queue = buildQueue();
    },

    end() {
      queue.end();
    },
  };
}
