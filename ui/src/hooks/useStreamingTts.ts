import { useCallback, useEffect, useRef, useState } from "react";

export interface StreamingTtsControls {
  play: (audio: Uint8Array | ReadableStream<Uint8Array>) => Promise<void>;
  stop: () => void;
  isPlaying: boolean;
  /**
   * Returns the current RMS amplitude of TTS playback, normalized to [0, 1].
   * In environments without Web Audio (e.g. jsdom) or before playback starts
   * this returns 0. Safe to call every frame from a rAF loop.
   */
  getLevel: () => number;
  /**
   * Resolves when the currently-playing clip finishes (ended/pause event) or
   * immediately if nothing is playing. Used by the sentence TTS queue so it
   * can await full clip completion before advancing to the next sentence;
   * this prevents playBlob() from calling audio.pause() on a still-audible
   * clip when the queue pump is ready for the next item.
   */
  waitUntilDone: () => Promise<void>;
}

/**
 * Plays MP3 audio either as a fully-decoded Uint8Array (Blob path) or as a
 * streaming ReadableStream<Uint8Array> via the MediaSource API.
 *
 * The hook owns a single HTMLAudioElement reused across calls so that
 * `stop()` always targets the active source and barge-in is synchronous.
 */
export function useStreamingTts(): StreamingTtsControls {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const mediaSourceRef = useRef<MediaSource | null>(null);
  // Per-call abort state for the streaming pump. Bumped by stop() and by each
  // new play() so any prior pump notices it should bail out.
  const abortRef = useRef<{ aborted: boolean }>({ aborted: false });
  const activeReaderRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  // Resolvers queued by waitUntilDone(). Flushed when the audio element fires
  // pause or ended (i.e. the clip is fully complete or intentionally stopped).
  const doneResolversRef = useRef<Array<() => void>>([]);

  // Web Audio plumbing for getLevel(). Created lazily on first play() in
  // environments that support it. jsdom / SSR have no AudioContext, so these
  // remain null and getLevel() returns 0.
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  // Explicitly use ArrayBuffer (not ArrayBufferLike) so the buffer matches the
  // strict Uint8Array<ArrayBuffer> signature getByteTimeDomainData expects.
  const analyserBufferRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const mediaSourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);

  // Flush all waitUntilDone() resolvers. Called whenever playback ends so that
  // the sentence queue pump can advance only after a clip is fully audible.
  const flushDoneResolvers = useCallback(() => {
    const resolvers = doneResolversRef.current;
    doneResolversRef.current = [];
    for (const resolve of resolvers) resolve();
  }, []);

  // Lazy-create the audio element once.
  const getAudio = useCallback((): HTMLAudioElement => {
    if (!audioRef.current) {
      const audio = new Audio();
      audio.addEventListener("play", () => setIsPlaying(true));
      audio.addEventListener("playing", () => setIsPlaying(true));
      audio.addEventListener("pause", () => {
        setIsPlaying(false);
        flushDoneResolvers();
      });
      audio.addEventListener("ended", () => {
        setIsPlaying(false);
        flushDoneResolvers();
      });
      audio.addEventListener("error", () => {
        // eslint-disable-next-line no-console
        console.error("[useStreamingTts] audio element error", audio.error);
        setIsPlaying(false);
        flushDoneResolvers();
      });
      audioRef.current = audio;
    }
    return audioRef.current;
  }, [flushDoneResolvers]);

  // Lazily attach an AnalyserNode to the audio element so getLevel() can read
  // real-time RMS amplitude for waveform-driven visualizations. Best-effort:
  // any failure (no Web Audio support, MediaElementSource already used, etc.)
  // leaves the analyser refs null and getLevel() returns 0.
  const ensureAnalyser = useCallback((audio: HTMLAudioElement) => {
    if (analyserRef.current) return;
    if (typeof window === "undefined") return;
    // Some older Safari builds only expose webkitAudioContext.
    const win = window as unknown as {
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    const AudioCtor = win.AudioContext ?? win.webkitAudioContext ?? null;
    if (!AudioCtor) return;
    try {
      const ctx = audioCtxRef.current ?? new AudioCtor();
      audioCtxRef.current = ctx;
      const source =
        mediaSourceNodeRef.current ?? ctx.createMediaElementSource(audio);
      mediaSourceNodeRef.current = source;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.3;
      source.connect(analyser);
      // Keep audio audible by also routing to the destination.
      source.connect(ctx.destination);
      analyserRef.current = analyser;
      // Allocate over a plain ArrayBuffer so the buffer type matches the strict
      // Uint8Array<ArrayBuffer> signature of getByteTimeDomainData under TS 5.7.
      analyserBufferRef.current = new Uint8Array(new ArrayBuffer(analyser.fftSize));
    } catch (err) {
      // Most common failure: createMediaElementSource was already called on
      // this element in a prior session. Non-fatal; level will report 0.
      // eslint-disable-next-line no-console
      console.warn("[useStreamingTts] analyser init failed", err);
    }
  }, []);

  const getLevel = useCallback((): number => {
    const analyser = analyserRef.current;
    const buf = analyserBufferRef.current;
    if (!analyser || !buf) return 0;
    if (!isPlaying) return 0;
    try {
      analyser.getByteTimeDomainData(buf);
      // RMS of centered samples (128 == silence midpoint for 8-bit time domain).
      let sumSq = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sumSq += v * v;
      }
      const rms = Math.sqrt(sumSq / buf.length);
      // RMS for normalized speech rarely exceeds ~0.4; scale to [0, 1] for the
      // orb's hover uniform and clamp.
      return Math.max(0, Math.min(1, rms * 2.5));
    } catch {
      return 0;
    }
  }, [isPlaying]);

  const cleanupSources = useCallback(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    // Note: we deliberately do NOT call ms.endOfStream() here. stop() / barge-in
    // must abort cleanly without finalizing the MediaSource (which would be a
    // valid signal to consumers that the stream completed normally). Natural
    // drain in the pump is the only place endOfStream() is called.
    mediaSourceRef.current = null;
  }, []);

  const abortActiveStream = useCallback(() => {
    abortRef.current.aborted = true;
    const reader = activeReaderRef.current;
    if (reader) {
      try {
        reader.cancel().catch(() => {
          // ignore: cancellation errors are non-fatal.
        });
      } catch {
        // ignore
      }
      activeReaderRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    abortActiveStream();
    const audio = audioRef.current;
    if (audio) {
      try {
        audio.pause();
      } catch {
        // Ignore.
      }
      try {
        audio.currentTime = 0;
      } catch {
        // Some sources do not allow currentTime reset; ignore.
      }
    }
    cleanupSources();
    setIsPlaying(false);
  }, [abortActiveStream, cleanupSources]);

  const playBlob = useCallback(
    async (bytes: Uint8Array): Promise<void> => {
      const audio = getAudio();
      ensureAnalyser(audio);
      // Tear down any prior source first (synchronously).
      abortActiveStream();
      try {
        audio.pause();
      } catch {
        // ignore
      }
      cleanupSources();

      // Copy into an ArrayBuffer-backed Uint8Array so it satisfies BlobPart
      // under TS 5.7's stricter Uint8Array<ArrayBufferLike> typing.
      const owned = new Uint8Array(new ArrayBuffer(bytes.byteLength));
      owned.set(bytes);
      const blob = new Blob([owned], { type: "audio/mpeg" });
      const url = URL.createObjectURL(blob);
      objectUrlRef.current = url;
      audio.src = url;
      await audio.play();
    },
    [abortActiveStream, cleanupSources, ensureAnalyser, getAudio],
  );

  const playStream = useCallback(
    async (stream: ReadableStream<Uint8Array>): Promise<void> => {
      const audio = getAudio();
      ensureAnalyser(audio);
      // Cancel any prior streaming pump before starting a new one.
      abortActiveStream();
      try {
        audio.pause();
      } catch {
        // ignore
      }
      cleanupSources();

      if (typeof MediaSource === "undefined") {
        // Fallback: drain stream then play as a Blob.
        const chunks: Uint8Array[] = [];
        const reader = stream.getReader();
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) chunks.push(value);
        }
        let total = 0;
        for (const c of chunks) total += c.byteLength;
        const merged = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) {
          merged.set(c, off);
          off += c.byteLength;
        }
        return playBlob(merged);
      }

      // Gate on codec support before opening any object URL so we don't leak
      // resources on unsupported browsers.
      if (
        typeof MediaSource.isTypeSupported === "function" &&
        !MediaSource.isTypeSupported("audio/mpeg")
      ) {
        throw new Error(
          "[useStreamingTts] MediaSource does not support audio/mpeg in this browser",
        );
      }

      // Fresh abort token scoped to this play() call.
      const abortToken = { aborted: false };
      abortRef.current = abortToken;

      const mediaSource = new MediaSource();
      mediaSourceRef.current = mediaSource;
      const url = URL.createObjectURL(mediaSource);
      objectUrlRef.current = url;
      audio.src = url;

      const sourceOpenPromise = new Promise<void>((resolve) => {
        mediaSource.addEventListener("sourceopen", () => resolve(), { once: true });
      });
      // Start playback as soon as the first chunk lands. The audio element
      // will buffer underflows transparently.
      audio.play().catch(() => {
        // Will be retried after first append.
      });
      await sourceOpenPromise;
      if (abortToken.aborted) return;

      let sourceBuffer: SourceBuffer;
      try {
        sourceBuffer = mediaSource.addSourceBuffer("audio/mpeg");
      } catch (err) {
        // Clean up the object URL we created above so it doesn't leak.
        cleanupSources();
        throw err;
      }
      const reader = stream.getReader();
      activeReaderRef.current = reader;

      const appendChunk = (chunk: Uint8Array): Promise<void> =>
        new Promise<void>((resolve, reject) => {
          const onUpdateEnd = () => {
            sourceBuffer.removeEventListener("updateend", onUpdateEnd);
            sourceBuffer.removeEventListener("error", onError);
            resolve();
          };
          const onError = (e: Event) => {
            sourceBuffer.removeEventListener("updateend", onUpdateEnd);
            sourceBuffer.removeEventListener("error", onError);
            reject(e);
          };
          sourceBuffer.addEventListener("updateend", onUpdateEnd);
          sourceBuffer.addEventListener("error", onError);
          try {
            // Same Uint8Array<ArrayBufferLike> -> BufferSource gymnastics as
            // the Blob path above.
            const ownedChunk = new Uint8Array(new ArrayBuffer(chunk.byteLength));
            ownedChunk.set(chunk);
            sourceBuffer.appendBuffer(ownedChunk);
          } catch (err) {
            sourceBuffer.removeEventListener("updateend", onUpdateEnd);
            sourceBuffer.removeEventListener("error", onError);
            reject(err);
          }
        });

      // Pump runs in the background. play() resolves as soon as audio actually
      // starts (first append + play()); barge-in via stop() cancels the reader
      // and flips abortToken so the pump exits without further appends.
      let resolveStarted: () => void;
      let rejectStarted: (err: unknown) => void;
      const started = new Promise<void>((resolve, reject) => {
        resolveStarted = resolve;
        rejectStarted = reject;
      });

      const pump = async () => {
        let firstAppendDone = false;
        try {
          // eslint-disable-next-line no-constant-condition
          while (true) {
            if (abortToken.aborted) return;
            const { done, value } = await reader.read();
            if (abortToken.aborted) return;
            if (done) break;
            if (value && value.byteLength > 0) {
              await appendChunk(value);
              if (abortToken.aborted) return;
              if (audio.paused) {
                audio.play().catch(() => {
                  // Browser may still gate autoplay; surface via isPlaying = false.
                });
              }
              if (!firstAppendDone) {
                firstAppendDone = true;
                resolveStarted();
              }
            }
          }
          if (!abortToken.aborted && mediaSource.readyState === "open") {
            try {
              mediaSource.endOfStream();
            } catch {
              // ignore
            }
          }
          if (!firstAppendDone) {
            // Stream ended with no chunks; still resolve so caller unblocks.
            resolveStarted();
          }
        } catch (err) {
          if (!abortToken.aborted) {
            try {
              if (mediaSource.readyState === "open") {
                mediaSource.endOfStream();
              }
            } catch {
              // ignore
            }
          }
          if (!firstAppendDone) {
            rejectStarted(err);
          } else {
            // eslint-disable-next-line no-console
            console.error("[useStreamingTts] stream pump error after start", err);
          }
        } finally {
          if (activeReaderRef.current === reader) {
            activeReaderRef.current = null;
          }
        }
      };

      void pump();
      await started;
    },
    [abortActiveStream, cleanupSources, ensureAnalyser, getAudio, playBlob],
  );

  const play = useCallback(
    async (audio: Uint8Array | ReadableStream<Uint8Array>): Promise<void> => {
      if (audio instanceof Uint8Array) {
        return playBlob(audio);
      }
      return playStream(audio);
    },
    [playBlob, playStream],
  );

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      abortRef.current.aborted = true;
      const reader = activeReaderRef.current;
      if (reader) {
        try {
          reader.cancel().catch(() => {
            // ignore
          });
        } catch {
          // ignore
        }
        activeReaderRef.current = null;
      }
      const audio = audioRef.current;
      if (audio) {
        try {
          audio.pause();
        } catch {
          // ignore
        }
      }
      cleanupSources();
      audioRef.current = null;
      // Tear down Web Audio graph.
      try {
        mediaSourceNodeRef.current?.disconnect();
      } catch {
        // ignore
      }
      try {
        analyserRef.current?.disconnect();
      } catch {
        // ignore
      }
      mediaSourceNodeRef.current = null;
      analyserRef.current = null;
      analyserBufferRef.current = null;
      const ctx = audioCtxRef.current;
      if (ctx) {
        ctx.close().catch(() => {
          // ignore - context may already be closed.
        });
        audioCtxRef.current = null;
      }
    };
  }, [cleanupSources]);

  const waitUntilDone = useCallback((): Promise<void> => {
    // If nothing is playing, resolve immediately.
    if (!audioRef.current || audioRef.current.paused) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      doneResolversRef.current.push(resolve);
    });
  }, []);

  return { play, stop, isPlaying, getLevel, waitUntilDone };
}
