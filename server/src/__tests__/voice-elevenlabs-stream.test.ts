// Tests for the server-side ElevenLabs streaming helper (FRE-1296).
// Uses a fake wsFactory so no real sockets are opened.
import { describe, it, expect } from "vitest";
import { streamTextToSpeech } from "../services/voice/elevenlabs-stream.js";

// -------------------------------------------------------------------------
// Fake WebSocket stub
// -------------------------------------------------------------------------

interface SentMsg {
  raw: string;
  parsed: Record<string, unknown> | null;
}

class FakeWs {
  binaryType: BinaryType = "blob";
  readonly url: string;
  readonly sent: SentMsg[] = [];
  private listeners: Record<string, Array<(ev: unknown) => void>> = {};
  closed = false;

  constructor(url: string) {
    this.url = url;
    // Resolve open on next microtask so callers can attach listeners first
    queueMicrotask(() => this.emit("open", { type: "open" }));
  }

  addEventListener(type: string, cb: (ev: unknown) => void) {
    (this.listeners[type] ??= []).push(cb);
  }

  send(raw: string) {
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // ignore
    }
    this.sent.push({ raw, parsed });

    if (!parsed) return;

    // Mirror the ElevenLabs protocol: on empty-text marker, send isFinal + close
    if (parsed["text"] === "" || parsed["text"] == null) {
      queueMicrotask(() => {
        this.emit("message", {
          data: JSON.stringify({ isFinal: true }),
        });
        this.emit("close", { type: "close" });
      });
      return;
    }

    // Skip priming message (text: " ")
    if (parsed["text"] === " ") return;

    // For every real text chunk, reply with a short audio payload
    queueMicrotask(() => {
      const b64 = Buffer.from(new Uint8Array([0xaa, 0xbb])).toString("base64");
      this.emit("message", {
        data: JSON.stringify({ audio: b64, isFinal: false }),
      });
    });
  }

  close() {
    this.closed = true;
    queueMicrotask(() => this.emit("close", { type: "close" }));
  }

  private emit(type: string, ev: unknown) {
    for (const cb of this.listeners[type] ?? []) cb(ev);
  }
}

interface FactoryHandle {
  ws: FakeWs | null;
  factory: (url: string) => WebSocket;
}

function makeFactory(): FactoryHandle {
  const ref: { ws: FakeWs | null } = { ws: null };
  const handle: FactoryHandle = {
    get ws() {
      return ref.ws;
    },
    set ws(v) {
      ref.ws = v;
    },
    factory(url: string): WebSocket {
      ref.ws = new FakeWs(url);
      return ref.ws as unknown as WebSocket;
    },
  };
  return handle;
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

async function drainStream(audio$: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  const reader = audio$.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return chunks;
}

// -------------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------------

describe("streamTextToSpeech (server copy)", () => {
  it("default modelId in the URL is eleven_flash_v2_5", () => {
    const f = makeFactory();
    const text$ = new ReadableStream<string>({ start(c) { c.close(); } });
    streamTextToSpeech({ voiceId: "test-voice", text$, apiKey: "key", wsFactory: f.factory });
    expect(f.ws?.url).toContain("eleven_flash_v2_5");
  });

  it("first sent message primes with xi_api_key and single-space text", async () => {
    const f = makeFactory();
    const text$ = new ReadableStream<string>({ start(c) { c.close(); } });
    const audio$ = streamTextToSpeech({
      voiceId: "test-voice",
      text$,
      apiKey: "my-api-key",
      wsFactory: f.factory,
    });
    await drainStream(audio$);
    const first = f.ws!.sent[0];
    expect(first).toBeDefined();
    expect(first.parsed?.["xi_api_key"]).toBe("my-api-key");
    expect(first.parsed?.["text"]).toBe(" ");
  });

  it("text chunks are forwarded with try_trigger_generation: true", async () => {
    const f = makeFactory();
    const text$ = new ReadableStream<string>({
      start(c) {
        c.enqueue("Hello.");
        c.enqueue(" How are you?");
        c.close();
      },
    });
    const audio$ = streamTextToSpeech({
      voiceId: "test-voice",
      text$,
      apiKey: "key",
      wsFactory: f.factory,
    });
    await drainStream(audio$);
    // Messages after the prime: text chunks + the empty-text closing marker
    const textChunks = f.ws!.sent.filter(
      (m) => m.parsed?.["text"] !== " " && m.parsed?.["text"] !== "",
    );
    expect(textChunks.length).toBeGreaterThan(0);
    for (const msg of textChunks) {
      expect(msg.parsed?.["try_trigger_generation"]).toBe(true);
    }
  });

  it("a string message with audio enqueues decoded bytes", async () => {
    const f = makeFactory();
    const text$ = new ReadableStream<string>({
      start(c) {
        c.enqueue("Chunk.");
        c.close();
      },
    });
    const audio$ = streamTextToSpeech({
      voiceId: "test-voice",
      text$,
      apiKey: "key",
      wsFactory: f.factory,
    });
    const chunks = await drainStream(audio$);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]).toBeInstanceOf(Uint8Array);
    // Stub encodes [0xaa, 0xbb]
    expect(Array.from(chunks[0])).toEqual([0xaa, 0xbb]);
  });

  it("isFinal: true closes the stream", async () => {
    const f = makeFactory();
    const text$ = new ReadableStream<string>({
      start(c) {
        c.enqueue("Sentence.");
        c.close();
      },
    });
    const audio$ = streamTextToSpeech({
      voiceId: "test-voice",
      text$,
      apiKey: "key",
      wsFactory: f.factory,
    });
    // drainStream resolves only when the ReadableStream closes
    await expect(drainStream(audio$)).resolves.toBeDefined();
  });

  it("accepts a custom modelId and puts it in the URL", () => {
    const f = makeFactory();
    const text$ = new ReadableStream<string>({ start(c) { c.close(); } });
    streamTextToSpeech({
      voiceId: "test-voice",
      text$,
      apiKey: "key",
      modelId: "eleven_turbo_v2_5",
      wsFactory: f.factory,
    });
    expect(f.ws?.url).toContain("eleven_turbo_v2_5");
    expect(f.ws?.url).not.toContain("eleven_flash_v2_5");
  });
});
