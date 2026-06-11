// Sequential sentence TTS pipe with barge-in cancel (FRE-1296).
// Splits incoming text deltas into sentences, synthesises each one serially,
// and forwards start/chunk/end frames to the caller.

import { splitIntoSentences } from "../voice/sentence-buffer.js";

export interface TtsPipeDeps {
  /** Streaming synthesis — wraps streamTextToSpeech over ElevenLabs WS. */
  synthesize(sentence: string): ReadableStream<Uint8Array>;
  /**
   * Non-streaming fallback (POST /v1/text-to-speech/{voiceId}) used when the
   * streaming path errors. Returns null on failure. Task 18.1 records this as
   * the server-side substitute for the plugin voice.speak fallback.
   */
  synthesizeFallback(sentence: string): Promise<Uint8Array | null>;
  sendAudioStart(seq: number): void;
  sendAudioChunk(seq: number, bytes: Uint8Array): void;
  sendAudioEnd(seq: number): void;
}

export interface TtsPipe {
  /** Feed an incremental text delta (e.g. from Claude text_delta events). */
  pushTextDelta(text: string): void;
  /** Flush the partial-sentence buffer and finish in-flight synthesis. */
  endTurn(): void;
  /**
   * Barge-in: cancel the active ReadableStream, drop pending sentences, and
   * suppress any further sends for seqs that have already been started.
   * Seq numbering continues monotonically after cancel.
   */
  cancel(): void;
}

export function createTtsPipe(deps: TtsPipeDeps): TtsPipe {
  const sentenceBuf = splitIntoSentences();

  // Monotonically increasing seq counter — never resets on cancel.
  let nextSeq = 0;

  // Sentences waiting to be synthesised (FIFO).
  const queue: string[] = [];

  // Whether synthesis is currently running for a sentence.
  let busy = false;

  // Seqs for which we have called sendAudioStart but have been cancelled —
  // any further sends for these seqs are suppressed.
  const cancelledSeqs = new Set<number>();

  // AbortController for the active reader pump.
  let activeAbort: AbortController | null = null;

  // Enqueue sentences and kick the pump.
  function enqueue(sentences: string[]): void {
    for (const s of sentences) {
      queue.push(s);
    }
    if (!busy) {
      void processNext();
    }
  }

  async function processNext(): Promise<void> {
    if (queue.length === 0) {
      busy = false;
      return;
    }

    busy = true;
    const sentence = queue.shift()!;
    const seq = nextSeq++;

    const abort = new AbortController();
    activeAbort = abort;

    deps.sendAudioStart(seq);

    let stream: ReadableStream<Uint8Array>;
    try {
      stream = deps.synthesize(sentence);
    } catch (err) {
      activeAbort = null;
      await handleStreamError(sentence, seq, err, abort.signal);
      void processNext();
      return;
    }

    const reader = stream.getReader();

    try {
      while (true) {
        // Honour cancel: stop pumping if aborted.
        if (abort.signal.aborted) {
          try { await reader.cancel(); } catch { /* ignore */ }
          break;
        }

        let done: boolean;
        let value: Uint8Array | undefined;
        try {
          ({ done, value } = await reader.read());
        } catch (err) {
          // Stream errored — try fallback for the same seq.
          await handleStreamError(sentence, seq, err, abort.signal);
          break;
        }

        if (done) {
          if (!cancelledSeqs.has(seq)) {
            deps.sendAudioEnd(seq);
          }
          break;
        }

        if (value && !cancelledSeqs.has(seq)) {
          deps.sendAudioChunk(seq, value);
        }
      }
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
      activeAbort = null;
    }

    void processNext();
  }

  /**
   * Called when the synth stream errors.  Tries synthesizeFallback for the
   * same sentence/seq; if that returns bytes, sends them as a single chunk
   * and closes the seq.  If it returns null, the sentence is skipped (no
   * sendAudioEnd for that seq either, per spec: "skip the sentence").
   */
  async function handleStreamError(
    sentence: string,
    seq: number,
    err: unknown,
    signal: AbortSignal,
  ): Promise<void> {
    console.warn("[tts-pipe] synth stream error for sentence", { sentence, seq, err });

    let fallbackBytes: Uint8Array | null = null;
    try {
      fallbackBytes = await deps.synthesizeFallback(sentence);
    } catch (fbErr) {
      console.warn("[tts-pipe] synthesizeFallback threw", { sentence, seq, fbErr });
    }

    if (signal.aborted || cancelledSeqs.has(seq)) return;

    if (fallbackBytes !== null) {
      deps.sendAudioChunk(seq, fallbackBytes);
      deps.sendAudioEnd(seq);
    }
    // else: skip — no sendAudioEnd
  }

  return {
    pushTextDelta(text: string): void {
      const sentences = sentenceBuf.push(text);
      if (sentences.length > 0) {
        enqueue(sentences);
      }
    },

    endTurn(): void {
      const tail = sentenceBuf.flush();
      if (tail.length > 0) {
        enqueue(tail);
      }
    },

    cancel(): void {
      // Mark active seq(s) as cancelled so ongoing chunk/end sends are suppressed.
      // The seq for the active synthesis is nextSeq - 1 (already incremented).
      const activeSeq = nextSeq - 1;
      if (activeSeq >= 0 && busy) {
        cancelledSeqs.add(activeSeq);
      }

      // Abort the active reader pump.
      if (activeAbort) {
        activeAbort.abort();
        activeAbort = null;
      }

      // Drop all pending sentences.
      queue.length = 0;

      busy = false;
    },
  };
}
