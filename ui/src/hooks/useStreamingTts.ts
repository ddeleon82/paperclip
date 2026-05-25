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
  const [isPlaying, setIsPlaying] = useState(false);

  // Lazy-create the audio element once.
  const getAudio = useCallback((): HTMLAudioElement => {
    if (!audioRef.current) {
      const audio = new Audio();
      audio.addEventListener("play", () => setIsPlaying(true));
      audio.addEventListener("playing", () => setIsPlaying(true));
      audio.addEventListener("pause", () => setIsPlaying(false));
      audio.addEventListener("ended", () => setIsPlaying(false));
      audioRef.current = audio;
    }
    return audioRef.current;
  }, []);

  const cleanupSources = useCallback(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    const ms = mediaSourceRef.current;
    if (ms && ms.readyState === "open") {
      try {
        ms.endOfStream();
      } catch {
        // Ignore: already ended or invalid state.
      }
    }
    mediaSourceRef.current = null;
  }, []);

  const stop = useCallback(() => {
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
  }, [cleanupSources]);

  const playBlob = useCallback(
    async (bytes: Uint8Array): Promise<void> => {
      const audio = getAudio();
      // Tear down any prior source first (synchronously).
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
    [cleanupSources, getAudio],
  );

  const playStream = useCallback(
    async (stream: ReadableStream<Uint8Array>): Promise<void> => {
      const audio = getAudio();
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
      const startedPlayback = audio.play().catch(() => {
        // Will be retried after first append.
      });
      await sourceOpenPromise;

      const sourceBuffer = mediaSource.addSourceBuffer("audio/mpeg");
      const reader = stream.getReader();

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

      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.byteLength > 0) {
            await appendChunk(value);
            if (audio.paused) {
              audio.play().catch(() => {
                // Browser may still gate autoplay; surface via isPlaying = false.
              });
            }
          }
        }
        if (mediaSource.readyState === "open") {
          mediaSource.endOfStream();
        }
      } catch (err) {
        try {
          if (mediaSource.readyState === "open") {
            mediaSource.endOfStream();
          }
        } catch {
          // ignore
        }
        throw err;
      }

      await startedPlayback;
    },
    [cleanupSources, getAudio, playBlob],
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
