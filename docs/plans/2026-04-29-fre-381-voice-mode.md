# Voice Mode Implementation Plan (FRE-381)

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add voice input (ElevenLabs Scribe STT) and voice output (ElevenLabs TTS) to this Paperclip instance via a new plugin, gated per-user behind a voice-mode toggle.

**Architecture:** Ship as a Paperclip plugin (not a core fork) — `paperclipai/paperclip` is upstream OSS, and a plugin keeps the change instance-local, distributable, and re-installable across upgrades. Plugin contributes: (1) two server routes for STT/TTS proxied through ElevenLabs, (2) UI slot controls injected into the issue-chat composer, (3) a `useVoiceMode` hook + audio playback queue, (4) a per-user toggle persisted to `localStorage`, (5) a per-agent voice mapping persisted to plugin-local KV (avoids upstream schema changes). Agent default = Kenn Akomea (`VjSFSNiy9sK85Z9QRu3d`).

**Tech Stack:** Paperclip Plugin SDK (`@paperclipai/plugin-sdk`), Express server routes, React hooks, browser `MediaRecorder` API, ElevenLabs Scribe (STT) + ElevenLabs TTS (mp3), `fetch` for vendor calls.

---

## Locked Decisions (from FRE-381 thread)

| # | Decision | Lock |
|---|---|---|
| 1 | Mic UX | Click-to-toggle button + spacebar push-to-talk |
| 2 | After transcription | Auto-send (no edit step) |
| 3 | Auto-speak scope | Only when voice mode is ON for current issue |
| 4 | Voice for output | Per-agent in agent settings, default Kenn Akomea |
| 5 | Surface scope | Everywhere comments post (V1 = `IssueChatThread` covers all) |
| 6 | Instance gating | Per-user preference (browser localStorage) |
| 7 | Stop while speaking | Spacebar OR stop button |
| 8 | TTS delivery | Wait for full mp3, then play |
| 9 | Audio retention | Keep raw mic audio 24h, then auto-delete |
| 10 | Mobile | Desktop only V1, mobile V2 |

---

## Plan Deviations (discovered during Task 1 — apply to all subsequent tasks)

The scaffold tool's actual behavior differs from what was assumed. Subsequent tasks should treat these as overrides:

1. **Package name is unscoped: `voice-mode`** (not `@paperclipai/voice-mode`). All `pnpm --filter @paperclipai/voice-mode <cmd>` references in this plan should be read as `pnpm --filter voice-mode <cmd>`.
2. **No `--capabilities` CLI flag.** Capabilities live in `src/manifest.ts` as a hardcoded array. Defaults: `["events.subscribe", "plugin.state.read", "plugin.state.write"]`. **Task 2 must edit `src/manifest.ts` to add `"http.fetch"` and `"secrets.read"`** before any vendor calls or secret reads.
3. **Worker is a single file `src/worker.ts`**, not `src/worker/index.ts`. **Task 3 should restructure** by moving `src/worker.ts` → `src/worker/index.ts` and creating sibling files (`routes.ts`, `elevenlabs.ts`, `audio-store.ts`).
4. **Manifest format is a TS module (`src/manifest.ts`)** that exports the manifest object, not a static `plugin.manifest.json`. The "Files" lines in subsequent tasks that reference `plugin.manifest.json` should target `src/manifest.ts` instead.
5. **Install requires dev deps.** If running with `NODE_ENV=production`, use `NODE_ENV=development pnpm install --no-frozen-lockfile`. Lockfile changes from this are expected and should be committed.

### Plan Deviations from Tasks 2-6 (SDK reality vs plan assumptions)

The Paperclip Plugin SDK API differs from the plan's assumptions in 4 places. **All subsequent UI tasks must use the real API names:**

6. **Capability names:** `"http.fetch"` -> **`"http.outbound"`**; `"secrets.read"` -> **`"secrets.read-ref"`**.
7. **Secret read API:** `ctx.secrets.read("KEY")` does NOT exist. Real API is **`ctx.secrets.resolve(secretRef)`**.
8. **No inbound HTTP routes for plugins.** Plugins cannot register Express routes. Routes are implemented as **actions** via `ctx.actions.register("action.name", handler)`. UI calls via **`usePluginAction("action.name")`**. Implemented:
   - `voice.transcribe` — input `{audioBase64, mime}`, output `{transcript, audioId}`
   - `voice.speak` — input `{text, voiceId}`, output `{audioBase64}` (base64-encoded mp3; UI must decode to Blob)
9. **State storage API:** `ctx.storage.get/set` does NOT exist. Real API is **`ctx.state.get/set(scopeKey, value)`**. Used in Task 13 for per-agent voice mapping.

### Secret Registration Blocker (manual action required from Dom)

Task 2b attempted `POST /api/companies/.../secrets` programmatically — endpoint requires board-level auth, and the agent's `PAPERCLIP_API_KEY` JWT does not have board access. **Dom must register `ELEVENLABS_API_KEY` manually** via Instance Settings UI (or board CLI). Value: the "For Voice Assistant" key from `ElevenLabs API Keys vault item` in the team password vault. Until registered, the plugin's `voice.transcribe` and `voice.speak` actions will throw on `ctx.secrets.resolve()`. Smoke test (Task 14) is blocked on this.

---

## File Structure

**New plugin package:** `packages/plugins/voice-mode/` (in-repo for V1; can be extracted to its own repo later).

```
packages/plugins/voice-mode/
├── package.json
├── plugin.manifest.json          # capabilities: ["http.fetch", "secrets.read"]
├── src/
│   ├── worker/
│   │   ├── index.ts              # plugin worker entry
│   │   ├── routes.ts             # registers /voice/transcribe + /voice/speak
│   │   ├── elevenlabs.ts         # vendor SDK wrapper (Scribe + TTS)
│   │   ├── audio-store.ts        # 24h TTL audio storage
│   │   └── audio-store.test.ts
│   ├── ui/
│   │   ├── index.tsx             # plugin UI entry (registers slots)
│   │   ├── useVoiceMode.ts       # hook: toggle state, recording, playback queue
│   │   ├── useVoiceMode.test.ts
│   │   ├── VoiceComposerControls.tsx
│   │   ├── VoiceComposerControls.test.tsx
│   │   ├── MessageSpeakerButton.tsx
│   │   ├── VoiceSettingsPanel.tsx     # per-user toggle + per-agent voice picker
│   │   └── api.ts                # client wrappers: transcribeAudio, speakText
│   └── shared/
│       ├── types.ts              # shared request/response types
│       └── voices.ts             # voice catalog (Kenn + a few alternates)
└── README.md
```

**Modified files (Paperclip core, only if a slot doesn't exist):**
- `packages/shared/src/plugin-slots.ts` — add `chat-composer-trailing` slot if missing
- `ui/src/components/IssueChatThread.tsx:1684-1758` — render plugin slot in composer controls row
- `ui/src/components/IssueChatThread.tsx:~1500` — render plugin slot near each assistant message bubble for `MessageSpeakerButton`

**Net diff to Paperclip core: ≤30 lines (slot registration only).**

---

## Open Architectural Sub-Decision

**Per-agent voice config (decision 4b):** Agents are core entities. Two options for storing `voiceId` per agent:
- **(A)** Add `voiceId` field upstream in `packages/shared/src/validators/agent.ts` + DB migration. Requires upstream PR or maintaining a fork.
- **(B)** Store mapping `{agentId -> voiceId}` in plugin-local KV (via `@paperclipai/plugin-sdk` storage). No core change.

**Recommendation: B.** Keeps the plugin self-contained. Picker lives in the plugin's own settings panel, not the core agent settings page. If we later upstream the plugin, switch to A.

---

## Chunk 1: Plugin Scaffold + Server Routes

### Task 1: Scaffold the plugin package

**Files:**
- Create: `packages/plugins/voice-mode/` (entire skeleton via scaffold)

- [ ] **Step 1: Build the plugin scaffold**

```bash
cd ~/paperclip
pnpm --filter @paperclipai/create-paperclip-plugin build
```

Expected: scaffold dist exists at `packages/plugins/create-paperclip-plugin/dist/index.js`.

- [ ] **Step 2: Generate the plugin skeleton**

```bash
cd ~/paperclip
node packages/plugins/create-paperclip-plugin/dist/index.js voice-mode \
  --output packages/plugins/voice-mode \
  --capabilities http.fetch,secrets.read
```

Expected: `packages/plugins/voice-mode/` exists with `package.json`, `plugin.manifest.json`, `src/worker/index.ts`, `src/ui/index.tsx`.

- [ ] **Step 3: Wire into pnpm workspace**

Verify `pnpm-workspace.yaml` already globs `packages/plugins/*` — if so, no edit needed. If not, add `packages/plugins/voice-mode` explicitly.

Run: `pnpm install`
Expected: voice-mode appears in workspace package list.

- [ ] **Step 4: Commit scaffold**

```bash
git checkout -b feat/fre-381-voice-mode
git add packages/plugins/voice-mode pnpm-workspace.yaml
git commit -m "feat(voice-mode): scaffold plugin package (FRE-381)"
```

### Task 2: Add ELEVENLABS_API_KEY to instance secrets

**Files:**
- Modify: instance secrets registration (one-time op, not code commit)

- [ ] **Step 1: Register the secret on this instance**

```bash
curl -s -X POST -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"key":"ELEVENLABS_API_KEY","value":"<paste from 1Password the team password vault>"}' \
  "$PAPERCLIP_API_URL/api/secrets"
```

Expected: 201 Created. Confirm read-back via GET (value redacted in response).

- [ ] **Step 2: Document the key in plugin README**

Add to `packages/plugins/voice-mode/README.md`:

```markdown
## Required secrets
- `ELEVENLABS_API_KEY` — your ElevenLabs API key (Scribe + TTS access).
  Set via `POST /api/secrets` or the Instance Settings UI.
```

- [ ] **Step 3: Commit**

```bash
git add packages/plugins/voice-mode/README.md
git commit -m "docs(voice-mode): document ELEVENLABS_API_KEY requirement"
```

### Task 3: Audio store with 24h TTL

**Files:**
- Create: `packages/plugins/voice-mode/src/worker/audio-store.ts`
- Test: `packages/plugins/voice-mode/src/worker/audio-store.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// audio-store.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createAudioStore } from "./audio-store";

describe("audioStore", () => {
  beforeEach(() => vi.useFakeTimers());

  it("stores audio bytes under a generated id and retrieves them", async () => {
    const store = createAudioStore({ ttlMs: 24 * 60 * 60 * 1000 });
    const id = await store.put(new Uint8Array([1, 2, 3]));
    const got = await store.get(id);
    expect(got).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("returns null after TTL elapses", async () => {
    const store = createAudioStore({ ttlMs: 24 * 60 * 60 * 1000 });
    const id = await store.put(new Uint8Array([9]));
    vi.advanceTimersByTime(25 * 60 * 60 * 1000);
    expect(await store.get(id)).toBeNull();
  });

  it("sweep() removes expired entries", async () => {
    const store = createAudioStore({ ttlMs: 1000 });
    const id = await store.put(new Uint8Array([1]));
    vi.advanceTimersByTime(2000);
    await store.sweep();
    expect(await store.get(id)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test, expect FAIL**

```bash
pnpm --filter @paperclipai/voice-mode test audio-store
```

Expected: FAIL with "createAudioStore is not a function".

- [ ] **Step 3: Minimal implementation**

```typescript
// audio-store.ts
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
```

- [ ] **Step 4: Run test, expect PASS**

```bash
pnpm --filter @paperclipai/voice-mode test audio-store
```

Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/voice-mode/src/worker/audio-store.ts \
        packages/plugins/voice-mode/src/worker/audio-store.test.ts
git commit -m "feat(voice-mode): add audio store with 24h TTL (FRE-381)"
```

### Task 4: ElevenLabs vendor wrapper

**Files:**
- Create: `packages/plugins/voice-mode/src/worker/elevenlabs.ts`
- Test: `packages/plugins/voice-mode/src/worker/elevenlabs.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// elevenlabs.test.ts
import { describe, it, expect, vi } from "vitest";
import { createElevenLabsClient } from "./elevenlabs";

describe("elevenlabs client", () => {
  it("transcribe() POSTs audio to /v1/speech-to-text and returns transcript", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: "hello world" }),
    });
    const client = createElevenLabsClient({ apiKey: "k", fetch: fetchMock });
    const out = await client.transcribe(new Uint8Array([1, 2]), "audio/webm");
    expect(out).toBe("hello world");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("speech-to-text");
    expect(init.headers["xi-api-key"]).toBe("k");
  });

  it("speak() POSTs to /v1/text-to-speech/<voice> and returns mp3 bytes", async () => {
    const bytes = new Uint8Array([0xff, 0xfb]);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => bytes.buffer,
    });
    const client = createElevenLabsClient({ apiKey: "k", fetch: fetchMock });
    const out = await client.speak("hi", "voice123");
    expect(out).toEqual(bytes);
    expect(fetchMock.mock.calls[0][0]).toContain("text-to-speech/voice123");
  });

  it("transcribe() throws on 4xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false, status: 401, text: async () => "bad key",
    });
    const client = createElevenLabsClient({ apiKey: "k", fetch: fetchMock });
    await expect(client.transcribe(new Uint8Array([1]), "audio/webm"))
      .rejects.toThrow(/elevenlabs/i);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `pnpm --filter @paperclipai/voice-mode test elevenlabs`
Expected: FAIL "createElevenLabsClient not exported".

- [ ] **Step 3: Implementation**

```typescript
// elevenlabs.ts
type FetchFn = typeof fetch;

export interface ElevenLabsClient {
  transcribe(audio: Uint8Array, mime: string): Promise<string>;
  speak(text: string, voiceId: string): Promise<Uint8Array>;
}

export function createElevenLabsClient(opts: {
  apiKey: string;
  fetch?: FetchFn;
  baseUrl?: string;
}): ElevenLabsClient {
  const fetchFn = opts.fetch ?? fetch;
  const baseUrl = opts.baseUrl ?? "https://api.elevenlabs.io";
  return {
    async transcribe(audio, mime) {
      const form = new FormData();
      form.append("file", new Blob([audio], { type: mime }), "audio.webm");
      form.append("model_id", "scribe_v1");
      const res = await fetchFn(`${baseUrl}/v1/speech-to-text`, {
        method: "POST",
        headers: { "xi-api-key": opts.apiKey } as any,
        body: form as any,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`elevenlabs STT failed: ${res.status} ${body}`);
      }
      const json = await res.json();
      return String(json.text ?? "");
    },
    async speak(text, voiceId) {
      const res = await fetchFn(
        `${baseUrl}/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
        {
          method: "POST",
          headers: {
            "xi-api-key": opts.apiKey,
            "content-type": "application/json",
            accept: "audio/mpeg",
          } as any,
          body: JSON.stringify({ text, model_id: "eleven_turbo_v2_5" }),
        },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`elevenlabs TTS failed: ${res.status} ${body}`);
      }
      const buf = await res.arrayBuffer();
      return new Uint8Array(buf);
    },
  };
}
```

- [ ] **Step 4: Run, expect PASS**

Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/voice-mode/src/worker/elevenlabs.ts \
        packages/plugins/voice-mode/src/worker/elevenlabs.test.ts
git commit -m "feat(voice-mode): add ElevenLabs Scribe + TTS client wrapper (FRE-381)"
```

### Task 5: Wire plugin server routes

**Files:**
- Modify: `packages/plugins/voice-mode/src/worker/index.ts`
- Create: `packages/plugins/voice-mode/src/worker/routes.ts`
- Test: `packages/plugins/voice-mode/src/worker/routes.test.ts`

- [ ] **Step 1: Write failing route test**

```typescript
// routes.test.ts
import { describe, it, expect, vi } from "vitest";
import { registerRoutes } from "./routes";

describe("voice routes", () => {
  it("POST /voice/transcribe returns transcript and audioId", async () => {
    const ctx = {
      secrets: { read: vi.fn().mockResolvedValue("test-key") },
      logger: { info: vi.fn(), error: vi.fn() },
    };
    const fakeClient = {
      transcribe: vi.fn().mockResolvedValue("hello"),
      speak: vi.fn(),
    };
    const store = {
      put: vi.fn().mockResolvedValue("audio-1"),
      get: vi.fn(),
      sweep: vi.fn(),
    };
    const router: any = { post: vi.fn(), get: vi.fn() };
    registerRoutes(router, ctx as any, { client: fakeClient, store });

    const transcribeHandler = router.post.mock.calls.find(
      (c: any) => c[0] === "/voice/transcribe",
    )[1];
    const req = { body: { audioBase64: "AQI=", mime: "audio/webm" } };
    const res: any = { json: vi.fn(), status: vi.fn(() => res) };
    await transcribeHandler(req, res);
    expect(fakeClient.transcribe).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ transcript: "hello", audioId: "audio-1" });
  });

  it("POST /voice/speak returns mp3 bytes", async () => {
    const ctx = { secrets: { read: vi.fn().mockResolvedValue("test-key") }, logger: { info: vi.fn(), error: vi.fn() } };
    const bytes = new Uint8Array([0xff, 0xfb, 0x90]);
    const fakeClient = { transcribe: vi.fn(), speak: vi.fn().mockResolvedValue(bytes) };
    const store = { put: vi.fn(), get: vi.fn(), sweep: vi.fn() };
    const router: any = { post: vi.fn(), get: vi.fn() };
    registerRoutes(router, ctx as any, { client: fakeClient, store });
    const handler = router.post.mock.calls.find((c: any) => c[0] === "/voice/speak")[1];
    const req = { body: { text: "hi", voiceId: "v" } };
    const res: any = { send: vi.fn(), set: vi.fn(() => res), status: vi.fn(() => res) };
    await handler(req, res);
    expect(res.set).toHaveBeenCalledWith("content-type", "audio/mpeg");
    expect(res.send).toHaveBeenCalledWith(Buffer.from(bytes));
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `pnpm --filter @paperclipai/voice-mode test routes`
Expected: FAIL "registerRoutes not exported".

- [ ] **Step 3: Implementation**

```typescript
// routes.ts
import type { Router } from "express";
import type { PluginWorkerContext } from "@paperclipai/plugin-sdk";
import type { ElevenLabsClient } from "./elevenlabs";
import type { AudioStore } from "./audio-store";

export function registerRoutes(
  router: Router,
  _ctx: PluginWorkerContext,
  deps: { client: ElevenLabsClient; store: AudioStore },
) {
  router.post("/voice/transcribe", async (req, res) => {
    try {
      const { audioBase64, mime } = req.body ?? {};
      if (!audioBase64 || typeof audioBase64 !== "string") {
        return res.status(400).json({ error: "audioBase64 required" });
      }
      const bytes = Uint8Array.from(Buffer.from(audioBase64, "base64"));
      const transcript = await deps.client.transcribe(bytes, mime ?? "audio/webm");
      const audioId = await deps.store.put(bytes);
      res.json({ transcript, audioId });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/voice/speak", async (req, res) => {
    try {
      const { text, voiceId } = req.body ?? {};
      if (!text || !voiceId) return res.status(400).json({ error: "text and voiceId required" });
      const audio = await deps.client.speak(String(text), String(voiceId));
      res.set("content-type", "audio/mpeg").send(Buffer.from(audio));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/voice/audio/:id", async (req, res) => {
    const bytes = await deps.store.get(req.params.id);
    if (!bytes) return res.status(404).end();
    res.set("content-type", "audio/webm").send(Buffer.from(bytes));
  });
}
```

Update `worker/index.ts` to wire `registerRoutes` into the plugin worker bootstrap, reading `ELEVENLABS_API_KEY` from `ctx.secrets.read("ELEVENLABS_API_KEY")` and constructing client + store.

- [ ] **Step 4: Run all worker tests**

```bash
pnpm --filter @paperclipai/voice-mode test
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/voice-mode/src/worker
git commit -m "feat(voice-mode): wire STT + TTS server routes (FRE-381)"
```

### Task 6: Sweep job for 24h cleanup

**Files:**
- Modify: `packages/plugins/voice-mode/src/worker/index.ts`

- [ ] **Step 1: Add interval sweeper**

In worker bootstrap, after store creation, add:

```typescript
const SWEEP_MS = 60 * 60 * 1000; // hourly
const sweepTimer = setInterval(() => {
  store.sweep().catch((err) => ctx.logger.error("voice-mode sweep failed", err));
}, SWEEP_MS);
ctx.onShutdown?.(() => clearInterval(sweepTimer));
```

- [ ] **Step 2: Verify worker still loads**

Run: `pnpm --filter @paperclipai/voice-mode build && pnpm --filter @paperclipai/voice-mode test`
Expected: green.

- [ ] **Step 3: Commit**

```bash
git add packages/plugins/voice-mode/src/worker/index.ts
git commit -m "feat(voice-mode): add hourly TTL sweeper (FRE-381)"
```

---

## Chunk 2: UI — Hook + Composer Controls

### Task 7: useVoiceMode hook

**Files:**
- Create: `packages/plugins/voice-mode/src/ui/useVoiceMode.ts`
- Test: `packages/plugins/voice-mode/src/ui/useVoiceMode.test.ts`

- [ ] **Step 1: Write failing test (toggle persistence)**

```typescript
// useVoiceMode.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useVoiceMode } from "./useVoiceMode";

describe("useVoiceMode", () => {
  beforeEach(() => localStorage.clear());

  it("starts disabled by default", () => {
    const { result } = renderHook(() => useVoiceMode());
    expect(result.current.enabled).toBe(false);
  });

  it("toggle persists to localStorage", () => {
    const { result, rerender } = renderHook(() => useVoiceMode());
    act(() => result.current.toggle());
    expect(localStorage.getItem("paperclip:voiceMode:enabled")).toBe("true");
    rerender();
    expect(result.current.enabled).toBe(true);
  });

  it("isRecording flips when startRecording/stopRecording called", async () => {
    const { result } = renderHook(() => useVoiceMode());
    expect(result.current.isRecording).toBe(false);
    await act(() => result.current.startRecording());
    expect(result.current.isRecording).toBe(true);
    await act(() => result.current.stopRecording());
    expect(result.current.isRecording).toBe(false);
  });
});
```

(Mock `MediaRecorder` and `navigator.mediaDevices.getUserMedia` in test setup; see existing UI test setup for vitest jsdom config.)

- [ ] **Step 2: Run, expect FAIL**

Run: `pnpm --filter @paperclipai/voice-mode test useVoiceMode`
Expected: FAIL "useVoiceMode not exported".

- [ ] **Step 3: Implementation**

```typescript
// useVoiceMode.ts
import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY = "paperclip:voiceMode:enabled";

export interface UseVoiceModeResult {
  enabled: boolean;
  toggle: () => void;
  isRecording: boolean;
  isSpeaking: boolean;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<Blob | null>;
  playAudio: (mp3: Blob) => Promise<void>;
  stopSpeaking: () => void;
}

export function useVoiceMode(): UseVoiceModeResult {
  const [enabled, setEnabled] = useState(() => localStorage.getItem(STORAGE_KEY) === "true");
  const [isRecording, setIsRecording] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const toggle = useCallback(() => {
    setEnabled((prev) => {
      const next = !prev;
      localStorage.setItem(STORAGE_KEY, String(next));
      return next;
    });
  }, []);

  const startRecording = useCallback(async () => {
    if (recorderRef.current) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
    chunksRef.current = [];
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
    recorder.start();
    recorderRef.current = recorder;
    setIsRecording(true);
  }, []);

  const stopRecording = useCallback(async (): Promise<Blob | null> => {
    const recorder = recorderRef.current;
    if (!recorder) return null;
    return new Promise((resolve) => {
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        recorder.stream.getTracks().forEach((t) => t.stop());
        recorderRef.current = null;
        setIsRecording(false);
        resolve(blob);
      };
      recorder.stop();
    });
  }, []);

  const playAudio = useCallback(async (mp3: Blob) => {
    const url = URL.createObjectURL(mp3);
    const audio = new Audio(url);
    audioRef.current = audio;
    setIsSpeaking(true);
    try {
      await audio.play();
      await new Promise<void>((resolve) => {
        audio.onended = () => resolve();
      });
    } finally {
      URL.revokeObjectURL(url);
      audioRef.current = null;
      setIsSpeaking(false);
    }
  }, []);

  const stopSpeaking = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
      setIsSpeaking(false);
    }
  }, []);

  // Spacebar: push-to-talk while held; or stop speaking if speaking.
  useEffect(() => {
    if (!enabled) return;
    let downAt = 0;
    const onDown = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable) return;
      if (isSpeaking) { stopSpeaking(); e.preventDefault(); return; }
      if (!isRecording) { downAt = Date.now(); void startRecording(); e.preventDefault(); }
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      if (isRecording && Date.now() - downAt > 200) {
        void stopRecording().then((blob) => {
          if (blob) window.dispatchEvent(new CustomEvent("voice-mode:transcribe", { detail: blob }));
        });
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => { window.removeEventListener("keydown", onDown); window.removeEventListener("keyup", onUp); };
  }, [enabled, isRecording, isSpeaking, startRecording, stopRecording, stopSpeaking]);

  return { enabled, toggle, isRecording, isSpeaking, startRecording, stopRecording, playAudio, stopSpeaking };
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `pnpm --filter @paperclipai/voice-mode test useVoiceMode`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/voice-mode/src/ui/useVoiceMode.ts \
        packages/plugins/voice-mode/src/ui/useVoiceMode.test.ts
git commit -m "feat(voice-mode): add useVoiceMode hook with localStorage + spacebar handler (FRE-381)"
```

### Task 8: API client wrappers

**Files:**
- Create: `packages/plugins/voice-mode/src/ui/api.ts`

- [ ] **Step 1: Implementation (no tests needed — thin fetch wrappers)**

```typescript
// api.ts
const PLUGIN_BASE = "/api/plugins/voice-mode";

export async function transcribeAudio(blob: Blob): Promise<{ transcript: string; audioId: string }> {
  const audioBase64 = await blobToBase64(blob);
  const res = await fetch(`${PLUGIN_BASE}/voice/transcribe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ audioBase64, mime: blob.type || "audio/webm" }),
  });
  if (!res.ok) throw new Error(`transcribe failed: ${res.status}`);
  return res.json();
}

export async function speakText(text: string, voiceId: string): Promise<Blob> {
  const res = await fetch(`${PLUGIN_BASE}/voice/speak`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, voiceId }),
  });
  if (!res.ok) throw new Error(`speak failed: ${res.status}`);
  return res.blob();
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  return Buffer.from(buf).toString("base64");
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/plugins/voice-mode/src/ui/api.ts
git commit -m "feat(voice-mode): add UI api client wrappers (FRE-381)"
```

### Task 9: VoiceComposerControls component

**Files:**
- Create: `packages/plugins/voice-mode/src/ui/VoiceComposerControls.tsx`
- Test: `packages/plugins/voice-mode/src/ui/VoiceComposerControls.test.tsx`

- [ ] **Step 1: Write failing render test**

```tsx
// VoiceComposerControls.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { VoiceComposerControls } from "./VoiceComposerControls";

describe("VoiceComposerControls", () => {
  it("renders mic + toggle buttons", () => {
    render(<VoiceComposerControls onTranscript={vi.fn()} />);
    expect(screen.getByRole("button", { name: /voice mode/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /mic|record/i })).toBeInTheDocument();
  });

  it("clicking mic when voice mode disabled does nothing", () => {
    const onTranscript = vi.fn();
    render(<VoiceComposerControls onTranscript={onTranscript} />);
    fireEvent.click(screen.getByRole("button", { name: /mic|record/i }));
    expect(onTranscript).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implementation**

```tsx
// VoiceComposerControls.tsx
import { useEffect } from "react";
import { Mic, MicOff, Volume2, VolumeX } from "lucide-react";
import { useVoiceMode } from "./useVoiceMode";
import { transcribeAudio } from "./api";

interface Props {
  onTranscript: (text: string) => void;
}

export function VoiceComposerControls({ onTranscript }: Props) {
  const vm = useVoiceMode();

  useEffect(() => {
    const handler = async (e: Event) => {
      const blob = (e as CustomEvent).detail as Blob;
      try {
        const { transcript } = await transcribeAudio(blob);
        if (transcript.trim()) onTranscript(transcript);
      } catch (err) { console.error("transcribe failed", err); }
    };
    window.addEventListener("voice-mode:transcribe", handler);
    return () => window.removeEventListener("voice-mode:transcribe", handler);
  }, [onTranscript]);

  const handleMic = async () => {
    if (!vm.enabled) return;
    if (vm.isRecording) {
      const blob = await vm.stopRecording();
      if (blob) {
        try {
          const { transcript } = await transcribeAudio(blob);
          if (transcript.trim()) onTranscript(transcript);
        } catch (err) { console.error("transcribe failed", err); }
      }
    } else {
      await vm.startRecording();
    }
  };

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={vm.toggle}
        title={vm.enabled ? "Voice mode on" : "Voice mode off"}
        aria-label={vm.enabled ? "Voice mode on" : "Voice mode off"}
        className={`p-1.5 rounded ${vm.enabled ? "text-emerald-600" : "text-muted-foreground"}`}
      >
        {vm.enabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
      </button>
      <button
        type="button"
        onClick={handleMic}
        disabled={!vm.enabled}
        title={vm.isRecording ? "Stop recording" : "Start recording (or hold space)"}
        aria-label={vm.isRecording ? "Stop recording" : "Record"}
        className={`p-1.5 rounded ${vm.isRecording ? "text-red-600 animate-pulse" : "text-muted-foreground"} disabled:opacity-40`}
      >
        {vm.isRecording ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/voice-mode/src/ui/VoiceComposerControls.tsx \
        packages/plugins/voice-mode/src/ui/VoiceComposerControls.test.tsx
git commit -m "feat(voice-mode): add VoiceComposerControls (mic + toggle) (FRE-381)"
```

---

## Chunk 3: Wire Into Composer + Auto-Send + TTS Playback

### Task 10: Register UI slot in plugin entry

**Files:**
- Modify: `packages/plugins/voice-mode/src/ui/index.tsx`

- [ ] **Step 1: Register slot contributions**

```tsx
// ui/index.tsx
import type { PluginUIContext } from "@paperclipai/plugin-sdk";
import { VoiceComposerControls } from "./VoiceComposerControls";
import { MessageSpeakerButton } from "./MessageSpeakerButton";

export default function register(ctx: PluginUIContext) {
  ctx.contributeSlot("chat-composer-trailing", ({ props }) => (
    <VoiceComposerControls onTranscript={props.onAutoSend} />
  ));
  ctx.contributeSlot("chat-message-actions", ({ props }) => (
    <MessageSpeakerButton text={props.text} voiceId={props.voiceId} />
  ));
}
```

- [ ] **Step 2: Verify slot names exist in core**

```bash
grep -rn "chat-composer-trailing\|chat-message-actions" ~/paperclip/packages/shared/src
```

If missing: add to `packages/shared/src/plugin-slots.ts` and re-export. Otherwise skip.

- [ ] **Step 3: Commit**

```bash
git add packages/plugins/voice-mode/src/ui/index.tsx packages/shared/src/plugin-slots.ts
git commit -m "feat(voice-mode): register chat composer + message slots (FRE-381)"
```

### Task 11: Add slot-renderer hooks in IssueChatThread (core, ≤30 lines)

**Files:**
- Modify: `ui/src/components/IssueChatThread.tsx:1684-1758` (composer controls row)
- Modify: `ui/src/components/IssueChatThread.tsx` (assistant message bubble — find render site for assistant comments around L900-1100)

- [ ] **Step 1: Add slot import**

```tsx
import { PluginSlot } from "@/components/PluginSlot"; // existing core component
```

- [ ] **Step 2: Render composer-trailing slot**

In the composer controls row (after the Paperclip attach button, before Send), add:

```tsx
<PluginSlot
  slot="chat-composer-trailing"
  props={{
    onAutoSend: (text: string) => {
      setBody(text);
      void handleSubmit({ overrideBody: text });
    },
  }}
/>
```

(`handleSubmit` may need a small extension to accept an `overrideBody` argument; if so, do that minimally.)

- [ ] **Step 3: Render message-actions slot near each assistant message**

In the assistant message render path, find the existing `ActionBarPrimitive` block and add adjacent:

```tsx
<PluginSlot
  slot="chat-message-actions"
  props={{ text: messageText, voiceId: agent?.voiceId ?? KENN_VOICE_ID, agentId: message.agentId }}
/>
```

- [ ] **Step 4: Run UI tests**

```bash
pnpm --filter paperclip-ui test IssueChatThread
```

Expected: existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/IssueChatThread.tsx
git commit -m "feat(ui): render chat-composer + message slots for plugins (FRE-381)"
```

### Task 12: MessageSpeakerButton + auto-speak

**Files:**
- Create: `packages/plugins/voice-mode/src/ui/MessageSpeakerButton.tsx`

- [ ] **Step 1: Implementation**

```tsx
// MessageSpeakerButton.tsx
import { useEffect, useState } from "react";
import { Volume2, Square } from "lucide-react";
import { useVoiceMode } from "./useVoiceMode";
import { speakText } from "./api";

interface Props {
  text: string;
  voiceId: string;
  autoPlayKey?: string; // unique key per message; if voice mode enabled, auto-play once.
}

export function MessageSpeakerButton({ text, voiceId, autoPlayKey }: Props) {
  const vm = useVoiceMode();
  const [played, setPlayed] = useState(false);

  useEffect(() => {
    if (!vm.enabled || !autoPlayKey || played) return;
    const seenKey = `paperclip:voiceMode:played:${autoPlayKey}`;
    if (sessionStorage.getItem(seenKey)) return;
    sessionStorage.setItem(seenKey, "1");
    setPlayed(true);
    void play();
  }, [vm.enabled, autoPlayKey, played]);

  const play = async () => {
    try {
      const mp3 = await speakText(text, voiceId);
      await vm.playAudio(mp3);
    } catch (err) {
      console.error("speak failed", err);
    }
  };

  return (
    <button
      type="button"
      onClick={vm.isSpeaking ? vm.stopSpeaking : play}
      title={vm.isSpeaking ? "Stop" : "Play"}
      aria-label={vm.isSpeaking ? "Stop speaking" : "Play message"}
      className="p-1 rounded text-muted-foreground hover:text-foreground"
    >
      {vm.isSpeaking ? <Square className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
    </button>
  );
}
```

- [ ] **Step 2: Manual smoke (no unit test for audio playback — jsdom doesn't drive `<audio>`)**

- [ ] **Step 3: Commit**

```bash
git add packages/plugins/voice-mode/src/ui/MessageSpeakerButton.tsx
git commit -m "feat(voice-mode): add MessageSpeakerButton with auto-play (FRE-381)"
```

### Task 13: Per-agent voice picker (plugin-local KV)

**Files:**
- Create: `packages/plugins/voice-mode/src/ui/VoiceSettingsPanel.tsx`
- Create: `packages/plugins/voice-mode/src/shared/voices.ts`
- Modify: `packages/plugins/voice-mode/src/worker/index.ts` (KV routes)

- [ ] **Step 1: Voice catalog**

```typescript
// shared/voices.ts
export const KENN_VOICE_ID = "VjSFSNiy9sK85Z9QRu3d";
export const VOICE_CATALOG = [
  { id: KENN_VOICE_ID, label: "Kenn Akomea (default)" },
  { id: "21m00Tcm4TlvDq8ikWAM", label: "Rachel" },
  { id: "AZnzlk1XvdvUeBnXmlld", label: "Domi" },
];
```

- [ ] **Step 2: KV-backed worker routes**

In `worker/index.ts`, add:

```typescript
router.get("/voice/agent-voices", async (_req, res) => {
  const map = (await ctx.storage.get<Record<string, string>>("agentVoices")) ?? {};
  res.json(map);
});
router.put("/voice/agent-voices/:agentId", async (req, res) => {
  const { voiceId } = req.body ?? {};
  const map = (await ctx.storage.get<Record<string, string>>("agentVoices")) ?? {};
  map[req.params.agentId] = String(voiceId);
  await ctx.storage.set("agentVoices", map);
  res.json({ ok: true });
});
```

- [ ] **Step 3: Settings panel UI**

```tsx
// VoiceSettingsPanel.tsx
// Lists agents (consumed via host-provided agent list prop or core API),
// renders <select> per agent populated from VOICE_CATALOG, persists via PUT.
```

(Implementation: standard form. Save Kenn as default if no entry.)

- [ ] **Step 4: Register settings page slot**

In `ui/index.tsx`, add:

```tsx
ctx.contributeSlot("settings-page", () => <VoiceSettingsPanel />);
```

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/voice-mode/src/ui/VoiceSettingsPanel.tsx \
        packages/plugins/voice-mode/src/shared/voices.ts \
        packages/plugins/voice-mode/src/worker/index.ts \
        packages/plugins/voice-mode/src/ui/index.tsx
git commit -m "feat(voice-mode): per-agent voice picker w/ plugin KV (FRE-381)"
```

### Task 14: Install plugin on this instance + smoke test

**Files:** none (runtime install)

- [ ] **Step 1: Build plugin**

```bash
cd ~/paperclip
pnpm --filter @paperclipai/voice-mode build
```

- [ ] **Step 2: Install via Paperclip plugin API**

```bash
curl -s -X POST -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"source\":\"local\",\"path\":\"$HOME/paperclip/packages/plugins/voice-mode\"}" \
  "$PAPERCLIP_API_URL/api/plugins/install"
```

Expected: 201 + plugin shows as `installed` + `enabled` via `GET /api/plugins`.

- [ ] **Step 3: Manual smoke checklist**

In a browser logged in as Dom:
1. Open any issue. Confirm new mic + speaker icons appear next to Paperclip attach button.
2. Click voice-mode toggle (speaker icon). Should turn green.
3. Click mic. Browser asks for mic permission. Speak "Hello Conrad, post a test comment." Click mic again to stop.
4. Confirm: comment auto-posts with the transcript.
5. When Conrad's reply lands, audio should auto-play (Kenn voice).
6. Press spacebar mid-playback. Audio stops.
7. Hold spacebar elsewhere on the page. Recording starts. Release. Auto-sends.
8. Refresh page. Voice mode toggle persists.
9. Open Settings → Voice Mode → change agent voice → reload issue → next reply uses new voice.
10. After 24h (or by tweaking TTL constant): GET `/api/plugins/voice-mode/voice/audio/<id>` returns 404.

- [ ] **Step 4: Comment outcome on FRE-381**

Post a comment summarizing smoke results. Attach a short screen recording if convenient.

- [ ] **Step 5: Final commit + PR**

```bash
git add docs/plans/2026-04-29-fre-381-voice-mode.md
git commit -m "docs: add FRE-381 voice mode plan"
git push -u origin feat/fre-381-voice-mode
gh pr create --title "feat(voice-mode): add ElevenLabs voice plugin (FRE-381)" \
  --body "Implements FRE-381. See docs/plans/2026-04-29-fre-381-voice-mode.md."
```

---

## Risks / Things To Watch

1. **Slot names** — `chat-composer-trailing` and `chat-message-actions` may not exist yet. If they don't, Task 11 grows by ~10 lines to register them in `packages/shared/src/plugin-slots.ts`. Still ≤30 line core diff.
2. **Plugin storage API** — assumed `ctx.storage.get/set`. If the SDK calls it `ctx.kv` or similar, adjust in Task 13. Read `packages/plugins/sdk/README.md` first.
3. **`handleSubmit` override** — `IssueChatThread.handleSubmit` reads from React state `body`. Auto-send needs to either call `setBody` then submit on next tick, or accept an override arg. Pick the smaller diff.
4. **Browser mic permission** — first-time UX: a browser modal pops. Document in README.
5. **Cost** — ElevenLabs Scribe ~$0.40/hr audio, TTS ~$0.30/1K chars on Turbo v2.5. Negligible for one user.
6. **Mobile** — `MediaRecorder` works on iOS Safari 14.5+, but PWA mic permission flow is different. Out of scope V1 per decision 10.
