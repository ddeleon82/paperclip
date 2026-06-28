# Voice Mode Tab Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a hands-free, always-listening `/voice` tab in the Paperclip board, plus close two gaps in the existing composer voice flow (transcript echo on auto-send + auto-played final reply for voice-originated runs).

**Architecture:** A new top-level board page mounts at `/<companyPrefix>/voice`, owned by the main UI repo (faster than introducing a new plugin slot type). Browser-side Silero VAD (`@ricky0123/vad-web`) drives a state machine that pipes audio to the existing voice-mode plugin's STT endpoint, sends transcripts to a new plugin-worker route that spawns an ephemeral Conrad agent run, and plays streaming ElevenLabs TTS as Claude streams its reply. Voice-originated heartbeat runs get an `invocation_source = "voice"` tag, and the composer mic subscribes to those runs' completion to auto-play the final assistant comment.

**Tech Stack:** React 18 + TanStack Query (existing UI), `@ricky0123/vad-web` (Silero ONNX VAD in the browser), ElevenLabs Scribe v2 (STT, already integrated), ElevenLabs WebSocket TTS endpoint (new), Hono inside the voice-mode plugin worker (existing), Drizzle/Postgres migrations (`heartbeat_runs.invocation_source` enum extension + new `voice_sessions` table), `claude_local` agent-runtime bridge (existing).

**Reference Spec:** `docs/superpowers/specs/2026-05-24-voice-mode-tab-design.md`

---

## Pre-flight (do once before any chunk)

- [ ] **Create a feature branch** off the current main: `git checkout -b feat/voice-mode-tab`
- [ ] **Verify the dev loop works**: `pnpm --filter @paperclipai/ui dev`, `pnpm dev:server`, and visit `http://localhost:5173/FRE/dashboard`. Confirm you can log in and see the existing nav.
- [ ] **Verify the voice-mode plugin is installed and configured** for the FRE company (the ElevenLabs key secret must be bound — see `instanceConfigSchema.elevenlabsKeyRef` in `packages/plugins/voice-mode/src/manifest.ts`). Without this, no STT/TTS calls will succeed.
- [ ] **Read** `packages/plugins/voice-mode/src/worker/routes.ts` and `src/worker/elevenlabs.ts` end-to-end. They are the source of truth for how STT/TTS calls are dispatched today.
- [ ] **Read** `server/src/services/agent-runner.ts` (or equivalent — search for "claude_local" / `spawnAgentRun`) so you understand how a heartbeat run is created today. The new voice-session runs reuse this pathway.

---

## Chunk 1: Database & invocation tagging

Adds the schema and server pieces required to mark a heartbeat run as "originated from voice." Nothing user-visible yet; this is foundational.

### Task 1: Add a "voice" invocation source value

**Files:**
- Modify: `packages/db/src/schema/heartbeat_runs.ts` (add JSDoc comment listing the legal values for `invocation_source`)
- Create: `packages/db/migrations/<next>_heartbeat_runs_voice_source.sql`

`heartbeat_runs.invocation_source` is a plain `text` column with a default of `"on_demand"`. No schema change is needed — we are adding a new legal value, not a new column. The migration is documentation-only (a `COMMENT ON COLUMN`), so existing rows are untouched.

- [ ] **Step 1: Open the schema file and add inline documentation**

```ts
// in packages/db/src/schema/heartbeat_runs.ts, on the invocationSource line:
invocationSource: text("invocation_source").notNull().default("on_demand"),
// Legal values: "on_demand" | "scheduled" | "wakeup" | "voice" | "voice_session"
// "voice"         = composer mic auto-sent a comment that started this run
// "voice_session" = a /voice tab ephemeral session turn
```

- [ ] **Step 2: Create the migration**

Find the next migration number by `ls packages/db/migrations/ | tail`. Use that number + 1.

```sql
-- packages/db/migrations/<NNNN>_heartbeat_runs_voice_source.sql
COMMENT ON COLUMN heartbeat_runs.invocation_source IS
  'How this run was triggered. Values: on_demand | scheduled | wakeup | voice | voice_session.';
```

- [ ] **Step 3: Apply the migration locally**

Run: `pnpm --filter @paperclipai/db migrate`
Expected: "Migration <NNNN> applied" with no errors.

- [ ] **Step 4: Verify the comment landed**

Run: `psql "$DATABASE_URL" -c "\\d+ heartbeat_runs" | grep -A1 invocation_source`
Expected: the column shows the new comment.

- [ ] **Step 5: Commit**

```bash
git add packages/db/schema/heartbeat_runs.ts packages/db/migrations/<NNNN>_heartbeat_runs_voice_source.sql
git commit -m "feat(db): document voice invocation sources for heartbeat_runs"
```

### Task 2: Add the `voice_sessions` table

**Files:**
- Create: `packages/db/src/schema/voice_sessions.ts`
- Modify: `packages/db/src/schema/index.ts` (add the new export)
- Create: `packages/db/migrations/<next>_voice_sessions.sql`

One row per `/voice` tab visit. Holds the rolling transcript so nothing said is lost even though no issue is created by default.

- [ ] **Step 1: Write the failing test** — `packages/db/src/__tests__/voice_sessions.schema.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { voiceSessions } from "../schema/voice_sessions.js";

describe("voiceSessions schema", () => {
  it("has the expected columns", () => {
    const cols = Object.keys(voiceSessions);
    expect(cols).toEqual(
      expect.arrayContaining([
        "id",
        "companyId",
        "userId",
        "startedAt",
        "endedAt",
        "transcript",
      ]),
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @paperclipai/db test voice_sessions.schema`
Expected: FAIL ("Cannot find module '../schema/voice_sessions'").

- [ ] **Step 3: Implement the schema**

```ts
// packages/db/src/schema/voice_sessions.ts
import { pgTable, uuid, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export type VoiceTranscriptTurn = {
  role: "user" | "assistant" | "tool";
  text: string;
  ts: string; // ISO
  toolName?: string;
};

export const voiceSessions = pgTable(
  "voice_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    transcript: jsonb("transcript").$type<VoiceTranscriptTurn[]>().notNull().default([]),
  },
  (table) => ({
    companyStartedIdx: index("voice_sessions_company_started_idx").on(
      table.companyId,
      table.startedAt,
    ),
  }),
);
```

- [ ] **Step 4: Add export to the schema index**

```ts
// in packages/db/src/schema/index.ts (alphabetical block):
export * from "./voice_sessions.js";
```

- [ ] **Step 5: Write the migration**

```sql
-- packages/db/migrations/<NNNN>_voice_sessions.sql
CREATE TABLE IF NOT EXISTS voice_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  ended_at     timestamptz,
  transcript   jsonb NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS voice_sessions_company_started_idx
  ON voice_sessions (company_id, started_at);
```

- [ ] **Step 6: Apply migration and run the test**

Run: `pnpm --filter @paperclipai/db migrate && pnpm --filter @paperclipai/db test voice_sessions.schema`
Expected: migration succeeds, test passes.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/schema/voice_sessions.ts \
        packages/db/src/schema/index.ts \
        packages/db/migrations/<NNNN>_voice_sessions.sql \
        packages/db/src/__tests__/voice_sessions.schema.test.ts
git commit -m "feat(db): add voice_sessions table for ephemeral voice-tab transcripts"
```

### Task 3: Plumb `invocationSource` through the agent-run spawn API

**Files:**
- Modify: `server/src/services/agent-runner.ts` (or the file that builds the `INSERT INTO heartbeat_runs` payload — grep for `invocation_source` and `invocationSource`)
- Modify: the controller(s) that handle composer comment posting — search for the route that creates a heartbeat run after an issue comment is posted (likely `server/src/routes/issue-comments.ts` or similar).

You will not be the one to fire it from voice yet — that happens in chunks 2 and 5. This task only ensures the call signature accepts the new value.

- [ ] **Step 1: Find the spawn function**

Run: `rg "invocation_source" server/src`
Pick the function that builds the run row.

- [ ] **Step 2: Widen the type**

```ts
// Wherever the type is declared:
export type InvocationSource = "on_demand" | "scheduled" | "wakeup" | "voice" | "voice_session";
```

- [ ] **Step 3: Run the existing server tests**

Run: `pnpm --filter @paperclipai/server test`
Expected: no failures (you only widened a union, didn't change behavior).

- [ ] **Step 4: Commit**

```bash
git add server/src
git commit -m "feat(server): allow voice and voice_session as invocation sources"
```

### Chunk 1 Review

After Task 3 lands, dispatch the plan-document-reviewer subagent on Chunk 1 only. Fix and re-dispatch until ✅. Do NOT proceed to Chunk 2 until Chunk 1 is approved.

---

## Chunk 2: Voice-session backend (in the voice-mode plugin worker)

Adds the HTTP surface the `/voice` page talks to. Hosted inside the existing voice-mode plugin worker so all voice infrastructure stays in one package.

### Task 4: Streaming TTS helper

**Files:**
- Modify: `packages/plugins/voice-mode/src/worker/elevenlabs.ts`
- Create: `packages/plugins/voice-mode/src/worker/elevenlabs-stream.ts`
- Create: `packages/plugins/voice-mode/src/worker/elevenlabs-stream.test.ts`

The existing `elevenlabs.ts` does a single-shot synthesis. For low latency in the car we need a function that takes a `ReadableStream<string>` of text chunks (sentence-level) and returns a `ReadableStream<Uint8Array>` of audio bytes by talking to ElevenLabs' WebSocket TTS endpoint.

- [ ] **Step 1: Write the failing test**

```ts
// packages/plugins/voice-mode/src/worker/elevenlabs-stream.test.ts
import { describe, it, expect, vi } from "vitest";
import { streamTextToSpeech } from "./elevenlabs-stream.js";

describe("streamTextToSpeech", () => {
  it("emits audio bytes for each text chunk pushed", async () => {
    const fakeWs = createFakeElevenLabsWs();
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
      wsFactory: () => fakeWs,
      apiKey: "test-key",
    });
    const chunks: Uint8Array[] = [];
    for await (const chunk of audio$) chunks.push(chunk);
    expect(chunks.length).toBeGreaterThan(0);
  });
});

function createFakeElevenLabsWs(): WebSocket { /* implement: returns a stub that
  - resolves `open` immediately
  - echoes back a small Uint8Array for every text message
  - emits `close` when the test closes */
  // implementation in the file
  throw new Error("not implemented");
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @paperclipai/plugin-voice-mode test elevenlabs-stream`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `streamTextToSpeech`**

```ts
// packages/plugins/voice-mode/src/worker/elevenlabs-stream.ts
export type StreamTtsOpts = {
  voiceId: string;
  text$: ReadableStream<string>;
  apiKey: string;
  modelId?: string;          // default "eleven_turbo_v2_5"
  wsFactory?: (url: string, protocols?: string[]) => WebSocket;
};

export function streamTextToSpeech(opts: StreamTtsOpts): ReadableStream<Uint8Array> {
  const modelId = opts.modelId ?? "eleven_turbo_v2_5";
  const url =
    `wss://api.elevenlabs.io/v1/text-to-speech/${opts.voiceId}/stream-input` +
    `?model_id=${modelId}&output_format=mp3_44100_128`;
  const ws = (opts.wsFactory ?? ((u) => new WebSocket(u)))(url);

  return new ReadableStream<Uint8Array>({
    start(controller) {
      ws.binaryType = "arraybuffer";
      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({
          text: " ",
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
          xi_api_key: opts.apiKey,
        }));
        const reader = opts.text$.getReader();
        const pump = (): Promise<void> =>
          reader.read().then(({ done, value }) => {
            if (done) {
              ws.send(JSON.stringify({ text: "" }));
              return;
            }
            ws.send(JSON.stringify({ text: value, try_trigger_generation: true }));
            return pump();
          });
        void pump();
      });
      ws.addEventListener("message", (ev) => {
        const data = typeof ev.data === "string" ? JSON.parse(ev.data) : null;
        if (data?.audio) {
          const bin = Uint8Array.from(atob(data.audio), (c) => c.charCodeAt(0));
          controller.enqueue(bin);
        } else if (ev.data instanceof ArrayBuffer) {
          controller.enqueue(new Uint8Array(ev.data));
        }
        if (data?.isFinal) controller.close();
      });
      ws.addEventListener("close", () => controller.close());
      ws.addEventListener("error", (e) => controller.error(e));
    },
    cancel() {
      try { ws.close(); } catch {}
    },
  });
}
```

- [ ] **Step 4: Make the test pass**

Implement the `createFakeElevenLabsWs` helper in the test file so the test actually runs. Run the test again until green.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/voice-mode/src/worker/elevenlabs-stream.ts \
        packages/plugins/voice-mode/src/worker/elevenlabs-stream.test.ts
git commit -m "feat(voice-mode): add WebSocket streaming TTS helper"
```

### Task 5: Sentence splitter

**Files:**
- Create: `packages/plugins/voice-mode/src/worker/sentence-buffer.ts`
- Create: `packages/plugins/voice-mode/src/worker/sentence-buffer.test.ts`

Used to pipe Claude's `text_delta` events into the streaming TTS at sentence boundaries (which is the lowest latency that still sounds natural).

- [ ] **Step 1: Write the failing test**

```ts
// packages/plugins/voice-mode/src/worker/sentence-buffer.test.ts
import { describe, it, expect } from "vitest";
import { splitIntoSentences } from "./sentence-buffer.js";

describe("splitIntoSentences", () => {
  it("emits sentences as terminal punctuation arrives", () => {
    const buf = splitIntoSentences();
    expect(buf.push("Hello")).toEqual([]);
    expect(buf.push(", Dom.")).toEqual(["Hello, Dom."]);
    expect(buf.push(" Anything else?")).toEqual([" Anything else?"]);
    expect(buf.flush()).toEqual([]);
  });
  it("keeps decimals intact", () => {
    const buf = splitIntoSentences();
    expect(buf.push("Pi is 3.14 roughly.")).toEqual(["Pi is 3.14 roughly."]);
  });
  it("flushes any tail on close", () => {
    const buf = splitIntoSentences();
    buf.push("no terminator");
    expect(buf.flush()).toEqual(["no terminator"]);
  });
});
```

- [ ] **Step 2: Run, verify it fails, implement, verify it passes**

```ts
// packages/plugins/voice-mode/src/worker/sentence-buffer.ts
export function splitIntoSentences() {
  let buf = "";
  return {
    push(chunk: string): string[] {
      buf += chunk;
      const out: string[] = [];
      const re = /[^.!?]+(?:\.(?!\d)|!|\?)+(?=\s|$)/g;
      let match: RegExpExecArray | null;
      let lastEnd = 0;
      while ((match = re.exec(buf))) {
        out.push(match[0]);
        lastEnd = match.index + match[0].length;
      }
      if (lastEnd > 0) buf = buf.slice(lastEnd);
      return out;
    },
    flush(): string[] {
      const tail = buf.trim();
      buf = "";
      return tail ? [tail] : [];
    },
  };
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/plugins/voice-mode/src/worker/sentence-buffer.ts \
        packages/plugins/voice-mode/src/worker/sentence-buffer.test.ts
git commit -m "feat(voice-mode): sentence splitter for streaming TTS"
```

### Task 6: Voice session storage helpers

**Files:**
- Create: `server/src/services/voice-sessions.ts`
- Create: `server/src/services/voice-sessions.test.ts`

Thin Drizzle wrappers used by the route handlers. Lives in the server (not the plugin) because it needs DB access; the plugin worker calls back through the host-services bridge.

- [ ] **Step 1: Write the failing test**, implement, verify, commit. Standard CRUD wrappers:
  - `createVoiceSession({ companyId, userId }): Promise<{ id: string }>`
  - `appendTurn(sessionId: string, turn: VoiceTranscriptTurn): Promise<void>`
  - `endVoiceSession(sessionId: string): Promise<void>`

- [ ] **Step 2: Commit**

```bash
git add server/src/services/voice-sessions.ts server/src/services/voice-sessions.test.ts
git commit -m "feat(server): voice_sessions service helpers"
```

### Task 7: Voice tool dispatch — `create_issue`

**Files:**
- Modify: `packages/plugins/voice-mode/src/worker/routes.ts` (add tool dispatch handler)
- Create: `packages/plugins/voice-mode/src/worker/voice-tools.ts`
- Create: `packages/plugins/voice-mode/src/worker/voice-tools.test.ts`

This is the tool surface Kenn calls when Dom asks for an issue.

- [ ] **Step 1: Write the test**

```ts
// voice-tools.test.ts
import { describe, it, expect, vi } from "vitest";
import { dispatchVoiceTool } from "./voice-tools.js";

describe("dispatchVoiceTool", () => {
  it("creates an issue via the host API", async () => {
    const hostApi = { createIssue: vi.fn().mockResolvedValue({ key: "FRE-987" }) };
    const res = await dispatchVoiceTool({
      hostApi,
      name: "create_issue",
      input: { title: "Add wake word", body: "Detail.", projectKey: "FRE" },
    });
    expect(res).toEqual({ ok: true, issueKey: "FRE-987" });
    expect(hostApi.createIssue).toHaveBeenCalledWith({
      title: "Add wake word",
      body: "Detail.",
      projectKey: "FRE",
    });
  });

  it("returns a structured error when the tool fails", async () => {
    const hostApi = { createIssue: vi.fn().mockRejectedValue(new Error("project not found")) };
    const res = await dispatchVoiceTool({
      hostApi, name: "create_issue", input: { title: "x", body: "y" },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("project not found");
  });
});
```

- [ ] **Step 2: Implement, verify, commit.** Tool dispatch must return JSON-serializable results so the agent can `toolResult` back into its context. Failure modes (project missing, validation errors) must produce structured `{ ok: false, error: "..." }` results, never throw, so the agent can verbalize them per the spec's "always close the loop" rule.

### Task 8: `POST /api/voice/session` and `POST /api/voice/session/:id/turn`

**Files:**
- Modify: `packages/plugins/voice-mode/src/worker/routes.ts`
- Create: `packages/plugins/voice-mode/src/worker/voice-session.test.ts`

The `/turn` endpoint accepts the transcript text, spawns a Claude run via the host-services bridge, returns the `runId`, and streams agent output back via the existing `heartbeat.run.log` WebSocket channel. The page is the consumer — it subscribes to that channel and pipes the deltas into sentence-buffer + streaming TTS.

- [ ] **Step 1: Write a route test that exercises start → turn → end**

```ts
// voice-session.test.ts
import { describe, it, expect } from "vitest";
import { buildVoiceRouter } from "./routes.js";

describe("voice session routes", () => {
  it("creates a session, accepts a turn, returns a runId", async () => {
    const ctx = makeFakeCtx();
    const app = buildVoiceRouter(ctx);
    const create = await app.request("/api/voice/session", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ companyId: ctx.companyId }),
    });
    expect(create.status).toBe(200);
    const { sessionId } = await create.json();
    const turn = await app.request(`/api/voice/session/${sessionId}/turn`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcript: "Hello Kenn" }),
    });
    expect(turn.status).toBe(200);
    const { runId } = await turn.json();
    expect(runId).toBeTruthy();
    // The run row must be tagged with invocation_source = "voice_session"
    const row = await ctx.db.getRun(runId);
    expect(row.invocationSource).toBe("voice_session");
  });
});
```

- [ ] **Step 2: Implement the routes**

Key points:
- `POST /session`: insert a `voice_sessions` row, return `{ sessionId, agentId }` where `agentId` is the default Conrad agent for the company (resolve via existing agent registry lookup).
- `POST /session/:id/turn`:
  1. Persist the user turn via `appendTurn`.
  2. Spawn an agent run via `hostServices.spawnAgentRun({ agentId, prompt, invocationSource: "voice_session", systemPromptOverride: VOICE_SYSTEM_PROMPT, tools: [createIssueToolSchema] })`.
  3. Return `{ runId }`.
- `DELETE /session/:id`: call `endVoiceSession`.

`VOICE_SYSTEM_PROMPT` lives in `packages/plugins/voice-mode/src/worker/voice-prompt.ts`. Content:

```ts
export const VOICE_SYSTEM_PROMPT = `
You are Conrad in voice mode. The user is speaking to you out loud, often while driving.

Rules:
- Always reply in short, conversational sentences. No markdown. No code blocks. No emdashes.
- Never say more than two sentences before pausing for them to interject.
- If you call a tool, follow it with one spoken sentence confirming the outcome ("Created FRE-987, anything else?"). Tool calls without a spoken follow-up are forbidden.
- Don't apologize. Don't restate the question. Just answer or act.
`.trim();
```

- [ ] **Step 3: Run, fix, commit**

```bash
git add packages/plugins/voice-mode/src/worker/{routes,voice-tools,voice-prompt,voice-session.test}.ts
git commit -m "feat(voice-mode): /api/voice/session start + turn + end routes"
```

### Chunk 2 Review

Dispatch plan-document-reviewer on Chunk 2. Fix and re-dispatch until ✅.

---

## Chunk 3: Frontend foundations — VAD, streaming TTS, state machine

Browser plumbing the `/voice` page will consume. Standalone, testable in isolation.

### Task 9: Install `@ricky0123/vad-web`

**Files:**
- Modify: `ui/package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Install**

Run: `pnpm --filter @paperclipai/ui add @ricky0123/vad-web onnxruntime-web`
Expected: dependencies install cleanly.

- [ ] **Step 2: Copy the ONNX assets to the UI public dir**

`@ricky0123/vad-web` requires the Silero ONNX model + WASM at runtime. Per its README, copy the files from `node_modules/@ricky0123/vad-web/dist/*.onnx` and `node_modules/onnxruntime-web/dist/*.wasm` to `ui/public/vad/`. Automate via a small `prebuild` script in `ui/package.json`:

```json
"scripts": {
  "prebuild": "node scripts/copy-vad-assets.mjs",
  "predev": "node scripts/copy-vad-assets.mjs"
}
```

And:

```js
// ui/scripts/copy-vad-assets.mjs
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const targetDir = join(here, "..", "public", "vad");
mkdirSync(targetDir, { recursive: true });

const vadSrc = join(here, "..", "node_modules", "@ricky0123", "vad-web", "dist");
const ortSrc = join(here, "..", "node_modules", "onnxruntime-web", "dist");

for (const f of readdirSync(vadSrc).filter((n) => n.endsWith(".onnx") || n.endsWith(".js"))) {
  copyFileSync(join(vadSrc, f), join(targetDir, f));
}
for (const f of readdirSync(ortSrc).filter((n) => n.endsWith(".wasm"))) {
  copyFileSync(join(ortSrc, f), join(targetDir, f));
}
```

- [ ] **Step 3: Commit**

```bash
git add ui/package.json pnpm-lock.yaml ui/scripts/copy-vad-assets.mjs
git commit -m "chore(ui): add @ricky0123/vad-web and asset copy script"
```

### Task 10: `useVad` hook

**Files:**
- Create: `ui/src/hooks/useVad.ts`
- Create: `ui/src/hooks/useVad.test.tsx`

Wraps the library and exposes a clean React API.

- [ ] **Step 1: Write the test (uses a fake VAD class so this stays unit-level)**, implement, verify, commit.

```ts
// useVad.ts
import { useEffect, useRef, useState } from "react";
import { MicVAD } from "@ricky0123/vad-web";

export type VadState = "idle" | "loading" | "listening" | "speaking" | "error";

export function useVad(opts: {
  onSpeechEnd: (audio: Float32Array) => void;
  silenceMs?: number;
  enabled: boolean;
}) {
  const [state, setState] = useState<VadState>("idle");
  const vadRef = useRef<MicVAD | null>(null);

  useEffect(() => {
    if (!opts.enabled) return;
    let cancelled = false;
    setState("loading");
    MicVAD.new({
      onSpeechStart: () => !cancelled && setState("speaking"),
      onSpeechEnd: (audio) => {
        if (cancelled) return;
        setState("listening");
        opts.onSpeechEnd(audio);
      },
      onVADMisfire: () => !cancelled && setState("listening"),
      positiveSpeechThreshold: 0.5,
      negativeSpeechThreshold: 0.35,
      redemptionFrames: Math.round((opts.silenceMs ?? 1200) / 32),
      baseAssetPath: "/vad/",
      onnxWASMBasePath: "/vad/",
    })
      .then((vad) => {
        if (cancelled) { vad.destroy(); return; }
        vadRef.current = vad;
        vad.start();
        setState("listening");
      })
      .catch((e) => {
        if (!cancelled) {
          console.error("[useVad] init failed", e);
          setState("error");
        }
      });

    return () => {
      cancelled = true;
      vadRef.current?.destroy();
      vadRef.current = null;
    };
  }, [opts.enabled]);

  return { state, pause: () => vadRef.current?.pause(), resume: () => vadRef.current?.start() };
}
```

### Task 11: `useStreamingTts` hook

**Files:**
- Create: `ui/src/hooks/useStreamingTts.ts`
- Create: `ui/src/hooks/useStreamingTts.test.tsx`

Plays audio chunks as they stream in over fetch (the server proxies the ElevenLabs WS into an HTTP `transfer-encoding: chunked` response so the browser doesn't need a second WS connection).

- [ ] **Step 1: Write the failing test** (uses a `ReadableStream` of fake MP3 bytes; verify `audio` element plays).

- [ ] **Step 2: Implement**, key requirements:
  - Uses `MediaSource` API to append chunks as they arrive
  - Exposes `play(text$: ReadableStream<string>): Promise<void>`, `stop()`, and `isPlaying`
  - Stops cleanly when `stop()` is called (used for barge-in)

- [ ] **Step 3: Commit**

### Task 12: `useVoiceSessionMachine` reducer

**Files:**
- Create: `ui/src/hooks/useVoiceSessionMachine.ts`
- Create: `ui/src/hooks/useVoiceSessionMachine.test.ts`

Drives the `/voice` page state machine. Pure reducer, easy to test.

States: `idle → listening → thinking → speaking`. Transitions for barge-in, mute, error.

- [ ] **Step 1: Write the failing test covering all transitions including barge-in**, implement as a pure `useReducer`, verify, commit.

### Chunk 3 Review

Dispatch plan-document-reviewer on Chunk 3. Fix and re-dispatch until ✅.

---

## Chunk 4: `/voice` page + sidebar nav + route mount

User-visible at last.

### Task 13: `VoiceMode` page component

**Files:**
- Create: `ui/src/pages/VoiceMode.tsx`
- Create: `ui/src/pages/VoiceMode.test.tsx`
- Create: `ui/src/components/voice/VoiceOrb.tsx`
- Create: `ui/src/components/voice/VoiceScrollback.tsx`
- Create: `ui/src/components/voice/VoiceControls.tsx`

The page is the orchestrator. It uses `useVad`, `useStreamingTts`, `useVoiceSessionMachine` from chunk 3, and the new POST `/api/voice/session*` routes from chunk 2.

- [ ] **Step 1: Write a high-level component test**

```tsx
// VoiceMode.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { VoiceMode } from "./VoiceMode";
// mock the hooks; verify the page renders an orb, scrollback, controls, and starts a session on mount.
```

- [ ] **Step 2: Implement the page**

Layout (mobile-first):
```
┌──────────────────────────────────┐
│  [End]            [Mute]  [Stop] │  ← top bar (44pt tap targets)
├──────────────────────────────────┤
│                                  │
│       (last 6 transcript         │
│        turns, small text)        │
│                                  │
├──────────────────────────────────┤
│                                  │
│            ◯  ← orb              │
│                                  │
│      "Listening..."              │
│                                  │
└──────────────────────────────────┘
```

Orb states map directly to machine states:
- `idle` — dim grey, no animation
- `listening` — soft pulse
- `thinking` — slow rotate
- `speaking` — fast pulse synced to audio peaks via `AnalyserNode.getByteFrequencyData`

- [ ] **Step 3: Verify the test passes, commit**

### Task 14: Route mount

**Files:**
- Modify: `ui/src/App.tsx` — add `<Route path="voice" element={<VoiceMode />} />` inside `boardRoutes()` (around line 167, next to `status`).
- Modify: `ui/src/App.tsx` top imports — add `import { VoiceMode } from "./pages/VoiceMode";`.

- [ ] **Step 1: Add the route**, run `pnpm --filter @paperclipai/ui dev`, browse to `/<companyPrefix>/voice`, confirm the page mounts.
- [ ] **Step 2: Commit**

### Task 15: Sidebar nav item

**Files:**
- Modify: `ui/src/components/Sidebar.tsx`

- [ ] **Step 1: Add `Mic` to the lucide import (line 1-15).**
- [ ] **Step 2: Inside the `<SidebarSection label="Work">` block (line 101-106), add:**

```tsx
<SidebarNavItem to="/voice" label="Voice Mode" icon={Mic} />
```

Place it last in the Work group so it sits visually below `Goals`.

- [ ] **Step 3: Verify in browser, commit**

### Task 16: Manual end-to-end smoke

- [ ] Open `/<companyPrefix>/voice` in Firefox on desktop.
- [ ] Grant mic permission.
- [ ] Say "Hello Kenn, what time is it?" Verify VAD cuts after silence, transcript appears, Kenn streams a reply, audio plays.
- [ ] Interrupt mid-reply by speaking. Verify audio stops within ~200ms.
- [ ] Say "Create an issue under FRE about adding wake word support." Verify the issue is created and Kenn confirms the new FRE id verbally.
- [ ] Hit End. Verify the page returns to `/dashboard` and the session row's `endedAt` is set.

### Chunk 4 Review

Dispatch plan-document-reviewer on Chunk 4.

---

## Chunk 5: Close the loop on composer voice flow

Two fixes for the existing composer mic so it matches the new voice tab's "always speak the result" contract.

### Task 17: Echo transcript into composer on auto-send

**Files:**
- Modify: `packages/plugins/voice-mode/src/ui/index.tsx` (the `VoiceComposerControlsSlot` wrapper that listens for `voice-mode:auto-send`)
- Modify: `packages/plugins/voice-mode/src/ui/VoiceComposerControls.tsx` if needed

Currently the auto-send branch dispatches a synthetic submit event without writing to the composer textarea. Dom wants to see what was heard before it sends.

- [ ] **Step 1: Write the failing test** in `VoiceComposerControls.test.tsx` that asserts: when in auto-send mode, the transcript is inserted into the composer FIRST, then submit fires after a 300ms delay.

- [ ] **Step 2: Implement.** The pattern:
  1. Call `onTranscript(text)` (which already routes to the composer's insert handler).
  2. `setTimeout(() => dispatchSubmit(), 300)`.

- [ ] **Step 3: Verify, commit**

### Task 18: Tag composer-originated agent runs with `invocation_source = "voice"`

**Files:**
- Modify: the comment-post route or service that triggers the agent. Find via `rg "spawn.*Run|spawnAgentRun|invocation_source"` in `server/src`.

The composer's auto-send needs to add a header or query param indicating the run came from voice. Simplest: a header `x-paperclip-origin: voice` set by `VoiceComposerControls` when dispatching submit, picked up by the server route, passed into `spawnAgentRun({ invocationSource: "voice" })`.

- [ ] **Step 1: Failing test** in the comment-post route test file: posting a comment with the voice header creates a run with `invocation_source = "voice"`.
- [ ] **Step 2: Implement**, verify, commit.

### Task 19: Auto-play final reply for voice-tagged runs in the composer mic UI

**Files:**
- Modify: `packages/plugins/voice-mode/src/ui/VoiceComposerControls.tsx` (or a sibling component)
- Possibly: a new hook `useAutoPlayVoiceReply` in the plugin's UI tree

The plugin already has access to the `heartbeat.run.log` WebSocket via host bridge. Subscribe to runs for the current issue; when a run with `invocationSource === "voice"` completes, fetch its final assistant comment body, run it through `/api/plugins/voice-mode/speak`, and play it.

- [ ] **Step 1: Failing test** asserting that when a voice-tagged run completes, `speak` is called with the final assistant comment body.
- [ ] **Step 2: Implement**, verify, commit.

### Task 20: Update agent system prompt for voice-tagged runs

**Files:**
- Modify: wherever the agent system prompt is assembled — search `rg "systemPrompt|system_prompt" server/src | head`.

When `invocationSource === "voice" || "voice_session"`, prepend the VOICE_SYSTEM_PROMPT shim (same content as in Task 8). This guarantees agents under voice always end with a spoken summary, even on tool-only turns.

- [ ] **Step 1: Failing test**: building the system prompt with `invocationSource: "voice"` includes the voice rule lines.
- [ ] **Step 2: Implement**, verify, commit.

### Chunk 5 Review

Dispatch plan-document-reviewer on Chunk 5.

---

## Chunk 6: Cleanup, flag, and ship

### Task 21: Feature flag

**Files:**
- Modify: server bootstrap to read `VOICE_MODE_TAB_ENABLED` env var.
- Modify: `ui/src/components/Sidebar.tsx` to hide the Voice Mode nav item when the flag is off.
- Modify: `ui/src/App.tsx` to mount a redirect to `/dashboard` instead of `<VoiceMode />` when the flag is off.

The flag is wired via the existing `/api/health` response (which the UI already reads in `CloudAccessGate`); add a `features.voiceModeTab` boolean to the health payload and consume it.

- [ ] **Step 1: Failing test on the health endpoint** asserting `features.voiceModeTab` is `false` by default and `true` when env var is set.
- [ ] **Step 2: Implement**, verify, commit.

### Task 22: Remove the `commentAnnotation` slot registration

Dom explicitly said he doesn't want per-comment speaker icons. The component stays (in case we want it back), but unregister the slot in the manifest.

**Files:**
- Modify: `packages/plugins/voice-mode/src/manifest.ts` — remove the `commentAnnotation` slot block.
- Rebuild and verify `/api/plugins/ui-contributions` no longer lists it.

- [ ] **Step 1: Edit, rebuild plugin bundle, verify**, commit.

### Task 23: Build and ship

- [ ] Run `bash scripts/prepare-server-ui-dist.sh` to bake the UI into `server/ui-dist`.
- [ ] Restart the paperclip pm2 process: `pm2 restart paperclip`.
- [ ] Flip the env var: `pm2 restart paperclip --update-env` after exporting `VOICE_MODE_TAB_ENABLED=true`.
- [ ] Post a "ready to test" comment on FRE-968 listing the manual test script from Task 16.

### Final review

Dispatch plan-document-reviewer on Chunks 5–6 together.

---

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| VAD false-triggers on road noise / passenger speech | Tune `positiveSpeechThreshold` upward (default 0.5 → start at 0.6). Add a "noise floor calibration" pass on `/voice` mount (3 seconds of ambient capture). |
| ElevenLabs WS quota / cost spikes | Voice-tab sessions cap at 15 minutes; auto-end and prompt to reopen. Log per-session character counts to `voice_sessions.transcript` for retroactive cost analysis. |
| Streaming TTS latency too high on mobile networks | Fall back to single-shot TTS (existing `/api/plugins/voice-mode/speak`) when the first chunk doesn't arrive within 1.5 s. |
| MediaSource not supported on iOS Safari | Polyfill via `<audio>` element with sequential Blob playback. Detect support upfront; downgrade UX gracefully. |
| Voice agent calls `create_issue` with wrong project | System prompt rule: default to the current company prefix; if Dom didn't say which project, ask before creating. |
| User loses cell signal mid-session | WS auto-reconnect with 3-attempt backoff; if it fails, fall through to a visible "Reconnect" CTA. |

## Out-of-scope follow-ups (file as separate FREs after ship)

- Wake word ("Hey Conrad")
- Voice picker
- Per-issue voice (tap an issue, then `/voice` talks to that thread)
- iOS Siri Shortcut → open `/voice`
- Background continuous mode for CarPlay
