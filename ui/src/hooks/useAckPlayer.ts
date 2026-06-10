// ui/src/hooks/useAckPlayer.ts
export const ACK_PHRASES = [
  "On it.",
  "Give me a second.",
  "Working on it.",
] as const;

export interface AckCache {
  phrases: readonly string[];
  warm(): Promise<void>;
  /** Returns a playable blob URL, or null if nothing cached yet. Round-robins. */
  next(): string | null;
  /** Revokes all cached blob URLs and clears the cache. next() returns null afterward. */
  dispose(): void;
}

export function createAckCache(
  speak: (text: string) => Promise<Blob>,
  toUrl: (b: Blob) => string = (b) => URL.createObjectURL(b),
  revoke: (u: string) => void = (u) => URL.revokeObjectURL(u),
): AckCache {
  const urls: string[] = [];
  let i = 0;
  return {
    phrases: ACK_PHRASES,
    async warm() {
      await Promise.all(
        ACK_PHRASES.map(async (p) => {
          try {
            urls.push(toUrl(await speak(p)));
          } catch {
            // Partial cache is fine; acks are best-effort.
          }
        }),
      );
    },
    next() {
      if (urls.length === 0) return null;
      const url = urls[i % urls.length];
      i += 1;
      return url;
    },
    dispose() {
      for (const u of urls) revoke(u);
      urls.length = 0;
    },
  };
}
