import { useCallback, useEffect, useRef, useState } from "react";

export interface StreamingTtsControls {
  play: (audio: Uint8Array | ReadableStream<Uint8Array>) => Promise<void>;
  stop: () => void;
  isPlaying: boolean;
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

  // Lazy-create the audio element once.
  const getAudio = useCallback((): HTMLAudioElement => {
    if (!audioRef.current) {
      const audio = new Audio();
      audio.addEventListener("play", () => setIsPlaying(true));
      audio.addEventListener("playing", () => setIsPlaying(true));
      audio.addEventListener("pause", () => setIsPlaying(false));
      audio.addEventListener("ended", () => setIsPlaying(false));
      audio.addEventListener("error", () => {
        // eslint-disable-next-line no-console
        console.error("[useStreamingTts] audio element error", audio.error);
        setIsPlaying(false);
      });
      audioRef.current = audio;
    }
    return audioRef.current;
  }, []);

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
    [abortActiveStream, cleanupSources, getAudio],
  );

  const playStream = useCallback(
    async (stream: ReadableStream<Uint8Array>): Promise<void> => {
      const audio = getAudio();
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
    [abortActiveStream, cleanupSources, getAudio, playBlob],
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
    };
  }, [cleanupSources]);

  return { play, stop, isPlaying };
}
