# Voice Gateway Rip-and-Replace Implementation Plan (FRE-1296)

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the browser VAD voice pipeline with a server-side WebSocket gateway that holds a Gemini Live session per user, dispatches substantive asks to Conrad via heartbeat.wakeup, and speaks replies through ElevenLabs Flash (Kenn voice).

**Architecture:** Browser does only `getUserMedia` + a WebSocket to `/api/voice/live`. The gateway (inside the existing Express server) bridges that socket to a Gemini Live session (TEXT response mode, server-side VAD/transcription/barge-in), routes function calls (`dispatch_to_conrad`, `check_run`, `board_snapshot`), pipes Gemini text deltas through sentence splitting into ElevenLabs Flash streaming TTS, and sends tagged audio frames back down. Spec: `docs/superpowers/specs/2026-06-10-voice-gateway-rip-replace-design.md`.

**Tech Stack:** Express 5 + `ws` 8 (already installed), `@google/genai` (new dep), ElevenLabs WS streaming (existing `streamTextToSpeech` ported into server), Vite/React UI, vitest.

**Approved by Dom (comment eaff9629):** full rip, in-process gateway, Kenn cascade default, wake word "Conrad", tab-open gating v1.

**Conventions for every task:**
- Run all commands from repo root `/home/deploy/paperclip`.
- pnpm binary: `/home/deploy/.nvm/versions/node/v20.20.2/bin/pnpm` (on PATH as `pnpm` after `export PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$PATH"`).
- Server tests: `pnpm vitest run --project @paperclipai/server -t "<name>"` or by file: `pnpm vitest run --project @paperclipai/server src/__tests__/<file>.test.ts`.
- UI tests: `pnpm vitest run --project @paperclipai/ui`.
- No emdashes in any user-facing string.
- Commit after every green step, prefix `feat(voice-gateway):`, `refactor(voice):`, or `chore(voice):`.
- The dev server on this VPS is the LIVE instance (pid-managed by Dom). NEVER restart it as part of this plan; note restart-required items in the final report instead.

---

## Chunk 1: Server foundation (config, ported TTS utils, upgrade router, WS route shell)

### Task 1: Add @google/genai dependency and gateway config

**Files:**
- Modify: `server/package.json`
- Modify: `server/src/config.ts`

- [ ] **Step 1.1: Install dep**

```bash
pnpm --filter @paperclipai/server add @google/genai
```

Expected: `@google/genai` appears in `server/package.json` dependencies. Do NOT upgrade other deps.

- [ ] **Step 1.2: Read `server/src/config.ts`** to learn the existing config object shape (it loads `.env` / `PAPERCLIP_ENV_FILE_PATH` and exposes typed getters). Follow that exact pattern.

- [ ] **Step 1.3: Add a `voiceGateway` config block** with these fields (names exact):

```ts
export interface VoiceGatewayConfig {
  geminiApiKey: string | null;        // env VOICE_GATEWAY_GEMINI_API_KEY, fallback GEMINI_API_KEY
  elevenlabsApiKey: string | null;    // env VOICE_GATEWAY_ELEVENLABS_API_KEY, fallback ELEVENLABS_API_KEY
  voiceId: string;                    // env VOICE_GATEWAY_VOICE_ID, default "VjSFSNiy9sK85Z9QRu3d" (Kenn)
  liveModel: string;                  // env VOICE_GATEWAY_LIVE_MODEL, default "gemini-3.1-flash-live-preview"
  output: "cascade" | "native";       // env VOICE_GATEWAY_OUTPUT, default "cascade"; any other value coerces to "cascade"
  warmHoldMs: number;                 // env VOICE_GATEWAY_WARM_HOLD_MS, default 60_000
  idleTimeoutMs: number;              // env VOICE_GATEWAY_IDLE_TIMEOUT_MS, default 300_000
  flywheelDir: string | null;         // env VOICE_GATEWAY_FLYWHEEL_DIR, default `<instance data dir>/voice-flywheel` if a data dir is derivable from existing config, else null (logging disabled)
}
```

The gateway is **enabled iff `geminiApiKey` is non-null**. Missing ElevenLabs key with `output === "cascade"` also disables it (and logs why at startup).

- [ ] **Step 1.4: Unit-test the config logic** (`server/src/__tests__/voice-gateway-config.test.ts`, TDD: write first, watch fail): env fallback order (VOICE_GATEWAY_GEMINI_API_KEY beats GEMINI_API_KEY), output coercion (junk value -> "cascade"), enabled-iff rule (no gemini key -> disabled; cascade + no elevenlabs key -> disabled; native + no elevenlabs key -> enabled), numeric defaults. Structure the config builder as a pure function `buildVoiceGatewayConfig(env: Record<string, string | undefined>, dataDir: string | null)` so tests need no process.env mutation.

- [ ] **Step 1.5: Typecheck**: `pnpm --filter @paperclipai/server exec tsc --noEmit`. Expected: clean. Run the config test. Expected: PASS.

- [ ] **Step 1.6: Commit** `chore(voice): add @google/genai dep and voice gateway config (FRE-1296)`

### Task 2: Port sentence-buffer and elevenlabs-stream into the server

The plugin worker copies stay where they are (the `voice.speak` fallback keeps the plugin worker alive for one release). The server gets its own copies because the server cannot import plugin worker source.

**Files:**
- Create: `server/src/services/voice/sentence-buffer.ts` (byte-copy of `packages/plugins/voice-mode/src/worker/sentence-buffer.ts`, update header comment to note provenance)
- Create: `server/src/services/voice/elevenlabs-stream.ts` (copy of `packages/plugins/voice-mode/src/worker/elevenlabs-stream.ts` with ONE change: default `modelId` becomes `"eleven_flash_v2_5"`; keep `wsFactory` injection for tests. Node 20 has global `WebSocket` via undici, but the default factory MUST be `(u) => new WebSocket(u)` evaluated lazily so tests never open real sockets.)
- Create: `server/src/__tests__/voice-elevenlabs-stream.test.ts`
- Create: `server/src/__tests__/voice-sentence-buffer.test.ts` (port the existing plugin/UI sentence-buffer tests)

- [ ] **Step 2.1: Write failing tests first.** Port the assertions from `ui/src/hooks/sentence-buffer.test.ts` for the sentence buffer. For elevenlabs-stream, test with a fake `wsFactory` returning a stub WebSocket (addEventListener/send/close recorder):
  - first sent message primes with `xi_api_key` and a single space text
  - text chunks are forwarded with `try_trigger_generation: true`
  - a string message `{"audio": "<base64>", "isFinal": false}` enqueues decoded bytes
  - `isFinal: true` closes the stream
  - default modelId in the URL is `eleven_flash_v2_5`

Run: `pnpm vitest run --project @paperclipai/server src/__tests__/voice-elevenlabs-stream.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 2.2: Create the two source files.** Run both test files. Expected: PASS.

- [ ] **Step 2.3: Commit** `feat(voice-gateway): port sentence-buffer + elevenlabs flash stream into server (FRE-1296)`

### Task 3: WS upgrade router (unblocks a second WS endpoint)

**Why:** `server/src/realtime/live-events-ws.ts:236-247` binds `server.on("upgrade")` and calls `socket.destroy()` for ANY path that is not `/api/companies/:id/events/ws`. A second WS endpoint registered as another listener would race it and lose. Centralize upgrade dispatch.

**Files:**
- Create: `server/src/realtime/upgrade-router.ts`
- Modify: `server/src/realtime/live-events-ws.ts` (extract its upgrade body into a registered handler)
- Modify: the call site of `setupLiveEventsWebSocketServer` (find with `grep -rn "setupLiveEventsWebSocketServer" server/src` - likely `server/src/index.ts`)
- Create: `server/src/__tests__/upgrade-router.test.ts`

- [ ] **Step 3.1: Write failing test** for the router contract:

```ts
import { describe, expect, it, vi } from "vitest";
import { createUpgradeRouter } from "../realtime/upgrade-router.js";

function fakeSocket() {
  return { write: vi.fn(), destroy: vi.fn() };
}

describe("upgrade router", () => {
  it("dispatches to the first handler whose matcher returns a match", () => {
    const router = createUpgradeRouter();
    const handler = vi.fn();
    router.register((pathname) => (pathname === "/api/voice/live" ? {} : null), handler);
    const socket = fakeSocket();
    router.handleUpgrade({ url: "/api/voice/live?x=1" } as never, socket as never, Buffer.alloc(0));
    expect(handler).toHaveBeenCalledOnce();
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  it("destroys sockets for unmatched paths", () => {
    const router = createUpgradeRouter();
    const socket = fakeSocket();
    router.handleUpgrade({ url: "/nope" } as never, socket as never, Buffer.alloc(0));
    expect(socket.destroy).toHaveBeenCalledOnce();
  });

  it("destroys sockets with missing url", () => {
    const router = createUpgradeRouter();
    const socket = fakeSocket();
    router.handleUpgrade({ url: undefined } as never, socket as never, Buffer.alloc(0));
    expect(socket.destroy).toHaveBeenCalledOnce();
  });
});
```

Run: `pnpm vitest run --project @paperclipai/server src/__tests__/upgrade-router.test.ts`. Expected: FAIL.

- [ ] **Step 3.2: Implement** `upgrade-router.ts`:

```ts
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";

export type UpgradeMatch = Record<string, string>;
export type UpgradeMatcher = (pathname: string) => UpgradeMatch | null;
export type UpgradeHandler = (
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  match: UpgradeMatch,
  url: URL,
) => void;

export interface UpgradeRouter {
  register(matcher: UpgradeMatcher, handler: UpgradeHandler): void;
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  bind(server: HttpServer): void;
}

export function createUpgradeRouter(): UpgradeRouter {
  const routes: Array<{ matcher: UpgradeMatcher; handler: UpgradeHandler }> = [];
  return {
    register(matcher, handler) {
      routes.push({ matcher, handler });
    },
    handleUpgrade(req, socket, head) {
      if (!req.url) {
        socket.destroy();
        return;
      }
      const url = new URL(req.url, "http://localhost");
      for (const route of routes) {
        const match = route.matcher(url.pathname);
        if (match) {
          route.handler(req, socket, head, match, url);
          return;
        }
      }
      socket.destroy();
    },
    bind(server) {
      server.on("upgrade", (req, socket, head) => this.handleUpgrade(req, socket, head));
    },
  };
}
```

Run the test. Expected: PASS.

- [ ] **Step 3.3: Refactor live-events-ws.ts.** First find the call site: `grep -rn "setupLiveEventsWebSocketServer" server/src`. Change `setupLiveEventsWebSocketServer(server, db, opts)` to `setupLiveEventsWebSocketServer(router: UpgradeRouter, db, opts)`. Replace the `server.on("upgrade", ...)` block with:

```ts
router.register(
  (pathname) => {
    const companyId = parseCompanyId(pathname);
    return companyId ? { companyId } : null;
  },
  (req, socket, head, match, url) => {
    void authorizeUpgrade(db, req, match.companyId!, url, { ... })
      .then(...)  // identical body to the current .then/.catch chain
  },
);
```

Keep `rejectUpgrade`, auth, ping loop, and connection handling byte-identical otherwise. At the call site (found via the grep above), create the router, `router.bind(httpServer)`, and pass it in. Run the full realtime/server suites touched: `pnpm vitest run --project @paperclipai/server`. Expected: same pass/fail set as a clean tree (35 pre-existing env failures are known; zero NEW failures).

- [ ] **Step 3.4: Commit** `refactor(voice): central WS upgrade router so /api/voice/live can coexist with live events (FRE-1296)`

### Task 4: Protocol types + /api/voice/live route shell with auth

**Files:**
- Create: `server/src/services/voice-gateway/protocol.ts`
- Create: `server/src/realtime/voice-live-ws.ts`
- Create: `server/src/__tests__/voice-live-ws.test.ts`
- Modify: the router call site from Task 3 to also register the voice route

- [ ] **Step 4.1: Write `protocol.ts`** (pure types + frame helpers, fully testable):

```ts
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
```

Unit-test `encodeAudioFrame`/`decodeAudioFrame` round-trip and `parseClientMessage` (valid, junk JSON, unknown type, missing agentId) in the Task 4 test file. TDD order: tests first, watch fail, implement, watch pass.

- [ ] **Step 4.2: Write `voice-live-ws.ts`.** Model directly on `live-events-ws.ts`: its own `WebSocketServer({ noServer: true })`, ping/pong liveness (30s), and an auth function. Path matcher: `pathname === "/api/voice/live"`. Auth: reuse the exact `authorizeUpgrade` logic; **export `authorizeUpgrade` from `live-events-ws.ts`** (rename to `authorizeCompanyUpgrade` exported from that module) instead of duplicating it. The voice route requires `companyId` as a **query param** (`/api/voice/live?companyId=...`). In `local_trusted` mode the board context resolves to `actorId: "board"`; map that to the session `userId` the same way `voice-sessions.ts` routes do (read those routes for the exact precedent and follow it). On successful upgrade, hand the socket plus `{ companyId, userId }` to the gateway registry (Chunk 2); for THIS task, stub the registry with an interface:

```ts
export interface VoiceGatewayConnector {
  attach(socket: GatewaySocket, ctx: { companyId: string; userId: string }): void;
}
```

where `GatewaySocket` is a minimal structural type over `ws` (send/close/on message/close/error, binary support). Register on the upgrade router at the call site, passing a CONCRETE placeholder connector instance for now: `{ attach(socket) { socket.close(1013, "gateway not wired yet"); } }`. Task 10 Step 10.6 replaces it with the real registry. If gateway config is disabled (no keys), reject upgrade with `503 Service Unavailable` and body `voice gateway not configured`.

- [ ] **Step 4.3: Tests** (`voice-live-ws.test.ts`): matcher accepts exactly `/api/voice/live`; disabled config rejects with 503; successful auth calls `connector.attach` with context. Mock the auth dependency; do not open real sockets (call the exported handler functions directly with fakes, the same style as existing `live-events` tests if present, else with hand-rolled fakes).

- [ ] **Step 4.4: Run suite + typecheck.** Expected: new tests pass, zero new failures elsewhere.

- [ ] **Step 4.5: Commit** `feat(voice-gateway): /api/voice/live WS route with auth + wire protocol (FRE-1296)`

---

## Chunk 2: Gateway core (Gemini Live session, TTS pipe, tools, persistence)

**Design rule for this chunk:** the `@google/genai` SDK is wrapped behind our own `LiveClient` interface defined in `gemini-live.ts`. ALL other gateway modules depend on that interface, never on the SDK. Tests mock `LiveClient`. Only `gemini-live.ts` touches the SDK, and its tests are limited to config-mapping pure functions.

### Task 5: LiveClient wrapper over @google/genai

**Files:**
- Create: `server/src/services/voice-gateway/gemini-live.ts`
- Create: `server/src/__tests__/voice-gemini-live.test.ts`

- [ ] **Step 5.1: Define the interface** (this is the contract the rest of the gateway builds against):

```ts
export interface LiveServerEvent {
  textDelta?: string;                 // assistant text chunk (TEXT mode)
  audioDelta?: Uint8Array;            // assistant audio chunk (native mode)
  userTranscript?: { text: string; final: boolean };
  interrupted?: boolean;              // user barged in; Gemini dropped its turn
  turnComplete?: boolean;
  toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
}

export interface LiveSession {
  sendAudioChunk(pcm16: Buffer): void;          // base64-encodes, mimeType audio/pcm;rate=16000
  sendVideoFrame(jpegBase64: string): void;     // mimeType image/jpeg
  sendSystemText(text: string): void;           // sendClientContent user-role text turn, turnComplete true
  sendToolResponse(id: string, name: string, response: Record<string, unknown>): void;
  close(): void;
}

export interface LiveClient {
  connect(opts: {
    systemInstruction: string;
    tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
    onEvent: (event: LiveServerEvent) => void;
    onError: (err: Error) => void;
    onClose: () => void;
  }): Promise<LiveSession>;
}

export function createGeminiLiveClient(cfg: {
  apiKey: string;
  model: string;
  output: "cascade" | "native";
}): LiveClient { /* wraps new GoogleGenAI({apiKey}).live.connect(...) */ }
```

- [ ] **Step 5.2: Implement** the wrapper. Key SDK mapping (VERIFY against the installed `@google/genai` version's `.d.ts` before coding; the surface below is the documented Live API shape and the implementer must adjust names to what the installed SDK actually exports):
  - `ai.live.connect({ model, config, callbacks })`
  - config: `responseModalities: [Modality.TEXT]` for cascade, `[Modality.AUDIO]` for native; `systemInstruction`; `tools: [{ functionDeclarations }]`; `inputAudioTranscription: {}` (to receive user transcripts for persistence + flywheel).
  - callbacks.onmessage maps to `LiveServerEvent`: `serverContent.modelTurn.parts[].text` -> textDelta, `serverContent.modelTurn.parts[].inlineData.data` (base64) -> audioDelta, `serverContent.inputTranscription` -> userTranscript, `serverContent.interrupted` -> interrupted, `serverContent.turnComplete` -> turnComplete, `toolCall.functionCalls` -> toolCalls.
  - `session.sendRealtimeInput({ audio: { data: pcm16.toString("base64"), mimeType: "audio/pcm;rate=16000" } })`
  - `session.sendRealtimeInput({ video: { data: jpegBase64, mimeType: "image/jpeg" } })`
  - `session.sendClientContent({ turns: [{ role: "user", parts: [{ text }] }], turnComplete: true })`
  - `session.sendToolResponse({ functionResponses: [{ id, name, response }] })`

- [ ] **Step 5.3: Pure-function tests only** for this module: extract `mapServerMessage(raw): LiveServerEvent` as an exported pure function and test it against literal SDK message shapes (text delta, interruption, tool call, input transcription, audio inline data). No network tests.

- [ ] **Step 5.4: Typecheck + run tests. Commit** `feat(voice-gateway): LiveClient wrapper over @google/genai live API (FRE-1296)`

### Task 6: System prompt + tool declarations

**Files:**
- Create: `server/src/services/voice-gateway/prompt.ts`
- Create: `server/src/services/voice-gateway/tool-defs.ts`
- Test: `server/src/__tests__/voice-gateway-prompt.test.ts`

- [ ] **Step 6.1: `prompt.ts`** exports `buildGatewaySystemPrompt(): string` containing, verbatim requirements (test asserts each phrase is present):
  - Identity: front desk for Conrad; the user hears replies via TTS as Conrad's voice.
  - Wake word gating: "Respond only when the user addresses you as Conrad, or when continuing an exchange the user is actively engaged in. Otherwise output nothing at all."
  - Persona containment: "Never answer substantive questions, never give opinions, plans, or analysis yourself. For anything beyond chitchat, acknowledgment, or relaying, call dispatch_to_conrad and tell the user Conrad is on it."
  - Voice style rules copied from `VOICE_SYSTEM_PROMPT` style (short sentences, no markdown, no emdashes, max two sentences before pausing).
  - Relay rule: "When a system message reports a completed Conrad run, speak its outcome to the user immediately and conversationally."
- [ ] **Step 6.2: `tool-defs.ts`** exports the three function declarations (JSON-schema parameters):
  - `dispatch_to_conrad(prompt: string)` - "Send the user's request to Conrad as a background task. Returns a runId. Use for ANY substantive request."
  - `check_run(runId: string)` - "Check whether a previously dispatched Conrad run has finished."
  - `board_snapshot()` - "Cheap read-only summary of the Paperclip board: counts by status and the most recently updated issues."
- [ ] **Step 6.3: TDD, run, commit** `feat(voice-gateway): gateway system prompt + tool declarations (FRE-1296)`

### Task 7: Tool router (dispatch_to_conrad, check_run, board_snapshot)

**Files:**
- Create: `server/src/services/voice-gateway/tools.ts`
- Test: `server/src/__tests__/voice-gateway-tools.test.ts`

Dependencies injected (no direct imports of heartbeat/db in the router so tests stay hermetic):

```ts
export interface ToolDeps {
  wakeup(agentId: string, opts: Record<string, unknown>): Promise<{ id: string } | null>;
  getRunStatus(runId: string): Promise<{ status: string } | null>;
  boardSnapshot(companyId: string): Promise<{ counts: Record<string, number>; recent: Array<{ identifier: string; title: string; status: string }> }>;
}

export interface ToolCallResult { response: Record<string, unknown>; dispatchedRunId?: string }

export async function routeToolCall(
  deps: ToolDeps,
  ctx: { companyId: string; agentId: string; sessionId: string; userId: string },
  call: { name: string; args: Record<string, unknown> },
): Promise<ToolCallResult>;
```

- [ ] **Step 7.1: Failing tests:**
  - `dispatch_to_conrad` calls `deps.wakeup(ctx.agentId, opts)` where `opts.source === "voice_session"`, `opts.contextSnapshot.voiceTurn.transcript === args.prompt`, `opts.contextSnapshot.voiceTurn.instructions === VOICE_SYSTEM_PROMPT`, `opts.contextSnapshot.modelOverride` honors `process.env.VOICE_WAKEUP_MODEL` (mirror EXACTLY how `server/src/routes/voice-sessions.ts:59-124` builds its wakeup opts; read it first and copy the shape, including `payload` and `requestedByActorType`). Returns `{ response: { runId, status: "dispatched" }, dispatchedRunId: runId }`.
  - `dispatch_to_conrad` with blank/missing prompt returns `{ response: { error: "empty prompt" } }` and does not call wakeup.
  - wakeup returning null maps to `{ response: { error: "dispatch failed" } }`.
  - `check_run` passes through `getRunStatus`; null maps to `{ response: { error: "unknown run" } }`.
  - `board_snapshot` passes companyId through.
  - unknown tool name returns `{ response: { error: "unknown tool" } }`.
- [ ] **Step 7.2: Implement.** Also implement the two real dep factories in the same file (exported separately, NOT unit-tested here, exercised in Task 10 integration test):
  - `makeToolDeps(db, heartbeat)` wiring `wakeup` to `heartbeat.wakeup`, `getRunStatus` to the heartbeat run-record read used by GET run routes (grep `server/src/routes/agents.ts:2355` area for the status accessor), `boardSnapshot` to a drizzle query over the issues table: counts grouped by status + 10 most recently updated `{identifier, title, status}` for the company.
- [ ] **Step 7.3: Run, typecheck, commit** `feat(voice-gateway): tool router with conrad dispatch on voiceTurn rail (FRE-1296)`

### Task 8: TTS pipe (text deltas -> sentences -> ElevenLabs -> tagged frames)

**Files:**
- Create: `server/src/services/voice-gateway/tts-pipe.ts`
- Test: `server/src/__tests__/voice-gateway-tts-pipe.test.ts`

```ts
import { splitIntoSentences } from "../voice/sentence-buffer.js";

export interface TtsPipeDeps {
  synthesize(sentence: string): ReadableStream<Uint8Array>; // wraps streamTextToSpeech
  /** Spec section 6 fallback when the streaming WS path errors: non-streaming
   *  ElevenLabs HTTP synth (POST /v1/text-to-speech/{voiceId}?output_format=mp3_44100_128
   *  with xi-api-key header). Returns null on failure. The gateway runs in-server,
   *  so this replaces the spec's plugin voice.speak fallback with a direct HTTP
   *  call to the same API; Task 18.1 records that substitution in the spec. */
  synthesizeFallback(sentence: string): Promise<Uint8Array | null>;
  sendAudioStart(seq: number): void;
  sendAudioChunk(seq: number, bytes: Uint8Array): void;
  sendAudioEnd(seq: number): void;
}

export interface TtsPipe {
  pushTextDelta(text: string): void;
  endTurn(): void;     // flush sentence buffer remainder, finish in-flight synth
  cancel(): void;      // barge-in: abort in-flight synth streams, drop queued sentences
}

export function createTtsPipe(deps: TtsPipeDeps): TtsPipe;
```

Behavior (tested):
- Sentences are synthesized **sequentially** (one ElevenLabs WS at a time; server-side we do not need the parallel-synth trick because Flash is fast and ordering is trivial when serial). Each sentence gets a monotonically increasing `seq` starting at 0 for the session.
- For each sentence: `sendAudioStart(seq)`, then every chunk from the synth stream via `sendAudioChunk(seq, bytes)`, then `sendAudioEnd(seq)`.
- `endTurn()` flushes the partial-sentence remainder from the buffer as a final sentence if non-empty.
- `cancel()` cancels the active ReadableStream reader, clears pending sentences, and suppresses any further sends for already-started seqs. A new turn after cancel continues seq numbering (no reuse).
- Synth stream error: log loudly (warn with sentence + error), then try `synthesizeFallback` for THAT sentence; if fallback returns bytes, send them as a single chunk for the same seq; if it returns null, skip the sentence and continue with the next.

- [ ] **Step 8.1: Failing tests** with a controllable fake `synthesize` (push chunks manually). Cover: ordering, partial-sentence flush on endTurn, cancel mid-sentence stops chunks, stream-error uses fallback bytes on the same seq, fallback null skips sentence and pipe continues.
- [ ] **Step 8.2: Implement. Run. Commit** `feat(voice-gateway): sequential sentence TTS pipe with barge-in cancel (FRE-1296)`

### Task 9: JSONL flywheel logger

**Files:**
- Create: `server/src/services/voice-gateway/flywheel.ts`
- Test: `server/src/__tests__/voice-gateway-flywheel.test.ts`

```ts
export interface FlywheelEntry {
  ts: string;            // ISO
  sessionId: string;
  userId: string;
  kind: "user_turn" | "assistant_turn" | "tool_call" | "tool_result" | "interrupt" | "run_complete";
  text?: string;
  tool?: string;
  data?: Record<string, unknown>;
}
export function createFlywheelLogger(dir: string | null): { log(entry: FlywheelEntry): void };
```

- Appends one JSON line to `<dir>/YYYY-MM-DD.jsonl` (date from entry ts, UTC). `dir === null` makes `log` a no-op. mkdir recursive on first write. Append failures are caught and logged at warn level, never thrown (the flywheel must never break a live call).
- [ ] **Step 9.1: TDD against a tmp dir (use `fs.mkdtempSync(path.join(os.tmpdir(), ...))`). Run. Commit** `feat(voice-gateway): JSONL training-data flywheel logger (FRE-1296)`

### Task 10: GatewaySession + registry (the conductor)

**Files:**
- Create: `server/src/services/voice-gateway/session.ts`
- Create: `server/src/services/voice-gateway/registry.ts`
- Test: `server/src/__tests__/voice-gateway-session.test.ts`
- Test: `server/src/__tests__/voice-gateway-registry.test.ts`
- Modify: router call site - replace the Task 4 stub connector with the real registry

**`session.ts`** - one user's live conversation. Injected deps: `LiveClient`, `TtsPipe` factory, tool router deps, `VoiceSessionsService` (for `createSession`/`appendTurn`/`endSession`), flywheel logger, live-events subscription (`subscribeCompanyLiveEvents` from `server/src/services/live-events.js`) for run-completion watching, and an `extractRunOutcome(runId): Promise<string>` dep (Task 11). Public surface:

```ts
export interface GatewaySessionHandle {
  readonly userId: string;
  attachSocket(socket: GatewaySocket): void;   // takeover: closes previous socket with ServerMessage "superseded" then close code 4001
  handleBinary(buf: Buffer): void;             // mic PCM -> liveSession.sendAudioChunk (dropped while muted)
  handleMessage(msg: ClientMessage): void;
  clientDisconnected(): void;                  // starts warm-hold timer
  destroy(reason: string): void;               // closes Gemini session, ends DB session, clears timers
}
```

Conductor behaviors (each is a test):
1. `start` message: creates DB voice session (`createSession`), connects `LiveClient` with prompt + tool defs, replies `{type:"ready", sessionId}` then `{type:"status", state:"listening"}`. **Idempotent:** a `start` arriving when the Live session is already connected (reconnect into a warm session; the client sends start on every socket open) is a no-op except replying `{type:"resumed", sessionId}`. Test both paths.
2. Live event `userTranscript final` -> `appendTurn(sessionId, {role:"user", ...})` + flywheel `user_turn` + downstream `transcript {final:true}` + downstream `{type:"status", state:"thinking"}`. (Read `VoiceTranscriptTurn` type in `@paperclipai/db` for exact field names and reuse the turn shape the turn POST route writes.)
3. Live event `textDelta` -> ttsPipe.pushTextDelta + downstream `transcript {role:"assistant", final:false}`; the FIRST textDelta of a turn also emits `{type:"status", state:"speaking"}`. `turnComplete` -> ttsPipe.endTurn + downstream `transcript {role:"assistant", text:<full accumulated text>, final:true}` + appendTurn assistant turn (accumulated text) + flywheel `assistant_turn` + `{type:"status", state:"listening"}`.
4. Live event `interrupted` -> ttsPipe.cancel + downstream `{type:"interrupt"}` + flywheel `interrupt` + `{type:"status", state:"listening"}`.
5. Live event `toolCalls` -> routeToolCall per call -> `sendToolResponse`; for dispatch results with `dispatchedRunId`: downstream `run-dispatched`, then watch the run: subscribe via `subscribeCompanyLiveEvents(companyId, handler)` and filter for events whose type is the heartbeat run status live event with payload runId === dispatchedRunId (grep `LIVE_EVENT_TYPES` and `HEARTBEAT_RUN_STATUSES` in `packages/shared/src/constants.ts` around lines 345-356 for the exact event type string, the payload field names, and the terminal status set; expect terminal = succeeded/failed/cancelled family, but USE THE CONSTANTS, do not hardcode guesses). On terminal status: `extractRunOutcome(runId)` -> `liveSession.sendSystemText("[system] Conrad finished: <outcome>. Tell the user now.")` + downstream `run-complete` + flywheel `run_complete`; unsubscribe. On a failure-family terminal status: sendSystemText with the failure summary instead (spec section 6).
6. `camera` message -> `sendVideoFrame`. `mute`/`unmute` gate `handleBinary`. `end` -> destroy.
7. Idle timeout: no client audio for `idleTimeoutMs` -> destroy.
8. `clientDisconnected` -> warm-hold timer (`warmHoldMs`); reconnect within window via `attachSocket` cancels the timer (the `resumed` reply is driven by behavior 1's idempotent start); expiry -> destroy.
9. Gemini onError/onClose while a client is attached -> downstream `error`, attempt ONE reconnect of the Live session with a `sendSystemText` context note ("session restored after a connection drop; the last user message may need repeating"); second failure -> destroy. **Recorded spec deviation:** spec section 6 calls for last-N-messages context restore; v1 ships a single bare reconnect with an honest note instead. Task 18.1 records this cut in the spec.

Native-audio flag: when config `output === "native"`, the session skips the TtsPipe and forwards `audioDelta` chunks as tagged frames (one seq per Gemini turn, audio-start on first chunk, audio-end on turnComplete). Cover with one test.

**`registry.ts`** - `Map<userId, GatewaySessionHandle>`; `attach(socket, ctx)` reuses a warm session for the same user (takeover semantics if a socket is still attached) or creates a new one; removes entries on destroy. Tests: reuse-within-warm-hold, takeover closes old socket, destroy removes entry.

Use fakes for everything (LiveClient fake emitting scripted events; recorder socket). These tests are the heart of the gateway; budget the bulk of chunk-2 effort here. TDD each step: failing tests, implement, green, commit.

- [ ] **Step 10.1: Behaviors 1-3** (lifecycle + turn flow + status emission). Commit `feat(voice-gateway): session lifecycle and turn flow (FRE-1296)`.
- [ ] **Step 10.2: Behaviors 4-6** (barge-in, tool routing + run watching, camera/mute/end). For `extractRunOutcome`, inject a PLACEHOLDER dep `async () => "Run finished."` for now; Task 11 swaps in the real one. Commit `feat(voice-gateway): barge-in, tool routing, run completion relay (FRE-1296)`.
- [ ] **Step 10.3: Behaviors 7-9 + native flag** (timers, warm-hold, Gemini reconnect). Commit `feat(voice-gateway): idle timeout, warm hold, live-session recovery (FRE-1296)`.
- [ ] **Step 10.4: registry.ts** with its tests. Commit `feat(voice-gateway): per-user session registry with takeover (FRE-1296)`.
- [ ] **Step 10.5: Typecheck + full server suite**: zero new failures vs the documented pre-existing set.
- [ ] **Step 10.6: Wire the real registry** into the router call site, replacing the Task 4 placeholder connector, with real dep factories (gemini client from config, streamTextToSpeech-based synthesize + HTTP synthesizeFallback, makeToolDeps, voiceSessionsService(db), flywheel from config, placeholder extractRunOutcome). Typecheck + suite again. Commit `feat(voice-gateway): wire gateway registry into /api/voice/live (FRE-1296)`.

### Task 11: Run outcome extraction (server-side final-assistant-text parser)

**Files:**
- Create: `server/src/services/voice-gateway/run-outcome.ts`
- Test: `server/src/__tests__/voice-gateway-run-outcome.test.ts`

The UI already parses stream-json run logs to find the final assistant text (`fetchFinalAssistantText` in the UI, fixed in FRE-1296 commit c904ad24). Port that parsing to the server: `extractFinalAssistantText(logContent: string): string | null` walking stream-json lines for the last assistant text block, ignoring the result envelope. Then `makeExtractRunOutcome(heartbeat)` reads the log via `heartbeat.readLog(runId, {})` and falls back to `"Run finished but no spoken summary was found."` on null. Read the UI implementation first (grep `fetchFinalAssistantText` in `ui/src`) and port its cases, including the c904ad24 regression (result envelope must not be spoken).

- [ ] **Step 11.1: TDD with real captured stream-json fixtures** (copy 10-15 lines from any ndjson run log under the instance data dir into the test as string literals; redact content). Run.
- [ ] **Step 11.2: Swap the placeholder.** Replace the Task 10 placeholder `extractRunOutcome` dep at the wiring call site with `makeExtractRunOutcome(heartbeat)`. Typecheck + server suite. Commit `feat(voice-gateway): run outcome extraction for spoken completions (FRE-1296)`

### Task 12: E2E transcript-delivery assertion (the wake-9/10 lesson)

**Files:**
- Create: `server/src/__tests__/voice-gateway-e2e.test.ts`

One integration-style test wiring REAL `routeToolCall` + REAL `buildPaperclipWakePayload`/`renderPaperclipWakePrompt` from `@paperclipai/adapter-utils` with a fake wakeup that captures opts: simulate a scripted Live event stream containing a `dispatch_to_conrad` tool call with prompt "What is on the board today?"; assert the RENDERED wake prompt (via renderPaperclipWakePrompt on the captured contextSnapshot run through buildPaperclipWakePayload) **contains the literal transcript text**. This closes, in-process, exactly the gap the wake-8 smoke test missed: pipeline liveness is not transcript delivery.

- [ ] **Step 12.1: Write it, watch it fail against a stub, wire real pieces, watch it pass. Commit** `test(voice-gateway): e2e assertion that dispatched prompts reach the rendered wake prompt (FRE-1296)`

---

## Chunk 3: Browser client (mic worklet, gateway socket, playback, VoiceMode rewrite)

**Design rule:** no new downloadable assets. The AudioWorklet module is loaded from an inline Blob URL so nothing depends on static-asset serving (the SPA-404 class of bug stays dead).

### Task 13: PCM capture hook (AudioWorklet downsampler)

**Files:**
- Create: `ui/src/hooks/useMicPcmStream.ts`
- Test: `ui/src/hooks/useMicPcmStream.test.ts` (pure parts only)

- [ ] **Step 13.1:** Export pure function `downsampleTo16kPcm16(input: Float32Array, inputRate: number): Int16Array` (linear-interpolation resample to 16000 Hz, clamp to [-1,1], scale to Int16). TDD this function first: identity at 16k, 48k->16k length = ceil(len/3), clipping clamps, empty input.
- [ ] **Step 13.2:** Hook `useMicPcmStream({ onChunk: (pcm: Int16Array) => void, enabled: boolean })`:
  - `getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })` on enable; stops tracks on disable/unmount.
  - `AudioContext` at native rate; AudioWorklet module from a Blob URL whose source is a string constant in the file: a processor that posts each 128-frame block's Float32 samples to the main thread; main thread batches ~250ms, runs `downsampleTo16kPcm16`, calls `onChunk`.
  - Fallback when `audioWorklet` is unavailable: `ScriptProcessorNode(4096)` doing the same (older iOS).
  - Returns `{ state: "idle" | "capturing" | "denied" | "error", error?: string }`.
  - The worklet/script-processor halves are NOT unit-tested (no DOM audio in vitest); the resampler and batching logic are.
- [ ] **Step 13.3: Run UI tests, commit** `feat(voice-gateway): mic PCM16 capture hook with worklet downsampler (FRE-1296)`

### Task 14: Gateway socket hook + audio frame playback queue

**Files:**
- Create: `ui/src/hooks/useVoiceGatewaySocket.ts`
- Create: `ui/src/hooks/audio-frame-queue.ts`
- Test: `ui/src/hooks/audio-frame-queue.test.ts`
- Test: `ui/src/hooks/useVoiceGatewaySocket.test.ts`

- [ ] **Step 14.1: `audio-frame-queue.ts`** reuses `createTtsQueue` from `useSentenceTtsQueue.ts` unchanged. New factory:

```ts
import { createTtsQueue, type TtsQueue } from "./useSentenceTtsQueue";

/** Adapts server-pushed tagged audio frames onto the existing ordered TTS queue.
 *  audio-start(seq) enqueues a slot whose "synthesis" resolves when audio-end(seq)
 *  arrives with all chunks assembled into one MP3 Blob. */
export interface AudioFrameSink {
  onAudioStart(seq: number): void;
  onAudioChunk(seq: number, bytes: Uint8Array): void;
  onAudioEnd(seq: number): void;
  interrupt(): void;   // drain() + stopPlayback() + new generation queue for the next turn
  end(): void;
}
export function createAudioFrameSink(opts: {
  play: (blob: Blob) => Promise<void>;
  /** Hard-stops the CURRENTLY PLAYING audio (pauses the element and settles the
   *  in-flight play() promise). Without this, barge-in only drops queued
   *  sentences while the current one keeps speaking; spec field acceptance
   *  requires mid-sentence interruption. */
  stopPlayback: () => void;
  /** Fired with true when the sink has audio queued or playing, false when it
   *  goes idle. VoiceMode uses this for the local "speaking" indicator; the
   *  per-turn end()/onIdle latch of createTtsQueue cannot serve a session-long
   *  sink. Implement via a pending-count that increments on onAudioStart and
   *  decrements when a slot finishes playing or is dropped. */
  onActivity?: (active: boolean) => void;
}): AudioFrameSink;
```

Internals: a `Map<seq, {chunks: Uint8Array[]; resolve: (b: Blob) => void; reject: (e: Error) => void}>`; `onAudioStart` registers the pending entry and calls `queue.enqueue(String(seq))` where the queue's `speak` returns that entry's promise; `onAudioEnd` resolves with `new Blob(chunks, {type: "audio/mpeg"})`. **Differences from the per-turn queue:** `interrupt()` calls `queue.drain()`, calls `stopPlayback()`, clears the entry map (late chunks for drained seqs are dropped), AND swaps in a fresh `createTtsQueue` instance (the existing queue is terminal after drain; the sink is session-long). TDD: ordering across seqs, chunk assembly, interrupt calls stopPlayback and drops pending, a NEW seq after interrupt still plays on the fresh queue, activity callback transitions true -> false, end() drives onActivity(false) once playback finishes.

- [ ] **Step 14.2: `useVoiceGatewaySocket.ts`:**

```ts
export interface GatewaySocketCallbacks {
  onServerMessage(msg: ServerMessage): void;   // mirror of server protocol types (duplicate the type unions client-side in this file; keep them in sync by comment reference to server/src/services/voice-gateway/protocol.ts)
  onAudioFrame(seq: number, bytes: Uint8Array): void;
  onOpen(): void;
  onClose(reason: "superseded" | "error" | "normal"): void;
}
export function useVoiceGatewaySocket(opts: {
  companyId: string; agentId: string; enabled: boolean; callbacks: GatewaySocketCallbacks;
}): { send(msg: ClientMessage): void; sendAudio(pcm: Int16Array): void; state: "idle" | "connecting" | "open" | "reconnecting" | "closed" };
```

  - URL: `${wsBase}/api/voice/live?companyId=...` where wsBase derives from `location` the same way the existing live-events client does (grep `events/ws` in `ui/src` and mirror its URL + auth construction exactly, including any token query param).
  - `binaryType = "arraybuffer"`; binary messages decoded as `[seq u32 BE][bytes]`; text messages JSON-parsed.
  - On open: send `{type:"start", agentId}`.
  - Reconnect: on unexpected close while `enabled`, retry with backoff 1s/2s/4s (max 3, then state "closed"); also force a reconnect attempt on `visibilitychange` -> visible and `pageshow` when state is not "open" (iOS tab resume). Buffer up to ~5s of outgoing audio while "reconnecting", drop beyond that; on reopen, send `{type:"start"}` FIRST, then flush the buffered audio in order (the server's idempotent start makes this safe on warm resumes).
  - Tests: framing decode dispatch (text vs binary), start sent on open, reconnect triggers (mock WebSocket class injected via optional `wsFactory` opt).
- [ ] **Step 14.3: Run, commit** `feat(voice-gateway): gateway socket hook + tagged-frame audio sink (FRE-1296)`

### Task 15: VoiceMode.tsx rewrite

**Files:**
- Rewrite: `ui/src/pages/VoiceMode.tsx`
- Keep: route registration in `App.tsx:181` unchanged.

- [ ] **Step 15.1:** New component structure (read the current file fully first for the styling/layout idioms, the agent-pinning logic that resolves Conrad's agentId and companyId, and the tap-to-start affordance; preserve all three):
  - Phases: `idle` (big tap-to-start button) -> `connecting` -> `live` -> `reconnecting` / `error`. Within `live`, indicator driven by server `status` messages plus local "speaking" while the sink's `onActivity` reports true.
  - Tap-to-start handler (single user gesture): create/resume AudioContext AND play a zero-length silent buffer (iOS audio unlock), then enable mic hook + socket hook.
  - Wire: mic `onChunk` -> `sendAudio`; server `transcript` messages render into a scrolling transcript pane (user right-aligned, assistant left, interim text dimmed until `final`); `audio-start/chunk/end` -> sink; `interrupt` -> sink.interrupt(); `superseded` -> error state with "Opened in another tab"; `run-dispatched`/`run-complete` render as inline status chips.
  - Mute button -> `{type:"mute"}/{type:"unmute"}` + local mic pause. End button -> `{type:"end"}` + teardown.
  - Camera toggle: `getUserMedia({video: {facingMode: "environment"}})`, hidden `<video>` + canvas, JPEG at 1 fps (`canvas.toBlob` quality 0.7 -> base64) -> `{type:"camera", jpegBase64}`; off by default.
  - Playback `play(blob)`: single persistent `<audio>` element (created during the tap gesture), `src = URL.createObjectURL(blob)`, resolve on `ended`, **reject on the `error` event and on abort** (an unresolved play promise would stall the queue pump forever and permanently silence the session; the queue already skips rejected plays). The sink's `stopPlayback` pauses this element and rejects the in-flight play promise with an AbortError-style rejection.
- [ ] **Step 15.2:** The old `ui/src/pages/VoiceMode.test.tsx` mocks useVad/useStreamingTts/useVoiceSessionMachine and will break on the rewrite: DELETE it and write a new minimal `VoiceMode.test.tsx` (render the idle phase, tap-to-start calls the start path; mock the three new hooks). Delete now-unused imports from VoiceMode (useVad, useAckPlayer, useStreamingTts, useVoiceCues, useVoiceSessionMachine, sentence-buffer, streamJsonDeltas) but do NOT delete the hook files yet (Chunk 4 does removal). Typecheck UI: `pnpm --filter @paperclipai/ui exec tsc -b`. Run UI tests.
- [ ] **Step 15.3: Build the UI** (`pnpm --filter @paperclipai/ui build`) and confirm the bundle builds clean. NOTE: do not deploy/restart anything.
- [ ] **Step 15.4: Commit** `feat(voice-gateway): VoiceMode rewrite as thin gateway client (FRE-1296)`

---

## Chunk 4: Rip-out, full verification, field handoff

### Task 16: Delete the old pipeline

**Files:**
- Delete (after resolving importers, see 16.0/16.1): `ui/src/hooks/useVad.ts` (+ test), `ui/src/hooks/useAckPlayer.ts` (+ test), `ui/src/hooks/useStreamingTts.ts` (+ test), `ui/src/hooks/useVoiceSessionMachine.ts` (+ test), `ui/src/hooks/useVoiceCues.ts` (+ test if present), `ui/src/hooks/streamJsonDeltas.ts` (+ test); `ui/scripts/copy-vad-assets.mjs`; `ui/public/vad/` directory.
- Modify: `ui/package.json` - remove `@ricky0123/vad-web`, `onnxruntime-web`, and the `prebuild`/`predev` hooks that call copy-vad-assets.
- Modify: `ui/src/components/VoicePoweredOrb.tsx` and `ui/src/components/VoiceOrb.tsx` - both import `type MutablePhase` from `useVoiceSessionMachine`. Move the `MutablePhase` type definition into `VoiceOrb.tsx` (export it from there; update VoicePoweredOrb's import) BEFORE deleting the hook, or deletion will dangle.
- Keep: `ui/src/hooks/useSentenceTtsQueue.ts` + tests (reused by the sink), `ui/src/hooks/sentence-buffer.ts` + tests (still imported? grep; if only VoiceMode imported it, it now lives server-side - delete the UI copy too if importer count is zero).
- Keep: `server/src/routes/voice-sessions.ts` turn POST untouched (one-release API fallback, spec section 4).
- Keep: voice-mode plugin package untouched (voice.speak fallback path).

- [ ] **Step 16.0:** Move `MutablePhase` per above; UI typecheck green before any deletion.
- [ ] **Step 16.1:** `grep -rn "useVad\|useAckPlayer\|useStreamingTts\|useVoiceSessionMachine\|useVoiceCues\|streamJsonDeltas\|copy-vad-assets\|vad-web\|onnxruntime" ui/src ui/scripts ui/package.json` - enumerate every hit, delete/edit each, re-grep until zero hits (excluding this plan/spec docs).
- [ ] **Step 16.2:** `pnpm install` (lockfile update for removed deps), UI typecheck + tests + build all green. Verify `ui/dist` (fresh build) contains NO `vad` assets and the bundle main chunk shrank (record before/after sizes in the commit message).
- [ ] **Step 16.3: Commit** `refactor(voice): rip out browser VAD pipeline (26MB assets, vad-web, onnxruntime) (FRE-1296)`

### Task 17: Whole-tree verification + review

- [ ] **Step 17.1:** Full suite from root: `pnpm vitest run`. Expected: zero failures beyond the documented pre-existing env-dependent set (compare against a `git stash` baseline if anything looks new). All three typechecks clean (server, ui, adapter-utils).
- [ ] **Step 17.2:** Request code review per superpowers:requesting-code-review on the whole branch diff for this plan; fix findings; re-review until approved.

### Task 18: Field handoff (no restart by the agent)

- [ ] **Step 18.1:** Append a "Voice gateway env setup" section to the spec doc listing the required `.env` additions (VOICE_GATEWAY_GEMINI_API_KEY from 1P item "Gemini API Key", VOICE_GATEWAY_ELEVENLABS_API_KEY from the existing ElevenLabs secret) and the restart requirement. In the same edit, record the two implementation deviations from spec section 6: (a) the ElevenLabs WS-drop fallback is a direct non-streaming ElevenLabs HTTP call from the gateway, not plugin `voice.speak` (the gateway runs in-server); (b) Gemini session recovery in v1 is a single bare reconnect with an honest spoken note, not last-N-messages context restore (restore is a recorded follow-up).
- [ ] **Step 18.2:** Post the FRE-1296 comment to Dom: what shipped, env keys to add (Conrad can add them to the VPS `.env` himself if authorized - check 1P access first and do it if possible, noting exactly what was written), restart needed, then the field acceptance script from spec section 7 (mic permission < 2s, chitchat reply < 2s, real dispatch spoken on completion, mid-sentence interruption). No emdashes.
- [ ] **Step 18.3:** Closeout: scratchpad WAKE block, memory update, commit docs.
