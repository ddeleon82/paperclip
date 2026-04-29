import { randomUUID } from "node:crypto";

interface AudioEntry { bytes: Uint8Array; expiresAt: number; }

export interface AudioStore {
  put(bytes: Uint8Array): Promise<string>;
  get(id: string): Promise<Uint8Array | null>;
  sweep(): Promise<void>;
}

export function createAudioStore(opts: { ttlMs: number }): AudioStore {
  const map = new Map<string, AudioEntry>();
  return {
    async put(bytes) {
      const id = randomUUID();
      map.set(id, { bytes, expiresAt: Date.now() + opts.ttlMs });
      return id;
    },
    async get(id) {
      const entry = map.get(id);
      if (!entry) return null;
      if (entry.expiresAt < Date.now()) {
        map.delete(id);
        return null;
      }
      return entry.bytes;
    },
    async sweep() {
      const now = Date.now();
      for (const [id, entry] of map.entries()) {
        if (entry.expiresAt < now) map.delete(id);
      }
    },
  };
}
