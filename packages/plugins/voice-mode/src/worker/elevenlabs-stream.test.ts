import { describe, it, expect } from "vitest";
import { streamTextToSpeech } from "./elevenlabs-stream.js";

// A minimal WebSocket stub that:
// - resolves `open` on next microtask
// - on every text message it gets, replies with one JSON message containing a
//   base64-encoded "AA" payload, plus a final isFinal=true on the empty-text marker
class FakeElevenLabsWs {
  binaryType = "blob" as BinaryType;
  private listeners: Record<string, Array<(ev: unknown) => void>> = {};
  constructor() {
    queueMicrotask(() => this.emit("open", { type: "open" }));
  }
  addEventListener(type: string, cb: (ev: unknown) => void) {
    (this.listeners[type] ??= []).push(cb);
  }
  send(payload: string) {
    let parsed: { text?: string } = {};
    try { parsed = JSON.parse(payload); } catch { /* ignore */ }
    if (parsed.text === "" || parsed.text == null) {
      queueMicrotask(() => {
        this.emit("message", { data: JSON.stringify({ isFinal: true }) });
        this.emit("close", { type: "close" });
      });
      return;
    }
    // Skip the priming first message (which has text: " ")
    if (parsed.text === " ") return;
    queueMicrotask(() => {
      const b64 = Buffer.from(new Uint8Array([0xff, 0xfe])).toString("base64");
      this.emit("message", { data: JSON.stringify({ audio: b64 }) });
    });
  }
  close() {
    queueMicrotask(() => this.emit("close", { type: "close" }));
  }
  private emit(type: string, ev: unknown) {
    (this.listeners[type] ?? []).forEach((cb) => cb(ev));
  }
}

describe("streamTextToSpeech", () => {
  it("emits audio bytes for each text chunk and closes on final", async () => {
    const text$ = new ReadableStream<string>({
      start(controller) {
        controller.enqueue("Hello.");
        controller.enqueue(" Anything else?");
        controller.close();
      },
    });
    const audio$ = streamTextToSpeech({
      voiceId: "VjSFSNiy9sK85Z9QRu3d",
      text$,
      apiKey: "test-key",
      wsFactory: () => new FakeElevenLabsWs() as unknown as WebSocket,
    });
    const chunks: Uint8Array[] = [];
    const reader = audio$.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]).toBeInstanceOf(Uint8Array);
  });
});
