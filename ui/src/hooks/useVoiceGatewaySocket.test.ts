import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  useVoiceGatewaySocket,
  decodeServerBinary,
} from "./useVoiceGatewaySocket";

// ---------------------------------------------------------------------------
// Minimal mock WebSocket
// ---------------------------------------------------------------------------

type WsEvent = "open" | "close" | "message" | "error";

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
    const ev = new CloseEvent("close", {
      code: opts?.code ?? 1006,
      reason: opts?.reason ?? "",
      wasClean: opts?.wasClean ?? false,
    });
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
// Helpers
// ---------------------------------------------------------------------------

/** Build a 4-byte big-endian seq + payload ArrayBuffer. */
function buildBinaryFrame(seq: number, payload: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(4 + payload.byteLength);
  const view = new DataView(buf);
  view.setUint32(0, seq, false); // big-endian
  new Uint8Array(buf, 4).set(payload);
  return buf;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------
// Tests for the pure decode helper
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

// ---------------------------------------------------------------------------
// Hook tests via wsFactory injection
// ---------------------------------------------------------------------------

describe("useVoiceGatewaySocket", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createCallbacks() {
    return {
      onServerMessage: vi.fn(),
      onAudioFrame: vi.fn(),
      onOpen: vi.fn(),
      onClose: vi.fn(),
    };
  }

  it("sends start message immediately on open", () => {
    const callbacks = createCallbacks();
    useVoiceGatewaySocket({
      companyId: "co1",
      agentId: "ag1",
      enabled: true,
      callbacks,
      wsFactory: (url) => new MockWebSocket(url) as unknown as WebSocket,
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
    const callbacks = createCallbacks();
    useVoiceGatewaySocket({
      companyId: "co1",
      agentId: "ag1",
      enabled: true,
      callbacks,
      wsFactory: (url) => new MockWebSocket(url) as unknown as WebSocket,
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
    const callbacks = createCallbacks();
    useVoiceGatewaySocket({
      companyId: "co1",
      agentId: "ag1",
      enabled: true,
      callbacks,
      wsFactory: (url) => new MockWebSocket(url) as unknown as WebSocket,
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
    const callbacks = createCallbacks();
    useVoiceGatewaySocket({
      companyId: "co1",
      agentId: "ag1",
      enabled: true,
      callbacks,
      wsFactory: (url) => new MockWebSocket(url) as unknown as WebSocket,
    });

    expect(MockWebSocket.instances).toHaveLength(1);
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
    const callbacks = createCallbacks();
    const { sendAudio } = useVoiceGatewaySocket({
      companyId: "co1",
      agentId: "ag1",
      enabled: true,
      callbacks,
      wsFactory: (url) => new MockWebSocket(url) as unknown as WebSocket,
    });

    const ws1 = MockWebSocket.instances[0];
    ws1.simulateOpen();
    ws1.simulateClose({ wasClean: false });

    // While reconnecting, buffer some audio
    const pcm = new Int16Array([100, 200, 300]);
    sendAudio(pcm);

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

  it("URL includes companyId", () => {
    const callbacks = createCallbacks();
    useVoiceGatewaySocket({
      companyId: "my-company-123",
      agentId: "ag1",
      enabled: true,
      callbacks,
      wsFactory: (url) => new MockWebSocket(url) as unknown as WebSocket,
    });
    expect(MockWebSocket.instances[0].url).toContain("my-company-123");
  });

  it("does not connect when enabled=false", () => {
    const callbacks = createCallbacks();
    useVoiceGatewaySocket({
      companyId: "co1",
      agentId: "ag1",
      enabled: false,
      callbacks,
      wsFactory: (url) => new MockWebSocket(url) as unknown as WebSocket,
    });
    expect(MockWebSocket.instances).toHaveLength(0);
  });
});
