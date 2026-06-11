/** Browser <-> gateway wire protocol for /api/voice/live (FRE-1296).
 *  Upstream binary frames: raw PCM16LE mono 16kHz audio chunks (no header).
 *  Downstream binary frames: [4-byte BE uint32 sentence seq][mp3 bytes].
 *  Everything else is JSON text frames, discriminated on `type`. */

export type ClientMessage =
  | { type: "start"; agentId: string }
  | { type: "camera"; jpegBase64: string }
  | { type: "mute" }
  | { type: "unmute" }
  | { type: "end" };

export type ServerMessage =
  | { type: "ready"; sessionId: string }
  | { type: "resumed"; sessionId: string }
  | { type: "transcript"; role: "user" | "assistant"; text: string; final: boolean }
  | { type: "audio-start"; seq: number }
  | { type: "audio-end"; seq: number }
  | { type: "interrupt" }
  | { type: "run-dispatched"; runId: string }
  | { type: "run-complete"; runId: string; ok: boolean }
  | { type: "status"; state: "listening" | "thinking" | "speaking" }
  | { type: "superseded" }
  | { type: "error"; message: string };

export function encodeAudioFrame(seq: number, bytes: Uint8Array): Buffer {
  const buf = Buffer.alloc(4 + bytes.byteLength);
  buf.writeUInt32BE(seq >>> 0, 0);
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).copy(buf, 4);
  return buf;
}

export function decodeAudioFrame(buf: Buffer): { seq: number; bytes: Buffer } {
  return { seq: buf.readUInt32BE(0), bytes: buf.subarray(4) };
}

export function parseClientMessage(raw: string): ClientMessage | null {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== "object") return null;
  const msg = value as Record<string, unknown>;
  switch (msg.type) {
    case "start":
      return typeof msg.agentId === "string" && msg.agentId.length > 0
        ? { type: "start", agentId: msg.agentId }
        : null;
    case "camera":
      return typeof msg.jpegBase64 === "string" ? { type: "camera", jpegBase64: msg.jpegBase64 } : null;
    case "mute": return { type: "mute" };
    case "unmute": return { type: "unmute" };
    case "end": return { type: "end" };
    default: return null;
  }
}
