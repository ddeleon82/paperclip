import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  createGatewaySocket,
  decodeServerBinary,
  encodeAudioFrame,
} from "./useVoiceGatewaySocket";

// ---------------------------------------------------------------------------
// Minimal mock WebSocket
// ---------------------------------------------------------------------------

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  url: string;
  binaryType: BinaryType = "blob";
  readyState: number = 0; // CONNECTING

  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  sent: unknown[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: unknown) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3; // CLOSED
  }

  // Test helpers
  simulateOpen() {
    this.readyState = 1; // OPEN
    this.onopen?.(new Event("open"));
  }

  simulateClose(opts?: { code?: number; reason?: string; wasClean?: boolean }) {
    this.readyState = 3;
    // Node.js doesn't have CloseEvent; use a plain object that satisfies the shape
    const ev = {
      type: "close",
      code: opts?.code ?? 1006,
      reason: opts?.reason ?? "",
      wasClean: opts?.wasClean ?? false,
    } as CloseEvent;
    this.onclose?.(ev);
  }

  simulateTextMessage(data: string) {
    const ev = new MessageEvent("message", { data });
    this.onmessage?.(ev);
  }

  simulateBinaryMessage(data: ArrayBuffer) {
    const ev = new MessageEvent("message", { data });
    this.onmessage?.(ev);
  }
}

// ---------------------------------------------------------------------------
// Build helpers
// ---------------------------------------------------------------------------

/** Build a 4-byte big-endian seq + payload ArrayBuffer. */
function buildBinaryFrame(seq: number, payload: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(4 + payload.byteLength);
  const view = new DataView(buf);
  view.setUint32(0, seq, false); // big-endian
  new Uint8Array(buf, 4).set(payload);
  return buf;
}

function makeCallbacks() {
  return {
    onServerMessage: vi.fn(),
    onAudioFrame: vi.fn(),
    onOpen: vi.fn(),
    onClose: vi.fn(),
    onStateChange: vi.fn(),
  };
}

const wsFactory = (url: string) => new MockWebSocket(url) as unknown as WebSocket;

// ---------------------------------------------------------------------------
// Tests for the pure decode/encode helpers
// ---------------------------------------------------------------------------

describe("decodeServerBinary", () => {
  it("decodes seq (u32 BE) and payload bytes correctly", () => {
    const payload = new Uint8Array([10, 20, 30]);
    const frame = buildBinaryFrame(42, payload);
    const result = decodeServerBinary(frame);
    expect(result.seq).toBe(42);
    expect(Array.from(result.bytes)).toEqual([10, 20, 30]);
  });

  it("handles empty payload", () => {
    const frame = buildBinaryFrame(0, new Uint8Array(0));
    const result = decodeServerBinary(frame);
    expect(result.seq).toBe(0);
    expect(result.bytes.byteLength).toBe(0);
  });

  it("handles large seq number", () => {
    const frame = buildBinaryFrame(0xffffffff, new Uint8Array([1]));
    const result = decodeServerBinary(frame);
    expect(result.seq).toBe(0xffffffff);
  });
});

describe("encodeAudioFrame", () => {
  it("encodes PCM16 with seq=0 header", () => {
    const pcm = new Int16Array([100, -200, 300]);
    const buf = encodeAudioFrame(pcm);
    const view = new DataView(buf);
    expect(view.getUint32(0, false)).toBe(0); // seq is 0
    expect(buf.byteLength).toBe(4 + pcm.byteLength);
  });
});

// ---------------------------------------------------------------------------
// createGatewaySocket tests
// ---------------------------------------------------------------------------

describe("createGatewaySocket", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends start message immediately on open", () => {
    const callbacks = makeCallbacks();
    createGatewaySocket({
      url: "ws://localhost/api/voice/live?companyId=co1",
      agentId: "ag1",
      callbacks,
      wsFactory,
    });

    expect(MockWebSocket.instances).toHaveLength(1);
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();

    expect(ws.sent).toHaveLength(1);
    const msg = JSON.parse(ws.sent[0] as string) as { type: string; agentId: string };
    expect(msg.type).toBe("start");
    expect(msg.agentId).toBe("ag1");
  });

  it("dispatches text messages to onServerMessage", () => {
    const callbacks = makeCallbacks();
    createGatewaySocket({
      url: "ws://localhost/api/voice/live?companyId=co1",
      agentId: "ag1",
      callbacks,
      wsFactory,
    });

    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateTextMessage(JSON.stringify({ type: "ready", sessionId: "sess-1" }));
    expect(callbacks.onServerMessage).toHaveBeenCalledWith({
      type: "ready",
      sessionId: "sess-1",
    });
  });

  it("dispatches binary frames to onAudioFrame", () => {
    const callbacks = makeCallbacks();
    createGatewaySocket({
      url: "ws://localhost/api/voice/live?companyId=co1",
      agentId: "ag1",
      callbacks,
      wsFactory,
    });

    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();

    const payload = new Uint8Array([1, 2, 3]);
    ws.simulateBinaryMessage(buildBinaryFrame(7, payload));

    expect(callbacks.onAudioFrame).toHaveBeenCalledTimes(1);
    const [seq, bytes] = callbacks.onAudioFrame.mock.calls[0] as [number, Uint8Array];
    expect(seq).toBe(7);
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
  });

  it("reconnects with backoff on unexpected close", async () => {
    const callbacks = makeCallbacks();
    createGatewaySocket({
      url: "ws://localhost/api/voice/live?companyId=co1",
      agentId: "ag1",
      callbacks,
      wsFactory,
    });

    const ws1 = MockWebSocket.instances[0];
    ws1.simulateOpen();
    ws1.simulateClose({ wasClean: false }); // unexpected close

    // 1st reconnect after 1s
    await vi.advanceTimersByTimeAsync(1000);
    expect(MockWebSocket.instances).toHaveLength(2);

    const ws2 = MockWebSocket.instances[1];
    ws2.simulateOpen();
    ws2.simulateClose({ wasClean: false }); // unexpected close again

    // 2nd reconnect after 2s
    await vi.advanceTimersByTimeAsync(2000);
    expect(MockWebSocket.instances).toHaveLength(3);
  });

  it("sends start first then flushes buffered audio on reconnect", async () => {
    const callbacks = makeCallbacks();
    const handle = createGatewaySocket({
      url: "ws://localhost/api/voice/live?companyId=co1",
      agentId: "ag1",
      callbacks,
      wsFactory,
    });

    const ws1 = MockWebSocket.instances[0];
    ws1.simulateOpen();
    ws1.simulateClose({ wasClean: false });

    // While reconnecting, buffer some audio
    const pcm = new Int16Array([100, 200, 300]);
    handle.sendAudio(pcm);

    await vi.advanceTimersByTimeAsync(1000);
    const ws2 = MockWebSocket.instances[1];
    ws2.simulateOpen();

    // First message must be start, then buffered audio
    expect(ws2.sent.length).toBeGreaterThanOrEqual(2);
    const first = JSON.parse(ws2.sent[0] as string) as { type: string };
    expect(first.type).toBe("start");
    // Second should be an ArrayBuffer (audio)
    expect(ws2.sent[1]).toBeInstanceOf(ArrayBuffer);
  });

  it("URL is passed through to the WebSocket factory", () => {
    const callbacks = makeCallbacks();
    createGatewaySocket({
      url: "ws://localhost/api/voice/live?companyId=my-company-123",
      agentId: "ag1",
      callbacks,
      wsFactory,
    });
    expect(MockWebSocket.instances[0].url).toContain("my-company-123");
  });

  it("state transitions: idle -> connecting -> open -> reconnecting on unexpected close", async () => {
    const states: string[] = [];
    const callbacks = makeCallbacks();
    callbacks.onStateChange = vi.fn((s: string) => states.push(s));

    createGatewaySocket({
      url: "ws://localhost/api/voice/live?companyId=co1",
      agentId: "ag1",
      callbacks,
      wsFactory,
    });

    const ws = MockWebSocket.instances[0];
    expect(states).toContain("connecting");
    ws.simulateOpen();
    expect(states).toContain("open");
    ws.simulateClose({ wasClean: false });
    expect(states).toContain("reconnecting");
  });

  it("state goes to closed after max retries exceeded (never opens successfully)", async () => {
    const states: string[] = [];
    const callbacks = makeCallbacks();
    callbacks.onStateChange = vi.fn((s: string) => states.push(s));

    // Override wsFactory so connections never successfully open — they just fail
    // immediately with an unexpected close. This exhausts the 3-entry BACKOFF_MS.
    const neverOpenFactory = (url: string) => {
      const ws = new MockWebSocket(url) as unknown as WebSocket;
      return ws;
    };

    createGatewaySocket({
      url: "ws://localhost/api/voice/live?companyId=co1",
      agentId: "ag1",
      callbacks,
      wsFactory: neverOpenFactory,
    });

    // ws[0] created by connect(). Immediately close without opening → retry
    MockWebSocket.instances[0].simulateClose({ wasClean: false }); // attempt 0 → retry after 1s
    await vi.advanceTimersByTimeAsync(1000);
    MockWebSocket.instances[1].simulateClose({ wasClean: false }); // attempt 1 → retry after 2s
    await vi.advanceTimersByTimeAsync(2000);
    MockWebSocket.instances[2].simulateClose({ wasClean: false }); // attempt 2 → retry after 4s
    await vi.advanceTimersByTimeAsync(4000);
    // attempt 3 = BACKOFF_MS.length → no more retries → "closed"
    MockWebSocket.instances[3].simulateClose({ wasClean: false });

    expect(states).toContain("closed");
    expect(callbacks.onClose).toHaveBeenCalledWith("error");
  });

  it("destroy() stops reconnect timer and closes socket", async () => {
    const callbacks = makeCallbacks();
    const handle = createGatewaySocket({
      url: "ws://localhost/api/voice/live?companyId=co1",
      agentId: "ag1",
      callbacks,
      wsFactory,
    });

    const ws1 = MockWebSocket.instances[0];
    ws1.simulateOpen();
    ws1.simulateClose({ wasClean: false }); // triggers reconnect timer

    handle.destroy();
    // After destroy, timer is cleared — no new WS should be created
    await vi.advanceTimersByTimeAsync(5000);
    expect(MockWebSocket.instances).toHaveLength(1); // only the original
  });

  it("audio beyond buffer limit drops oldest frames", () => {
    const callbacks = makeCallbacks();
    const handle = createGatewaySocket({
      url: "ws://localhost/api/voice/live?companyId=co1",
      agentId: "ag1",
      callbacks,
      wsFactory,
    });

    const ws1 = MockWebSocket.instances[0];
    ws1.simulateOpen();
    ws1.simulateClose({ wasClean: false }); // now reconnecting

    // Send 25 frames (5 beyond the 20-frame limit)
    for (let i = 0; i < 25; i++) {
      handle.sendAudio(new Int16Array([i]));
    }

    // On reconnect, only 20 frames should be flushed
    vi.advanceTimersByTime(1000);
    const ws2 = MockWebSocket.instances[1];
    ws2.simulateOpen();

    // 1 start + ≤20 audio frames
    const audioFrameCount = ws2.sent.filter((s) => s instanceof ArrayBuffer).length;
    expect(audioFrameCount).toBeLessThanOrEqual(20);
  });
});
