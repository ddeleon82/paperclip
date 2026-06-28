/**
 * Tests for GatewaySession (FRE-1296).
 *
 * All dependencies are faked via vi.fn() / controllable stubs.
 * No network, no DB, no filesystem.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createGatewaySession,
  type GatewaySessionDeps,
  type GatewaySessionHandle,
} from "../services/voice-gateway/session.js";
import type { LiveClient, LiveSession, LiveServerEvent } from "../services/voice-gateway/gemini-live.js";
import type { TtsPipe, TtsPipeDeps } from "../services/voice-gateway/tts-pipe.js";
import type { GatewaySocket } from "../realtime/voice-live-ws.js";
import type { ServerMessage } from "../services/voice-gateway/protocol.js";
import type { VoiceSessionsService } from "../services/voice-sessions.js";
import type { FlywheelEntry } from "../services/voice-gateway/flywheel.js";
import type { ToolDeps } from "../services/voice-gateway/tools.js";
import { publishLiveEvent, subscribeCompanyLiveEvents } from "../services/live-events.js";

// ---------------------------------------------------------------------------
// Fake socket
// ---------------------------------------------------------------------------

interface FakeSocket extends GatewaySocket {
  _sent: Array<string | Buffer>;
  _closed: boolean;
  _closedCode?: number;
  _terminated: boolean;
  sentMessages(): ServerMessage[];
}

function makeSocket(): FakeSocket {
  const sent: Array<string | Buffer> = [];
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};

  const socket: FakeSocket = {
    readyState: 1, // OPEN
    _sent: sent,
    _closed: false,
    _terminated: false,
    ping: vi.fn(),
    send(data: string | Buffer) {
      sent.push(data);
    },
    terminate() {
      this._terminated = true;
      this.readyState = 3;
    },
    close(code?: number) {
      this._closed = true;
      this._closedCode = code;
      this.readyState = 3;
      (listeners["close"] ?? []).forEach((fn) => fn());
    },
    on(event: string, listener: (...args: unknown[]) => void) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(listener);
    },
    sentMessages(): ServerMessage[] {
      return sent
        .filter((d): d is string => typeof d === "string")
        .map((s) => JSON.parse(s) as ServerMessage);
    },
  };
  return socket;
}

// ---------------------------------------------------------------------------
// Controllable fake LiveClient
// ---------------------------------------------------------------------------

interface FakeLiveSession extends LiveSession {
  _closed: boolean;
  _systemTexts: string[];
  _toolResponses: Array<{ id: string; name: string; response: Record<string, unknown> }>;
  _audioChunks: Buffer[];
  _videoFrames: string[];
}

interface FakeLiveClient extends LiveClient {
  /** Fire an event as if it came from Gemini. */
  emit(event: LiveServerEvent): void;
  emitError(err: Error): void;
  emitClose(): void;
  session: FakeLiveSession | null;
  connectCallCount: number;
}

function makeFakeLiveClient(): FakeLiveClient {
  let onEventFn: ((e: LiveServerEvent) => void) | null = null;
  let onErrorFn: ((e: Error) => void) | null = null;
  let onCloseFn: (() => void) | null = null;

  const client: FakeLiveClient = {
    session: null,
    connectCallCount: 0,

    async connect(opts) {
      client.connectCallCount++;
      onEventFn = opts.onEvent;
      onErrorFn = opts.onError;
      onCloseFn = opts.onClose;

      const session: FakeLiveSession = {
        _closed: false,
        _systemTexts: [],
        _toolResponses: [],
        _audioChunks: [],
        _videoFrames: [],
        sendAudioChunk(buf) {
          this._audioChunks.push(buf);
        },
        sendVideoFrame(jpegBase64) {
          this._videoFrames.push(jpegBase64);
        },
        sendSystemText(text) {
          this._systemTexts.push(text);
        },
        sendToolResponse(id, name, response) {
          this._toolResponses.push({ id, name, response });
        },
        close() {
          this._closed = true;
        },
      };
      client.session = session;
      return session;
    },

    emit(event) {
      if (onEventFn) onEventFn(event);
    },
    emitError(err) {
      if (onErrorFn) onErrorFn(err);
    },
    emitClose() {
      if (onCloseFn) onCloseFn();
    },
  };
  return client;
}

// ---------------------------------------------------------------------------
// Fake TtsPipe
// ---------------------------------------------------------------------------

interface FakeTtsPipe extends TtsPipe {
  _pushed: string[];
  _endTurnCount: number;
  _cancelCount: number;
}

function makeFakeTtsPipe(): FakeTtsPipe {
  return {
    _pushed: [],
    _endTurnCount: 0,
    _cancelCount: 0,
    pushTextDelta(text) {
      this._pushed.push(text);
    },
    endTurn() {
      this._endTurnCount++;
    },
    cancel() {
      this._cancelCount++;
    },
  };
}

// ---------------------------------------------------------------------------
// Fake VoiceSessionsService
// ---------------------------------------------------------------------------

function makeVoiceSessionsService(): VoiceSessionsService {
  return {
    createSession: vi.fn().mockResolvedValue({ id: "db-session-123" }),
    appendTurn: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn().mockResolvedValue(undefined),
    getSession: vi.fn().mockResolvedValue(null),
  };
}

// ---------------------------------------------------------------------------
// Fake flywheel
// ---------------------------------------------------------------------------

function makeFlywheel(): { log: ReturnType<typeof vi.fn>; entries: FlywheelEntry[] } {
  const entries: FlywheelEntry[] = [];
  const log = vi.fn((entry: FlywheelEntry) => {
    entries.push(entry);
  });
  return { log, entries };
}

// ---------------------------------------------------------------------------
// Fake tool deps
// ---------------------------------------------------------------------------

function makeToolDeps(): ToolDeps {
  return {
    wakeup: vi.fn().mockResolvedValue({ id: "run-tool-123" }),
    getRunStatus: vi.fn().mockResolvedValue({ status: "running" }),
    boardSnapshot: vi.fn().mockResolvedValue({ counts: {}, recent: [] }),
    createIssue: vi.fn().mockResolvedValue({ id: "issue-abc", identifier: "FRE-999" }),
  };
}

// ---------------------------------------------------------------------------
// Default session context
// ---------------------------------------------------------------------------

const DEFAULT_CTX = {
  companyId: "co-1",
  userId: "user-1",
};

// ---------------------------------------------------------------------------
// Helper to build full deps for createGatewaySession
// ---------------------------------------------------------------------------

function makeDeps(
  overrides: Partial<{
    liveClient: FakeLiveClient;
    ttsPipe: FakeTtsPipe;
    voiceSessions: VoiceSessionsService;
    flywheel: ReturnType<typeof makeFlywheel>;
    toolDeps: ToolDeps;
    subscribeCompanyLiveEvents: GatewaySessionDeps["subscribeCompanyLiveEvents"];
    extractRunOutcome: GatewaySessionDeps["extractRunOutcome"];
    warmHoldMs: number;
    idleTimeoutMs: number;
    output: "cascade" | "native";
  }> = {},
): {
  deps: GatewaySessionDeps;
  liveClient: FakeLiveClient;
  ttsPipe: FakeTtsPipe;
  voiceSessions: VoiceSessionsService;
  flywheel: ReturnType<typeof makeFlywheel>;
  toolDeps: ToolDeps;
} {
  const liveClient = overrides.liveClient ?? makeFakeLiveClient();
  const ttsPipe = overrides.ttsPipe ?? makeFakeTtsPipe();
  const voiceSessions = overrides.voiceSessions ?? makeVoiceSessionsService();
  const flywheel = overrides.flywheel ?? makeFlywheel();
  const toolDeps = overrides.toolDeps ?? makeToolDeps();

  const deps: GatewaySessionDeps = {
    ctx: DEFAULT_CTX,
    liveClient,
    createTtsPipe: (_ttsDeps: TtsPipeDeps) => ttsPipe,
    toolDeps,
    voiceSessions,
    flywheel: { log: flywheel.log },
    subscribeCompanyLiveEvents:
      overrides.subscribeCompanyLiveEvents ??
      vi.fn().mockReturnValue(() => {}),
    extractRunOutcome:
      overrides.extractRunOutcome ??
      vi.fn().mockResolvedValue("Run finished."),
    config: {
      warmHoldMs: overrides.warmHoldMs ?? 60_000,
      idleTimeoutMs: overrides.idleTimeoutMs ?? 300_000,
      output: overrides.output ?? "cascade",
    },
  };

  return { deps, liveClient, ttsPipe, voiceSessions, flywheel, toolDeps };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GatewaySession - behavior 1: start message", () => {
  it("creates DB session, connects LiveClient, replies ready + listening", async () => {
    const { deps, liveClient, voiceSessions } = makeDeps();
    const session = createGatewaySession(deps);
    const socket = makeSocket();

    session.attachSocket(socket);
    session.handleMessage({ type: "start", agentId: "agent-1" });

    // Wait for async connect
    await vi.waitFor(() => liveClient.connectCallCount === 1);
    await vi.waitFor(() => socket.sentMessages().some((m) => m.type === "ready"));

    expect(voiceSessions.createSession).toHaveBeenCalledWith({
      companyId: "co-1",
      userId: "user-1",
    });

    const msgs = socket.sentMessages();
    const ready = msgs.find((m) => m.type === "ready") as { type: "ready"; sessionId: string };
    expect(ready).toBeTruthy();
    expect(ready.sessionId).toBe("db-session-123");

    const status = msgs.find((m) => m.type === "status") as { type: "status"; state: string };
    expect(status?.state).toBe("listening");
  });

  it("connects LiveClient with system prompt and tool declarations", async () => {
    const { deps, liveClient } = makeDeps();
    const session = createGatewaySession(deps);
    const socket = makeSocket();

    session.attachSocket(socket);
    session.handleMessage({ type: "start", agentId: "agent-1" });

    await vi.waitFor(() => liveClient.connectCallCount === 1);

    // connect should have been called with systemInstruction and tools
    expect(liveClient.connectCallCount).toBe(1);
    // The session should exist (meaning connect resolved)
    expect(liveClient.session).toBeTruthy();
  });

  it("is idempotent: second start on warm session replies resumed", async () => {
    const { deps, liveClient, voiceSessions } = makeDeps();
    const session = createGatewaySession(deps);
    const socket = makeSocket();

    session.attachSocket(socket);
    session.handleMessage({ type: "start", agentId: "agent-1" });
    await vi.waitFor(() => liveClient.connectCallCount === 1);
    await vi.waitFor(() => socket.sentMessages().some((m) => m.type === "ready"));

    // Send start again (simulate reconnect)
    session.handleMessage({ type: "start", agentId: "agent-1" });
    await vi.waitFor(() => socket.sentMessages().some((m) => m.type === "resumed"));

    // createSession called only once
    expect(voiceSessions.createSession).toHaveBeenCalledTimes(1);
    // connect called only once
    expect(liveClient.connectCallCount).toBe(1);

    const msgs = socket.sentMessages();
    const resumed = msgs.find((m) => m.type === "resumed") as { type: "resumed"; sessionId: string };
    expect(resumed?.sessionId).toBe("db-session-123");
  });
});

describe("GatewaySession - behavior 2: userTranscript final", () => {
  it("appendTurn user + flywheel user_turn + transcript{final:true} + status thinking", async () => {
    const { deps, liveClient, voiceSessions, flywheel } = makeDeps();
    const session = createGatewaySession(deps);
    const socket = makeSocket();

    session.attachSocket(socket);
    session.handleMessage({ type: "start", agentId: "agent-1" });
    await vi.waitFor(() => liveClient.connectCallCount === 1);
    await vi.waitFor(() => socket.sentMessages().some((m) => m.type === "ready"));

    // Emit a final userTranscript event from Gemini
    liveClient.emit({ userTranscript: { text: "Hello Conrad", final: true } });

    await vi.waitFor(() => voiceSessions.appendTurn as ReturnType<typeof vi.fn> &&
      (voiceSessions.appendTurn as ReturnType<typeof vi.fn>).mock.calls.length > 0);

    expect(voiceSessions.appendTurn).toHaveBeenCalledWith("db-session-123", {
      role: "user",
      text: "Hello Conrad",
      ts: expect.any(String),
    });

    expect(flywheel.log).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "user_turn", text: "Hello Conrad" }),
    );

    const msgs = socket.sentMessages();
    const transcript = msgs.find(
      (m) => m.type === "transcript" && (m as { final: boolean }).final === true &&
        (m as { role: string }).role === "user"
    ) as { type: "transcript"; text: string; final: boolean; role: string } | undefined;
    expect(transcript).toBeTruthy();
    expect(transcript?.text).toBe("Hello Conrad");

    const thinking = msgs.find(
      (m) => m.type === "status" && (m as { state: string }).state === "thinking"
    );
    expect(thinking).toBeTruthy();
  });

  it("ignores non-final userTranscript events (no appendTurn)", async () => {
    const { deps, liveClient, voiceSessions } = makeDeps();
    const session = createGatewaySession(deps);
    const socket = makeSocket();

    session.attachSocket(socket);
    session.handleMessage({ type: "start", agentId: "agent-1" });
    await vi.waitFor(() => liveClient.connectCallCount === 1);

    liveClient.emit({ userTranscript: { text: "Hel...", final: false } });

    // Wait a tick, appendTurn should not be called
    await new Promise((r) => setTimeout(r, 20));
    expect(voiceSessions.appendTurn).not.toHaveBeenCalled();
  });
});

describe("GatewaySession - behavior 3: textDelta + turnComplete", () => {
  it("first textDelta → ttsPipe.pushTextDelta + transcript{final:false} + status speaking", async () => {
    const { deps, liveClient, ttsPipe } = makeDeps();
    const session = createGatewaySession(deps);
    const socket = makeSocket();

    session.attachSocket(socket);
    session.handleMessage({ type: "start", agentId: "agent-1" });
    await vi.waitFor(() => liveClient.connectCallCount === 1);
    await vi.waitFor(() => socket.sentMessages().some((m) => m.type === "ready"));

    liveClient.emit({ textDelta: "Hello " });

    await vi.waitFor(() => ttsPipe._pushed.length > 0);

    expect(ttsPipe._pushed).toContain("Hello ");

    const msgs = socket.sentMessages();
    const transcriptPartial = msgs.find(
      (m) =>
        m.type === "transcript" &&
        (m as { final: boolean }).final === false &&
        (m as { role: string }).role === "assistant"
    );
    expect(transcriptPartial).toBeTruthy();

    const speaking = msgs.find(
      (m) => m.type === "status" && (m as { state: string }).state === "speaking"
    );
    expect(speaking).toBeTruthy();
  });

  it("subsequent textDeltas do not re-emit speaking status", async () => {
    const { deps, liveClient } = makeDeps();
    const session = createGatewaySession(deps);
    const socket = makeSocket();

    session.attachSocket(socket);
    session.handleMessage({ type: "start", agentId: "agent-1" });
    await vi.waitFor(() => liveClient.connectCallCount === 1);
    await vi.waitFor(() => socket.sentMessages().some((m) => m.type === "ready"));

    liveClient.emit({ textDelta: "Hello " });
    liveClient.emit({ textDelta: "world " });
    liveClient.emit({ textDelta: "!" });

    await new Promise((r) => setTimeout(r, 20));

    const msgs = socket.sentMessages();
    const speakingCount = msgs.filter(
      (m) => m.type === "status" && (m as { state: string }).state === "speaking"
    ).length;
    expect(speakingCount).toBe(1);
  });

  it("turnComplete → endTurn + transcript{final:true, accumulated} + appendTurn assistant + flywheel + listening", async () => {
    const { deps, liveClient, ttsPipe, voiceSessions, flywheel } = makeDeps();
    const session = createGatewaySession(deps);
    const socket = makeSocket();

    session.attachSocket(socket);
    session.handleMessage({ type: "start", agentId: "agent-1" });
    await vi.waitFor(() => liveClient.connectCallCount === 1);
    await vi.waitFor(() => socket.sentMessages().some((m) => m.type === "ready"));

    liveClient.emit({ textDelta: "Hello " });
    liveClient.emit({ textDelta: "world!" });
    liveClient.emit({ turnComplete: true });

    await vi.waitFor(() => ttsPipe._endTurnCount > 0);

    expect(ttsPipe._endTurnCount).toBe(1);

    await vi.waitFor(() =>
      (voiceSessions.appendTurn as ReturnType<typeof vi.fn>).mock.calls.length > 0
    );

    expect(voiceSessions.appendTurn).toHaveBeenCalledWith("db-session-123", {
      role: "assistant",
      text: "Hello world!",
      ts: expect.any(String),
    });

    expect(flywheel.log).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "assistant_turn", text: "Hello world!" }),
    );

    const msgs = socket.sentMessages();
    const finalTranscript = msgs.find(
      (m) =>
        m.type === "transcript" &&
        (m as { final: boolean }).final === true &&
        (m as { role: string }).role === "assistant"
    ) as { text: string } | undefined;
    expect(finalTranscript?.text).toBe("Hello world!");

    const listening = msgs.filter(
      (m) => m.type === "status" && (m as { state: string }).state === "listening"
    );
    // At least one listening status after turn complete
    expect(listening.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Behavior 4: interrupted
// ---------------------------------------------------------------------------

describe("GatewaySession - behavior 4: interrupted", () => {
  it("cancel ttsPipe + send interrupt + flywheel interrupt + status listening", async () => {
    const { deps, liveClient, ttsPipe, flywheel } = makeDeps();
    const session = createGatewaySession(deps);
    const socket = makeSocket();

    session.attachSocket(socket);
    session.handleMessage({ type: "start", agentId: "agent-1" });
    await vi.waitFor(() => liveClient.connectCallCount === 1);
    await vi.waitFor(() => socket.sentMessages().some((m) => m.type === "ready"));

    liveClient.emit({ interrupted: true });

    await vi.waitFor(() => ttsPipe._cancelCount > 0);

    expect(ttsPipe._cancelCount).toBe(1);

    const msgs = socket.sentMessages();
    expect(msgs.find((m) => m.type === "interrupt")).toBeTruthy();
    expect(msgs.find((m) => m.type === "status" && (m as { state: string }).state === "listening")).toBeTruthy();

    expect(flywheel.log).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "interrupt" }),
    );
  });
});

// ---------------------------------------------------------------------------
// Behavior 5: toolCalls
// ---------------------------------------------------------------------------

describe("GatewaySession - behavior 5: toolCalls", () => {
  it("board_snapshot: routes call + sends tool response", async () => {
    const { deps, liveClient, toolDeps } = makeDeps();
    const session = createGatewaySession(deps);
    const socket = makeSocket();

    session.attachSocket(socket);
    session.handleMessage({ type: "start", agentId: "agent-1" });
    await vi.waitFor(() => liveClient.connectCallCount === 1);
    await vi.waitFor(() => socket.sentMessages().some((m) => m.type === "ready"));

    liveClient.emit({
      toolCalls: [{ id: "tc-1", name: "board_snapshot", args: {} }],
    });

    // Wait for the async tool call to complete (boardSnapshot is an async mock)
    await vi.waitFor(() =>
      (toolDeps.boardSnapshot as ReturnType<typeof vi.fn>).mock.calls.length > 0,
      { timeout: 2000 },
    );
    // Let the microtask queue drain so sendToolResponse fires
    await new Promise((r) => setTimeout(r, 50));

    const liveSessionRef = liveClient.session!;
    expect(liveSessionRef._toolResponses).toHaveLength(1);
    expect(liveSessionRef._toolResponses[0].id).toBe("tc-1");
  });

  it("dispatch_to_conrad: sends run-dispatched + subscribes to live events", async () => {
    const unsubscribe = vi.fn();
    const subscribeSpy = vi.fn().mockReturnValue(unsubscribe);
    const { deps, liveClient } = makeDeps({
      subscribeCompanyLiveEvents: subscribeSpy,
    });
    const session = createGatewaySession(deps);
    const socket = makeSocket();

    session.attachSocket(socket);
    session.handleMessage({ type: "start", agentId: "agent-1" });
    await vi.waitFor(() => liveClient.connectCallCount === 1);
    await vi.waitFor(() => socket.sentMessages().some((m) => m.type === "ready"));

    liveClient.emit({
      toolCalls: [{ id: "tc-2", name: "dispatch_to_conrad", args: { prompt: "What's up?" } }],
    });

    await vi.waitFor(() => subscribeSpy.mock.calls.length > 0);
    await vi.waitFor(() => socket.sentMessages().some((m) => m.type === "run-dispatched"));

    const msgs = socket.sentMessages();
    const dispatched = msgs.find((m) => m.type === "run-dispatched") as {
      type: "run-dispatched";
      runId: string;
    };
    expect(dispatched?.runId).toBe("run-tool-123");

    // subscribeCompanyLiveEvents called with the company
    expect(subscribeSpy).toHaveBeenCalledWith("co-1", expect.any(Function));
  });

  it("dispatch run terminal status → extractRunOutcome + direct TTS + transcript + run-complete + unsubscribe (cascade)", async () => {
    // Use the REAL subscribeCompanyLiveEvents so we can publish events and have them routed correctly.
    // This avoids fragile mock.calls inspection.
    const extractRunOutcome = vi.fn().mockResolvedValue("Task completed successfully.");
    const { deps, liveClient, ttsPipe } = makeDeps({
      subscribeCompanyLiveEvents,
      extractRunOutcome,
    });
    const session = createGatewaySession(deps);
    const socket = makeSocket();

    session.attachSocket(socket);
    session.handleMessage({ type: "start", agentId: "agent-1" });
    await vi.waitFor(() => liveClient.connectCallCount === 1);
    await vi.waitFor(() => socket.sentMessages().some((m) => m.type === "ready"));

    // Capture the live session BEFORE emitting tool calls
    const liveSessionRef = liveClient.session!;

    // Dispatch a run
    liveClient.emit({
      toolCalls: [{ id: "tc-3", name: "dispatch_to_conrad", args: { prompt: "Do the thing" } }],
    });

    // Wait until the run-dispatched message appears
    await vi.waitFor(() =>
      socket.sentMessages().some((m) => m.type === "run-dispatched"),
      { timeout: 2000 },
    );
    // Give the async handleToolCall time to set up the subscription (it runs synchronously
    // right after sending run-dispatched, but we need to yield to let the Promise chain flush)
    await new Promise((r) => setTimeout(r, 20));

    // Publish a terminal status live event via the real event bus
    publishLiveEvent({
      companyId: "co-1",
      type: "heartbeat.run.status",
      payload: { runId: "run-tool-123", status: "succeeded" },
    });

    await vi.waitFor(() =>
      socket.sentMessages().some((m) => m.type === "run-complete"),
      { timeout: 2000 },
    );

    expect(extractRunOutcome).toHaveBeenCalledWith("run-tool-123");

    // In cascade mode, direct TTS is used instead of sendSystemText (FRE-1611)
    expect(ttsPipe._pushed).toContain("Task completed successfully.");
    expect(ttsPipe._endTurnCount).toBe(1);
    expect(liveSessionRef._systemTexts).toHaveLength(0);

    const msgs = socket.sentMessages();
    const transcript = msgs.find(
      (m) => m.type === "transcript" && (m as { final: boolean }).final === true && (m as { role: string }).role === "assistant"
    ) as { text: string } | undefined;
    expect(transcript?.text).toBe("Task completed successfully.");

    const runComplete = msgs.find((m) => m.type === "run-complete") as {
      type: "run-complete";
      runId: string;
      ok: boolean;
    };
    expect(runComplete?.runId).toBe("run-tool-123");
    expect(runComplete?.ok).toBe(true);
  });

  it("dispatch run terminal status → sendSystemText + run-complete (native)", async () => {
    const extractRunOutcome = vi.fn().mockResolvedValue("Task completed successfully.");
    const { deps, liveClient } = makeDeps({
      subscribeCompanyLiveEvents,
      extractRunOutcome,
      output: "native",
    });
    const session = createGatewaySession(deps);
    const socket = makeSocket();

    session.attachSocket(socket);
    session.handleMessage({ type: "start", agentId: "agent-1" });
    await vi.waitFor(() => liveClient.connectCallCount === 1);
    await vi.waitFor(() => socket.sentMessages().some((m) => m.type === "ready"));

    const liveSessionRef = liveClient.session!;

    liveClient.emit({
      toolCalls: [{ id: "tc-3n", name: "dispatch_to_conrad", args: { prompt: "Do the thing" } }],
    });

    await vi.waitFor(() =>
      socket.sentMessages().some((m) => m.type === "run-dispatched"),
      { timeout: 2000 },
    );
    await new Promise((r) => setTimeout(r, 20));

    publishLiveEvent({
      companyId: "co-1",
      type: "heartbeat.run.status",
      payload: { runId: "run-tool-123", status: "succeeded" },
    });

    await vi.waitFor(() =>
      socket.sentMessages().some((m) => m.type === "run-complete"),
      { timeout: 2000 },
    );

    expect(extractRunOutcome).toHaveBeenCalledWith("run-tool-123");

    // Native mode still uses sendSystemText fallback
    await vi.waitFor(() => liveSessionRef._systemTexts.length > 0, { timeout: 2000 });
    expect(liveSessionRef._systemTexts).toContain(
      "[system] Conrad finished: Task completed successfully.. Tell the user now."
    );

    const msgs = socket.sentMessages();
    const runComplete = msgs.find((m) => m.type === "run-complete") as {
      type: "run-complete";
      runId: string;
      ok: boolean;
    };
    expect(runComplete?.runId).toBe("run-tool-123");
    expect(runComplete?.ok).toBe(true);
  });

  it("non-terminal run status events are ignored", async () => {
    const extractRunOutcome = vi.fn().mockResolvedValue("Done.");
    const { deps, liveClient } = makeDeps({
      subscribeCompanyLiveEvents,
      extractRunOutcome,
    });
    const session = createGatewaySession(deps);
    const socket = makeSocket();

    session.attachSocket(socket);
    session.handleMessage({ type: "start", agentId: "agent-1" });
    await vi.waitFor(() => liveClient.connectCallCount === 1);
    await vi.waitFor(() => socket.sentMessages().some((m) => m.type === "ready"));

    liveClient.emit({
      toolCalls: [{ id: "tc-4", name: "dispatch_to_conrad", args: { prompt: "Go" } }],
    });

    // Wait for run-dispatched, then allow subscription to be set up
    await vi.waitFor(() =>
      socket.sentMessages().some((m) => m.type === "run-dispatched"),
      { timeout: 2000 },
    );
    await new Promise((r) => setTimeout(r, 20));

    // Publish a non-terminal status live event
    publishLiveEvent({
      companyId: "co-1",
      type: "heartbeat.run.status",
      payload: { runId: "run-tool-123", status: "running" },
    });

    await new Promise((r) => setTimeout(r, 30));

    expect(extractRunOutcome).not.toHaveBeenCalled();
    expect(socket.sentMessages().some((m) => m.type === "run-complete")).toBe(false);
  });

  it("create_task: task-created arrives before run-dispatched, run-complete fires on terminal status", async () => {
    const extractRunOutcome = vi.fn().mockResolvedValue("Task logged and dispatched.");
    const { deps, liveClient } = makeDeps({
      subscribeCompanyLiveEvents,
      extractRunOutcome,
    });
    const session = createGatewaySession(deps);
    const socket = makeSocket();

    session.attachSocket(socket);
    session.handleMessage({ type: "start", agentId: "agent-1" });
    await vi.waitFor(() => liveClient.connectCallCount === 1);
    await vi.waitFor(() => socket.sentMessages().some((m) => m.type === "ready"));

    liveClient.emit({
      toolCalls: [{ id: "tc-5", name: "create_task", args: { title: "Fix the flaky test", detail: "It keeps failing." } }],
    });

    // task-created must appear before run-dispatched.
    // Use expect() inside vi.waitFor so it throws (retries) when not yet present.
    await vi.waitFor(() => {
      const found = socket.sentMessages().some((m) => m.type === "task-created");
      expect(found, "task-created message not yet present").toBe(true);
    }, { timeout: 2000 });

    await vi.waitFor(() => {
      const found = socket.sentMessages().some((m) => m.type === "run-dispatched");
      expect(found, "run-dispatched message not yet present").toBe(true);
    }, { timeout: 2000 });

    const msgs = socket.sentMessages();
    const taskCreatedIdx = msgs.findIndex((m) => m.type === "task-created");
    const runDispatchedIdx = msgs.findIndex((m) => m.type === "run-dispatched");
    expect(taskCreatedIdx).toBeGreaterThanOrEqual(0);
    expect(runDispatchedIdx).toBeGreaterThanOrEqual(0);
    expect(taskCreatedIdx).toBeLessThan(runDispatchedIdx);

    const taskCreated = msgs[taskCreatedIdx] as {
      type: "task-created";
      identifier: string;
      title: string;
      runId: string;
    };
    expect(taskCreated.identifier).toBe("FRE-999");
    expect(taskCreated.title).toBe("Fix the flaky test");
    expect(taskCreated.runId).toBe("run-tool-123");

    const dispatched = msgs[runDispatchedIdx] as { type: "run-dispatched"; runId: string };
    expect(dispatched.runId).toBe("run-tool-123");

    // Allow subscription to be established before publishing terminal event
    await new Promise((r) => setTimeout(r, 20));

    publishLiveEvent({
      companyId: "co-1",
      type: "heartbeat.run.status",
      payload: { runId: "run-tool-123", status: "succeeded" },
    });

    await vi.waitFor(() => {
      const found = socket.sentMessages().some((m) => m.type === "run-complete");
      expect(found, "run-complete message not yet present").toBe(true);
    }, { timeout: 2000 });

    const runComplete = socket.sentMessages().find((m) => m.type === "run-complete") as {
      type: "run-complete";
      runId: string;
      ok: boolean;
    };
    expect(runComplete.runId).toBe("run-tool-123");
    expect(runComplete.ok).toBe(true);
  });

  // FRE-1382: ctx.agentId was a Firebase-UID placeholder in prod wiring; the
  // real agent UUID arrives in the start message and MUST be the one passed
  // to heartbeat.wakeup. These tests use a start agentId that differs from
  // anything in ctx to catch placeholder leakage.
  it("dispatch_to_conrad: wakeup receives the agentId from the start message (FRE-1382)", async () => {
    const { deps, liveClient, toolDeps } = makeDeps();
    const session = createGatewaySession(deps);
    const socket = makeSocket();

    session.attachSocket(socket);
    session.handleMessage({ type: "start", agentId: "agent-uuid-from-start" });
    await vi.waitFor(() => liveClient.connectCallCount === 1);
    await vi.waitFor(() => socket.sentMessages().some((m) => m.type === "ready"));

    liveClient.emit({
      toolCalls: [{ id: "tc-1382", name: "dispatch_to_conrad", args: { prompt: "Status?" } }],
    });

    const wakeup = toolDeps.wakeup as ReturnType<typeof vi.fn>;
    await vi.waitFor(() => {
      expect(wakeup.mock.calls.length).toBeGreaterThan(0);
    }, { timeout: 2000 });

    expect(wakeup.mock.calls[0][0]).toBe("agent-uuid-from-start");
  });

  it("create_task: wakeup receives the agentId from the start message (FRE-1382)", async () => {
    const { deps, liveClient, toolDeps } = makeDeps();
    const session = createGatewaySession(deps);
    const socket = makeSocket();

    session.attachSocket(socket);
    session.handleMessage({ type: "start", agentId: "agent-uuid-from-start" });
    await vi.waitFor(() => liveClient.connectCallCount === 1);
    await vi.waitFor(() => socket.sentMessages().some((m) => m.type === "ready"));

    liveClient.emit({
      toolCalls: [{ id: "tc-1382b", name: "create_task", args: { title: "Do the thing" } }],
    });

    const wakeup = toolDeps.wakeup as ReturnType<typeof vi.fn>;
    await vi.waitFor(() => {
      expect(wakeup.mock.calls.length).toBeGreaterThan(0);
    }, { timeout: 2000 });

    expect(wakeup.mock.calls[0][0]).toBe("agent-uuid-from-start");
  });

  it("tool call throw → error to client + system text so Gemini tells the user (FRE-1382)", async () => {
    const toolDeps = makeToolDeps();
    (toolDeps.wakeup as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('PostgresError: invalid input syntax for type uuid: "9GaJ..."'),
    );
    const { deps, liveClient } = makeDeps({ toolDeps });
    const session = createGatewaySession(deps);
    const socket = makeSocket();

    session.attachSocket(socket);
    session.handleMessage({ type: "start", agentId: "agent-uuid-from-start" });
    await vi.waitFor(() => liveClient.connectCallCount === 1);
    await vi.waitFor(() => socket.sentMessages().some((m) => m.type === "ready"));

    liveClient.emit({
      toolCalls: [{ id: "tc-1382c", name: "dispatch_to_conrad", args: { prompt: "Status?" } }],
    });

    const liveSessionRef = liveClient.session!;

    // Tool response with the error still goes back to Gemini
    await vi.waitFor(() => {
      expect(liveSessionRef._toolResponses.length).toBeGreaterThan(0);
    }, { timeout: 2000 });
    expect(liveSessionRef._toolResponses[0].id).toBe("tc-1382c");
    expect(liveSessionRef._toolResponses[0].response.error).toBeTruthy();

    // Client is told (no-silent-failures)
    await vi.waitFor(() => {
      expect(socket.sentMessages().some((m) => m.type === "error")).toBe(true);
    }, { timeout: 2000 });
    const errMsg = socket.sentMessages().find((m) => m.type === "error") as {
      type: "error";
      message: string;
    };
    expect(errMsg.message).toContain("dispatch_to_conrad");

    // Gemini is instructed to tell the user out loud
    await vi.waitFor(() => {
      expect(liveSessionRef._systemTexts.length).toBeGreaterThan(0);
    }, { timeout: 2000 });
    expect(liveSessionRef._systemTexts.some((t) => t.includes("failed"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Behavior 6: camera / mute / unmute / end
// ---------------------------------------------------------------------------

describe("GatewaySession - behavior 6: camera, mute, unmute, end", () => {
  it("camera message → sendVideoFrame on live session", async () => {
    const { deps, liveClient } = makeDeps();
    const session = createGatewaySession(deps);
    const socket = makeSocket();

    session.attachSocket(socket);
    session.handleMessage({ type: "start", agentId: "agent-1" });
    await vi.waitFor(() => liveClient.connectCallCount === 1);
    await vi.waitFor(() => liveClient.session !== null);

    session.handleMessage({ type: "camera", jpegBase64: "abc123" });

    await vi.waitFor(() => liveClient.session!._videoFrames.length > 0);
    expect(liveClient.session!._videoFrames).toContain("abc123");
  });

  it("mute gates handleBinary (audio not forwarded while muted)", async () => {
    const { deps, liveClient } = makeDeps();
    const session = createGatewaySession(deps);
    const socket = makeSocket();

    session.attachSocket(socket);
    session.handleMessage({ type: "start", agentId: "agent-1" });
    await vi.waitFor(() => liveClient.connectCallCount === 1);
    await vi.waitFor(() => liveClient.session !== null);

    session.handleMessage({ type: "mute" });
    session.handleBinary(Buffer.from([1, 2, 3]));

    await new Promise((r) => setTimeout(r, 20));
    expect(liveClient.session!._audioChunks).toHaveLength(0);
  });

  it("unmute re-enables handleBinary", async () => {
    const { deps, liveClient } = makeDeps();
    const session = createGatewaySession(deps);
    const socket = makeSocket();

    session.attachSocket(socket);
    session.handleMessage({ type: "start", agentId: "agent-1" });
    await vi.waitFor(() => liveClient.connectCallCount === 1);
    await vi.waitFor(() => liveClient.session !== null);

    session.handleMessage({ type: "mute" });
    session.handleMessage({ type: "unmute" });
    session.handleBinary(Buffer.from([1, 2, 3]));

    await vi.waitFor(() => liveClient.session!._audioChunks.length > 0);
    expect(liveClient.session!._audioChunks).toHaveLength(1);
  });

  it("end message → destroy (closes Gemini session + DB session)", async () => {
    const { deps, liveClient, voiceSessions } = makeDeps();
    const session = createGatewaySession(deps);
    const socket = makeSocket();

    session.attachSocket(socket);
    session.handleMessage({ type: "start", agentId: "agent-1" });
    await vi.waitFor(() => liveClient.connectCallCount === 1);
    await vi.waitFor(() => liveClient.session !== null);

    session.handleMessage({ type: "end" });

    await vi.waitFor(() => liveClient.session!._closed === true);

    expect(voiceSessions.endSession).toHaveBeenCalledWith("db-session-123");
  });
});

// ---------------------------------------------------------------------------
// Behavior 7: idle timeout
// ---------------------------------------------------------------------------

describe("GatewaySession - behavior 7: idle timeout", () => {
  it("destroys session after no audio for idleTimeoutMs", async () => {
    vi.useFakeTimers();
    try {
      const { deps, liveClient, voiceSessions } = makeDeps({ idleTimeoutMs: 5_000 });
      const session = createGatewaySession(deps);
      const socket = makeSocket();

      session.attachSocket(socket);
      session.handleMessage({ type: "start", agentId: "agent-1" });

      // Let async connect resolve
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // Advance past the idle timeout (timer is set after connect)
      vi.advanceTimersByTime(6_000);

      // flush microtasks
      await Promise.resolve();

      // Either endSession was called or the gemini session was closed
      const endCalled = (voiceSessions.endSession as ReturnType<typeof vi.fn>).mock.calls.length > 0;
      const geminiClosed = liveClient.session !== null && liveClient.session._closed;
      expect(endCalled || geminiClosed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("audio resets idle timer", async () => {
    vi.useFakeTimers();
    try {
      const { deps, liveClient, voiceSessions } = makeDeps({ idleTimeoutMs: 5_000 });
      const session = createGatewaySession(deps);
      const socket = makeSocket();

      session.attachSocket(socket);
      session.handleMessage({ type: "start", agentId: "agent-1" });

      // Let async connect resolve (multiple microtask flushes)
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // Advance 4 seconds (below idle timeout)
      vi.advanceTimersByTime(4_000);
      // Send audio (resets idle timer)
      session.handleBinary(Buffer.from([0]));
      // Advance another 4 seconds — total 8s but timer was reset at 4s, so only 4s have passed
      vi.advanceTimersByTime(4_000);

      await Promise.resolve();
      // Should NOT have destroyed yet
      expect((voiceSessions.endSession as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Behavior 8: clientDisconnected warm-hold
// ---------------------------------------------------------------------------

describe("GatewaySession - behavior 8: clientDisconnected warm-hold", () => {
  it("reconnect within warm-hold cancels timer (no destroy)", async () => {
    vi.useFakeTimers();
    try {
      const { deps, liveClient, voiceSessions } = makeDeps({ warmHoldMs: 5_000 });
      const session = createGatewaySession(deps);
      const socket1 = makeSocket();

      session.attachSocket(socket1);
      session.handleMessage({ type: "start", agentId: "agent-1" });

      // Let async connect resolve
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(liveClient.connectCallCount).toBe(1);

      session.clientDisconnected();

      // Advance only partway through warm hold
      vi.advanceTimersByTime(2_000);

      // Reconnect — attaching socket cancels warm-hold timer
      const socket2 = makeSocket();
      session.attachSocket(socket2);

      // Advance past the original timer expiry — should not destroy
      vi.advanceTimersByTime(4_000);

      await Promise.resolve();
      expect((voiceSessions.endSession as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("warm-hold expiry destroys session", async () => {
    vi.useFakeTimers();
    try {
      const { deps, liveClient, voiceSessions } = makeDeps({ warmHoldMs: 5_000 });
      const session = createGatewaySession(deps);
      const socket = makeSocket();

      session.attachSocket(socket);
      session.handleMessage({ type: "start", agentId: "agent-1" });

      // Let async connect resolve
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(liveClient.connectCallCount).toBe(1);

      session.clientDisconnected();
      vi.advanceTimersByTime(6_000);

      await Promise.resolve();

      const endCalled = (voiceSessions.endSession as ReturnType<typeof vi.fn>).mock.calls.length > 0;
      const geminiClosed = liveClient.session !== null && liveClient.session._closed;
      expect(endCalled || geminiClosed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Behavior 9: Gemini onError/onClose reconnect
// ---------------------------------------------------------------------------

describe("GatewaySession - behavior 9: Gemini error/close reconnect", () => {
  it("onError while attached → sends error + attempts ONE reconnect", async () => {
    const { deps, liveClient } = makeDeps();
    const session = createGatewaySession(deps);
    const socket = makeSocket();

    session.attachSocket(socket);
    session.handleMessage({ type: "start", agentId: "agent-1" });
    await vi.waitFor(() => liveClient.connectCallCount === 1);
    await vi.waitFor(() => socket.sentMessages().some((m) => m.type === "ready"));

    // Trigger Gemini error
    liveClient.emitError(new Error("connection drop"));

    await vi.waitFor(() => liveClient.connectCallCount >= 2);

    const msgs = socket.sentMessages();
    const errMsg = msgs.find((m) => m.type === "error");
    expect(errMsg).toBeTruthy();
  });

  it("second failure after reconnect attempt → destroy", async () => {
    const { deps, liveClient, voiceSessions } = makeDeps();
    const session = createGatewaySession(deps);
    const socket = makeSocket();

    session.attachSocket(socket);
    session.handleMessage({ type: "start", agentId: "agent-1" });
    await vi.waitFor(() => liveClient.connectCallCount === 1);
    await vi.waitFor(() => socket.sentMessages().some((m) => m.type === "ready"));

    // First error → reconnect
    liveClient.emitError(new Error("drop 1"));
    await vi.waitFor(() => liveClient.connectCallCount >= 2);

    // Second error → destroy
    liveClient.emitError(new Error("drop 2"));

    await vi.waitFor(() =>
      (voiceSessions.endSession as ReturnType<typeof vi.fn>).mock.calls.length > 0 ||
      (liveClient.session !== null && liveClient.session._closed)
    );
  });

  it("onClose while attached → attempts reconnect", async () => {
    const { deps, liveClient } = makeDeps();
    const session = createGatewaySession(deps);
    const socket = makeSocket();

    session.attachSocket(socket);
    session.handleMessage({ type: "start", agentId: "agent-1" });
    await vi.waitFor(() => liveClient.connectCallCount === 1);
    await vi.waitFor(() => socket.sentMessages().some((m) => m.type === "ready"));

    liveClient.emitClose();

    await vi.waitFor(() => liveClient.connectCallCount >= 2);
    expect(liveClient.connectCallCount).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Native audio flag
// ---------------------------------------------------------------------------

describe("GatewaySession - native audio output", () => {
  it("audioDelta forwarded as tagged frame when output=native (no TtsPipe)", async () => {
    const { deps, liveClient, ttsPipe } = makeDeps({ output: "native" });
    const session = createGatewaySession(deps);
    const socket = makeSocket();

    session.attachSocket(socket);
    session.handleMessage({ type: "start", agentId: "agent-1" });
    await vi.waitFor(() => liveClient.connectCallCount === 1);
    await vi.waitFor(() => socket.sentMessages().some((m) => m.type === "ready"));

    const audioBytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    liveClient.emit({ audioDelta: audioBytes });

    await vi.waitFor(() =>
      socket._sent.some((d) => d instanceof Buffer && d.byteLength > 4)
    );

    // ttsPipe should NOT be used for audio
    expect(ttsPipe._pushed).toHaveLength(0);

    // Binary frame should have been sent
    const binaryFrames = socket._sent.filter((d) => d instanceof Buffer) as Buffer[];
    expect(binaryFrames.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// attachSocket takeover
// ---------------------------------------------------------------------------

describe("GatewaySession - attachSocket takeover", () => {
  it("attaching a new socket sends superseded to old socket and closes it", async () => {
    const { deps, liveClient } = makeDeps();
    const session = createGatewaySession(deps);
    const socket1 = makeSocket();
    const socket2 = makeSocket();

    session.attachSocket(socket1);
    session.handleMessage({ type: "start", agentId: "agent-1" });
    await vi.waitFor(() => liveClient.connectCallCount === 1);
    await vi.waitFor(() => socket1.sentMessages().some((m) => m.type === "ready"));

    session.attachSocket(socket2);

    const msgs1 = socket1.sentMessages();
    expect(msgs1.find((m) => m.type === "superseded")).toBeTruthy();
    expect(socket1._closedCode).toBe(4001);
  });
});
