# Jarvis Voice Gateway Implementation Plan (FRE-1296 phase 2+)

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the /voice tab from "works in a quiet room after 40 seconds" to a production Jarvis-grade voice layer, by evolving the current pipeline first (perceived latency to ~1-2s) and then adding an ada_v2-style realtime gateway for full-duplex + multimodal input.

**Architecture:** Keep Paperclip as the agent backbone in every phase. Do NOT fork ada_v2's code (Python/Electron, single user, no auth, 3D-printer/CAD baggage). Adopt its three load-bearing architectural ideas instead: (1) non-blocking tool calls with instant verbal acks, (2) streaming sentence-level TTS with a drainable audio queue for barge-in, (3) a persistent realtime session (Gemini Live) as the conversational front-end that dispatches Paperclip agent runs as async tools.

**Tech Stack:** Existing voice-mode plugin (ElevenLabs Scribe STT + TTS, Kenn voice), @ricky0123/vad-web, heartbeat wakeup runs, company events WS (`heartbeat.run.log` streams live stdout). Phase 2 adds Gemini Live API (Google AI Studio key, NOT NVIDIA Build - see Decision 2) and optionally ElevenLabs Flash streaming WS (plugin half already written: `packages/plugins/voice-mode/src/worker/elevenlabs-stream.ts`).

---

## Chunk 1: Decisions and comparison (read first)

### The question Dom asked

"Plan a new build around this working ada_v2 vs my voice mode which is not production ready."

### Recommendation: evolve, don't rebuild - but steal ada_v2's architecture for Phase 2

| Dimension | Current /voice tab | ada_v2 (github.com/nazirlouis/ada_v2) |
|---|---|---|
| Conversation loop | Turn-based: VAD -> WAV -> STT -> full agent run -> TTS | Full-duplex Gemini Live native audio, no STT/TTS pipeline at all |
| Latency | 40s+ per turn (full Opus agent run) | Sub-second perceived (acks instantly, tools run async) |
| Voice | Kenn (ElevenLabs), Dom's pick | Gemini stock voices only |
| Agent capability | Full Paperclip agent: tools, memory, issues, board | Hobby tools (search, weather, CAD demo) |
| Auth / multi-user | Paperclip JWT, board-gated bridge actions | None, localhost single user |
| Multimodal | Audio only | Mic + camera + screen share into the same session |
| Code reusability for us | It is our codebase | Near zero (Python backend, Electron front-end) |

The verdict from the deep dive (2026-06-09, spot-checked against `/tmp/ada_v2/backend/ada.py`): ada_v2 is a great architecture demo wrapped around a toy agent. Paperclip is a serious agent platform wrapped around a slow voice front-end. The build that wins is Paperclip's backbone + ada_v2's front-end architecture. Forking ada_v2 means rebuilding auth, agent dispatch, run persistence, and the board bridge from scratch to end up where we already are.

The four portable ada_v2 patterns (verified at source):

1. **Non-blocking tool acks** (`ada.py:50,63,180,786`): every tool is declared NON_BLOCKING; the model acks verbally ("on it, give me a sec") while the task runs async; the result is injected later as a system notification and the model speaks the outcome.
2. **Barge-in via audio queue drain** (`ada.py:322,667`): TTS audio goes through a queue; user speech clears the queue instantly instead of waiting for playback to finish.
3. **Streaming transcript deltas** (`ada.py:657-682`): UI renders text as it streams, not after completion.
4. **Reconnect + context restore** (`ada.py:1173`): session resumes with last-N messages on disconnect.

Phase 1 ports patterns 1-3 onto the existing pipeline with no rearchitecture. Phase 2 ports the full-duplex session (the thing that actually makes ada_v2 feel like Jarvis) plus multimodal input.

### Decision 1 (Dom must pick before Phase 2 starts): the voice trade-off

Gemini Live native audio speaks in Gemini's stock voices. There is no Kenn in that world.

- **Option A - Native audio (ada_v2 exact)**: browser mic streams straight into Gemini Live, Gemini speaks back natively. Fastest possible (sub-second), true barge-in handled by Google, multimodal for free. Cost: loses Kenn's voice permanently on /voice.
- **Option B - Cascade (keeps Kenn)**: Gemini Live runs in TEXT response mode (audio in, text out, still full-duplex input with server-side VAD), and we pipe the streaming text through ElevenLabs Flash (`eleven_flash_v2_5`, ~75ms model latency) via the already-written `elevenlabs-stream.ts` WS client. Perceived latency ~1-1.5s. Keeps Kenn. Slightly more moving parts (we own the audio output queue and barge-in drain).

Recommendation: **Option B**. Kenn is a deliberate identity choice (CLAUDE.md-level preference), the latency difference between ~0.5s and ~1.2s is not worth losing it, and Option B degrades gracefully (if the ElevenLabs WS dies we can fall back to non-streaming voice.speak). Option A remains a config flag away if Dom changes his mind after hearing both.

### Decision 2 (resolved, flagging): Gemini access path

NVIDIA Build hosts the NIM catalog (open models). It does NOT carry the Gemini Live API. Phase 2 needs a **Google AI Studio API key** from the F&C Google account (free tier covers development; Live API billing applies at production volume). This is a 5-minute signup, not a blocker, but it is the Google-account path, not the NVIDIA one.

### Phase map

- **Phase 0 (SHIPPED, commits c904ad24, 0abfcdf1, 2080f045)**: turn loop actually completes; VAD noise hardening; agent pinned to Conrad; barge-in unstick; SPA asset 404s; build guards.
- **Phase 1 (APPROVED by Dom, this plan, Chunks 2-4)**: instant verbal ack, streaming sentence TTS during the run, fast voice agent. Target: first audio within ~2s of end of speech, full answer streaming as it is generated.
- **Phase 2 (needs Decision 1)**: Gemini Live realtime gateway, full-duplex, multimodal (mic + camera frames), Paperclip runs as NON_BLOCKING tools. Chunk 5 scopes it; it gets its own plan doc once Decision 1 lands.
- **Phase 3 (backlog)**: wake word ("Conrad"), agent picker UI, voice transcript rendered as chat history, session resume.

---

## Chunk 2: Phase 1 Task 1 - Instant verbal ack

When transcription succeeds and the run is dispatched, Kenn immediately says a short ack ("On it." / "Give me a second." / "Working on it.") so the user knows the turn landed, instead of staring at a spinner for 40s. Ack clips are fetched once per session via the existing `voice.speak` bridge action and cached as blob URLs; playback is instant on every turn after the first.

**Files:**
- Create: `ui/src/hooks/useAckPlayer.ts`
- Test: `ui/src/hooks/useAckPlayer.test.ts`
- Modify: `ui/src/pages/VoiceMode.tsx` (call site: inside the turn-submit path, right after the POST to `/api/voice/session/:id/turn` succeeds)

- [ ] **Step 1: Write the failing test**

```ts
// ui/src/hooks/useAckPlayer.test.ts
import { describe, expect, it, vi } from "vitest";
import { createAckCache } from "./useAckPlayer";

describe("ack cache", () => {
  it("fetches each ack phrase exactly once and returns cached blob URLs after", async () => {
    const speak = vi.fn().mockResolvedValue(new Blob(["mp3"], { type: "audio/mpeg" }));
    const toUrl = vi.fn().mockReturnValue("blob:fake-url");
    const cache = createAckCache(speak, toUrl);

    await cache.warm();
    expect(speak).toHaveBeenCalledTimes(cache.phrases.length);

    const first = cache.next();
    const second = cache.next();
    expect(first).toBe("blob:fake-url");
    expect(second).toBe("blob:fake-url");
    // No additional fetches after warm.
    expect(speak).toHaveBeenCalledTimes(cache.phrases.length);
  });

  it("next() returns null before warm() resolves (never blocks a turn)", () => {
    const speak = vi.fn(() => new Promise<Blob>(() => {}));
    const cache = createAckCache(speak, () => "blob:x");
    expect(cache.next()).toBeNull();
  });

  it("warm() tolerates individual fetch failures (partial cache still serves)", async () => {
    const speak = vi
      .fn()
      .mockResolvedValueOnce(new Blob(["ok"]))
      .mockRejectedValue(new Error("tts down"));
    const cache = createAckCache(speak, () => "blob:ok");
    await cache.warm();
    expect(cache.next()).toBe("blob:ok");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/deploy/paperclip/ui && pnpm vitest run src/hooks/useAckPlayer.test.ts`
Expected: FAIL with "Cannot find module './useAckPlayer'"

- [ ] **Step 3: Write minimal implementation**

```ts
// ui/src/hooks/useAckPlayer.ts
export const ACK_PHRASES = [
  "On it.",
  "Give me a second.",
  "Working on it.",
] as const;

export interface AckCache {
  phrases: readonly string[];
  warm(): Promise<void>;
  /** Returns a playable blob URL, or null if nothing cached yet. Round-robins. */
  next(): string | null;
}

export function createAckCache(
  speak: (text: string) => Promise<Blob>,
  toUrl: (b: Blob) => string = (b) => URL.createObjectURL(b),
): AckCache {
  const urls: string[] = [];
  let i = 0;
  return {
    phrases: ACK_PHRASES,
    async warm() {
      await Promise.all(
        ACK_PHRASES.map(async (p) => {
          try {
            urls.push(toUrl(await speak(p)));
          } catch {
            // Partial cache is fine; acks are best-effort.
          }
        }),
      );
    },
    next() {
      if (urls.length === 0) return null;
      const url = urls[i % urls.length];
      i += 1;
      return url;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/deploy/paperclip/ui && pnpm vitest run src/hooks/useAckPlayer.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Wire into VoiceMode.tsx**

Audio context first: answer playback in VoiceMode.tsx goes through `useStreamingTts` (line ~222), whose `play()` takes `Uint8Array | ReadableStream`, not a URL. Do NOT route acks through it (they would interleave with answer audio). Instead:

1. On session start (where the VAD is enabled), build the cache with the existing `voice.speak` bridge call (`{ text, voiceId: KENN_VOICE_ID }`, same shape as the call at line ~449) and fire `cache.warm()` without awaiting it.
2. Add a dedicated ack `<audio>` element (ref-held, `src` set to the cached blob URL). In the turn-submit path, immediately after the turn POST succeeds and the machine enters `thinking`: `const ackUrl = ackCache.next(); if (ackUrl) { ackAudioRef.current.src = ackUrl; void ackAudioRef.current.play(); }`. The ack must NOT change machine phase (it is not the answer).
3. The ack element must be paused in three places: when the real answer audio starts, on barge-in, and on STOP. Add `ackAudioRef.current?.pause()` to each.
4. Skip the ack when the turn was submitted while a previous answer is still playing.

- [ ] **Step 6: Run full hook test suite**

Run: `cd /home/deploy/paperclip/ui && pnpm vitest run src/hooks/`
Expected: PASS, 3 new tests plus all existing hook tests (existing count is ~53 across src/hooks: state machine 25, useStreamingTts 9, useCompanyPageMemory 8, useVad 7, useVoiceCues 3, useKeyboardShortcuts 1)

- [ ] **Step 7: Build, sync ui-dist, commit**

The deployed UI is served from `server/ui-dist`; without the sync this feature never ships even if committed.

```bash
cd /home/deploy/paperclip/ui && pnpm build
cd /home/deploy/paperclip/server && pnpm prepare:ui-dist
cd /home/deploy/paperclip && git add ui/src/hooks/useAckPlayer.ts ui/src/hooks/useAckPlayer.test.ts ui/src/pages/VoiceMode.tsx server/ui-dist
git commit -m "feat(voice): instant verbal ack on turn submit (ada_v2 NON_BLOCKING pattern)"
```

---

## Chunk 3: Phase 1 Task 2 - Streaming sentence TTS during the run

Today the UI waits for `heartbeat.run.status: succeeded`, parses the whole run log, then makes ONE `voice.speak` call for the full answer. Instead: subscribe to `heartbeat.run.log` WS events for the active run (the same events `ui/src/components/transcript/useLiveRunTranscripts.ts:252` already consumes; payload shape `{ runId, chunk, stream, ts }`), extract assistant `text_delta`s from the stream-json chunks, feed them through the already-written-and-tested `splitIntoSentences()` (`packages/plugins/voice-mode/src/worker/sentence-buffer.ts`), and call `voice.speak` per sentence into a playback queue. First audio lands when the FIRST sentence completes, not when the run finishes.

This is deliberately per-sentence `voice.speak` (parallel-fetch, ordered playback), not the ElevenLabs streaming WS. The WS client (`elevenlabs-stream.ts`) runs in the plugin worker and the bridge action protocol is request/response; proxying a byte stream to the browser needs a new server endpoint. That is Phase 2 work (cascade Option B needs it anyway). Per-sentence gets ~90% of the perceived win for ~20% of the plumbing.

**Files:**
- Create: `ui/src/hooks/useSentenceTtsQueue.ts`
- Create: `ui/src/hooks/streamJsonDeltas.ts` (pure: stream-json chunk -> assistant text deltas)
- Test: `ui/src/hooks/streamJsonDeltas.test.ts`, `ui/src/hooks/useSentenceTtsQueue.test.ts`
- Modify: `ui/src/pages/VoiceMode.tsx` (WS handler around line ~397, the runId-matching block; and the speak path)
- Copy: `splitIntoSentences` from `packages/plugins/voice-mode/src/worker/sentence-buffer.ts` into `ui/src/hooks/sentence-buffer.ts` with its test (the plugin worker package is not importable from the UI build; keep the two copies byte-identical and note the provenance in a header comment)

- [ ] **Step 1: Write the failing delta-extractor test**

```ts
// ui/src/hooks/streamJsonDeltas.test.ts
import { describe, expect, it } from "vitest";
import { createDeltaExtractor } from "./streamJsonDeltas";

const line = (o: unknown) => JSON.stringify(o) + "\n";

describe("stream-json delta extractor", () => {
  it("extracts assistant text from content_block_delta events across chunk boundaries", () => {
    const ex = createDeltaExtractor();
    const full = line({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello " } },
    });
    // Split mid-line to simulate WS chunking.
    const a = ex.push(full.slice(0, 25));
    const b = ex.push(full.slice(25));
    expect(a.join("") + b.join("")).toBe("Hello ");
  });

  it("ignores non-text events and unparseable lines", () => {
    const ex = createDeltaExtractor();
    const out = ex.push(
      line({ type: "stream_event", event: { type: "content_block_start" } }) +
        "not json at all\n" +
        line({ type: "result", result: "final envelope, not a delta" }),
    );
    expect(out).toEqual([]);
  });

  it("also accepts assistant message text blocks (non-streaming runs)", () => {
    const ex = createDeltaExtractor();
    const out = ex.push(
      line({
        type: "assistant",
        message: { content: [{ type: "text", text: "Full block." }] },
      }),
    );
    expect(out).toEqual(["Full block."]);
  });
});
```

- [ ] **Step 2: Run it, verify FAIL** (`pnpm vitest run src/hooks/streamJsonDeltas.test.ts` -> module not found)

- [ ] **Step 3: Implement the extractor**

```ts
// ui/src/hooks/streamJsonDeltas.ts
/**
 * Incremental stream-json (claude CLI --output-format stream-json) parser that
 * yields ONLY assistant-visible text. Buffers partial lines across WS chunks.
 * Mirrors the event shapes handled by fetchFinalAssistantText in VoiceMode.tsx;
 * keep the two in sync if run-log format changes.
 */
export interface DeltaExtractor {
  push(chunk: string): string[];
}

export function createDeltaExtractor(): DeltaExtractor {
  let buf = "";
  return {
    push(chunk: string): string[] {
      buf += chunk;
      const out: string[] = [];
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const lineStr = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!lineStr.trim()) continue;
        let obj: any;
        try {
          obj = JSON.parse(lineStr);
        } catch {
          continue;
        }
        if (
          obj?.type === "stream_event" &&
          obj.event?.type === "content_block_delta" &&
          obj.event.delta?.type === "text_delta" &&
          typeof obj.event.delta.text === "string"
        ) {
          out.push(obj.event.delta.text);
        } else if (obj?.type === "assistant" && Array.isArray(obj.message?.content)) {
          for (const block of obj.message.content) {
            if (block?.type === "text" && typeof block.text === "string") {
              out.push(block.text);
            }
          }
        }
      }
      return out;
    },
  };
}
```

- [ ] **Step 4: Run it, verify PASS**

- [ ] **Step 5: Write the failing playback-queue test**

```ts
// ui/src/hooks/useSentenceTtsQueue.test.ts
import { describe, expect, it, vi } from "vitest";
import { createTtsQueue } from "./useSentenceTtsQueue";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("sentence TTS queue", () => {
  it("synthesizes sentences in parallel but plays strictly in order", async () => {
    const resolvers: Array<(b: Blob) => void> = [];
    const speak = vi.fn(() => new Promise<Blob>((res) => resolvers.push(res)));
    const played: string[] = [];
    const play = vi.fn(async (b: Blob) => {
      played.push(await b.text());
    });
    const q = createTtsQueue(speak, play);

    q.enqueue("One.");
    q.enqueue("Two.");
    expect(speak).toHaveBeenCalledTimes(2); // parallel synth
    // Resolve out of order: Two finishes first.
    resolvers[1](new Blob(["Two."]));
    await tick();
    expect(played).toEqual([]); // must wait for One
    resolvers[0](new Blob(["One."]));
    await tick(); await tick();
    expect(played).toEqual(["One.", "Two."]); // ordered playback
  });

  it("drain() drops everything pending (barge-in)", async () => {
    const speak = vi.fn(() => new Promise<Blob>(() => {}));
    const play = vi.fn();
    const q = createTtsQueue(speak, play);
    q.enqueue("Doomed.");
    q.drain();
    await tick();
    expect(play).not.toHaveBeenCalled();
  });

  it("a failed synthesis skips the sentence, later ones still play", async () => {
    const speak = vi
      .fn()
      .mockRejectedValueOnce(new Error("tts 500"))
      .mockResolvedValueOnce(new Blob(["Second."]));
    const played: string[] = [];
    const q = createTtsQueue(speak, async (b) => {
      played.push(await b.text());
    });
    q.enqueue("First.");
    q.enqueue("Second.");
    await tick(); await tick();
    expect(played).toEqual(["Second."]);
  });

  it("onIdle fires when the queue empties after end()", async () => {
    const speak = vi.fn().mockResolvedValue(new Blob(["x"]));
    const onIdle = vi.fn();
    const q = createTtsQueue(speak, async () => {}, onIdle);
    q.enqueue("Only.");
    q.end();
    await tick(); await tick();
    expect(onIdle).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 6: Run it, verify FAIL**

- [ ] **Step 7: Implement the queue**

```ts
// ui/src/hooks/useSentenceTtsQueue.ts
/**
 * Ordered TTS playback queue (ada_v2 audio-queue pattern, ada.py:322,667).
 * Sentences are synthesized in parallel the moment they are enqueued, but
 * audio plays strictly in enqueue order. drain() implements barge-in: drop
 * everything not yet played. end() + empty queue fires onIdle exactly once,
 * which is what flips the machine back to "listening" via TTS_END.
 */
export interface TtsQueue {
  enqueue(sentence: string): void;
  /** No more sentences coming; fire onIdle when playback finishes. */
  end(): void;
  /** Barge-in: drop all pending audio immediately. */
  drain(): void;
}

export function createTtsQueue(
  speak: (text: string) => Promise<Blob>,
  play: (blob: Blob) => Promise<void>,
  onIdle?: () => void,
): TtsQueue {
  type Slot = { blob: Blob | null; failed: boolean; done: boolean };
  let slots: Slot[] = [];
  let playing = false;
  let ended = false;
  let generation = 0;

  const pump = async (gen: number) => {
    if (playing) return;
    playing = true;
    try {
      while (gen === generation) {
        const slot = slots[0];
        if (!slot) {
          if (ended) onIdle?.();
          return;
        }
        if (!slot.done) return; // head still synthesizing; resolver re-pumps
        slots.shift();
        if (slot.blob && !slot.failed) {
          await play(slot.blob);
        }
      }
    } finally {
      playing = false;
      // Re-check: head may have resolved while we were playing.
      if (gen === generation && slots[0]?.done) void pump(gen);
    }
  };

  return {
    enqueue(sentence: string) {
      const gen = generation;
      const slot: Slot = { blob: null, failed: false, done: false };
      slots.push(slot);
      speak(sentence)
        .then((b) => {
          slot.blob = b;
        })
        .catch(() => {
          slot.failed = true;
        })
        .finally(() => {
          slot.done = true;
          if (gen === generation) void pump(gen);
        });
    },
    end() {
      ended = true;
      void pump(generation);
    },
    drain() {
      generation += 1;
      slots = [];
      ended = false;
    },
  };
}
```

Note for the implementer: the test in Step 5 is the contract. If this implementation's idle/re-pump bookkeeping fights you, simplify it until the tests pass cleanly; do not weaken the tests. Known subtleties: `onIdle` must fire exactly once per `end()` (add a fired flag if the pump path can hit it twice), and `drain()` must also stop the CURRENTLY PLAYING audio at the call site (the hook wrapper stops playback via the existing `useStreamingTts` layer; the pure queue only manages pending slots). The `play` callback at the wire-up site adapts blobs for `useStreamingTts.play()`: `play: async (blob) => streamingTts.play(new Uint8Array(await blob.arrayBuffer()))`.

- [ ] **Step 8: Run it, verify PASS** (iterate on the implementation, not the tests)

- [ ] **Step 9: Copy sentence-buffer into the UI**

```bash
cp packages/plugins/voice-mode/src/worker/sentence-buffer.ts ui/src/hooks/sentence-buffer.ts
cp packages/plugins/voice-mode/src/worker/sentence-buffer.test.ts ui/src/hooks/sentence-buffer.test.ts
```
Add a header comment to both copies: `// Copied from packages/plugins/voice-mode/src/worker/sentence-buffer.ts - keep byte-identical.` Run `pnpm vitest run src/hooks/sentence-buffer.test.ts`, expect PASS.

- [ ] **Step 10: Wire into VoiceMode.tsx**

In the WS message handler (the block around line ~397 that gates on `runId === activeRunId`):
1. On `heartbeat.run.log` for the active run: `extractor.push(chunk)` -> `sentenceBuffer.push(deltaText)` -> `ttsQueue.enqueue(sentence)` for each emitted sentence. The FIRST enqueued sentence also dispatches `SERVER_THINKING_DONE` with the active turnId so the machine enters `speaking` while the run is still going.
2. On `heartbeat.run.status: succeeded`: `sentenceBuffer.flush()` -> enqueue tail -> `ttsQueue.end()`. KEEP the existing `fetchFinalAssistantText` path as fallback: if zero sentences were enqueued during the whole run (e.g. run produced only tool calls then a final block the extractor missed), fall back to the current parse-and-speak-everything behavior.
3. `onIdle` callback dispatches `TTS_END` with the turnId (existing transition: speaking -> listening).
4. Barge-in handler (existing) additionally calls `ttsQueue.drain()` and pauses the audio element.
5. New extractor + queue instances per turn (create them when the turn POST succeeds), so stale runs cannot enqueue into a new turn's queue. Same staleness discipline as turnIdRef/runIdRef.

- [ ] **Step 11: Full test suite + build**

Run: `cd /home/deploy/paperclip/ui && pnpm vitest run && pnpm build`
Expected: all tests PASS, build emits new hashed bundle, `copy-vad-assets` guard passes.

- [ ] **Step 12: Manual smoke (REQUIRED before claiming done)**

Open /voice on a real device, speak a question, verify: ack plays ~instantly, first answer sentence audio starts well before the run finishes, barge-in mid-answer cuts audio immediately and returns to listening, follow-up turn works. Watch server.log for per-sentence `voice.speak` entries.

- [ ] **Step 13: Sync ui-dist and commit**

```bash
cd /home/deploy/paperclip/server && pnpm prepare:ui-dist
cd /home/deploy/paperclip && git add ui/src/hooks/ ui/src/pages/VoiceMode.tsx server/ui-dist
git commit -m "feat(voice): stream sentence-level TTS during the run + barge-in queue drain (ada_v2 patterns 2+3)"
```

---

## Chunk 4: Phase 1 Task 3 - Fast voice agent (the real latency lever)

Acks and streaming fix PERCEIVED latency. Actual time-to-first-sentence is still bounded by the agent run spinning up Opus with Conrad's full system prompt and tool surface (40s+, roughly $1/turn). `heartbeat.wakeup` supports `voiceSystemPromptOverride` (`server/src/services/heartbeat.ts:3096-3098`) but no model override.

**Approach decision (investigate first, then pick):**
- **3a. Wakeup-level model override**: add `modelOverride` to the wakeup context, threaded to wherever the runner builds the `claude` invocation. Smallest diff if the runner already parameterizes model per run.
- **3b. Dedicated "Conrad Voice" agent**: a second Paperclip agent configured with sonnet, a tight voice system prompt, and a minimal tool set; /voice pins to it instead of Conrad. No server changes, but splits identity/memory across two agents.

Recommendation: 3a if the model is already a per-run parameter (likely, since agents have model configs); 3b only if 3a requires invasive runner surgery. Voice answers do not need Opus.

**Files (for 3a):**
- Modify: `server/src/services/heartbeat.ts` (wakeup context type + threading, near the `voiceSystemPromptOverride` handling at line ~3096)
- Modify: the runner module that assembles the agent CLI invocation (find via `Grep "voiceSystemPromptOverride" server/src` and follow the context object to the spawn site)
- Modify: `server/src/routes/` voice turn route (pass `modelOverride: "claude-sonnet-4-6"` for voice-sourced wakeups)
- Test: colocated server tests mirroring whatever pattern covers `voiceSystemPromptOverride`

- [ ] **Step 1: Investigate.** Trace `voiceSystemPromptOverride` from heartbeat.ts:3096 to the point the `claude` process is spawned. Confirm whether model is per-run-parameterizable. Write findings in the commit message or scratchpad. If 3a is invasive, STOP and switch to 3b (agent creation is config, not code).
- [ ] **Step 2: Failing test** for `modelOverride` threading (same test seam as the prompt override).
- [ ] **Step 3: Implement** the narrowest possible threading. Voice turns pass `modelOverride: "claude-sonnet-4-6"`. Nothing else sets it; absent means current behavior, byte-for-byte.
- [ ] **Step 4: Tests pass.** Run: `cd /home/deploy/paperclip/server && pnpm vitest run <path of the test file added in Step 2>`, then the full suite for the touched service module.
- [ ] **Step 5: SERVER RESTART REQUIRED** for this change AND it activates the pending app.ts SPA-404 hardening from commit 0abfcdf1. Restart must be coordinated (Conrad's own runs depend on the server). Do it at a quiet moment, verify /voice + board + agent runs still work, and confirm `/vad/*.mjs` now 404s instead of serving index.html when missing.
- [ ] **Step 6: Commit** `feat(voice): sonnet model override for voice-sourced wakeups`.
- [ ] **Step 7: Measure.** One real voice turn end-to-end; record seconds from end-of-speech to first audio in the scratchpad. Target: ack < 2s, first sentence < 10s. If still slow, the next lever is trimming the voice system prompt and tool surface, then session resume (Phase 3).

---

## Chunk 5: Phase 2 scope - Gemini Live realtime gateway (multimodal)

NOT bite-sized tasks yet. This chunk is the architecture contract; it becomes its own plan doc once Dom makes Decision 1. Written down now so the shape is agreed before any code.

**What it is:** a `voice-gateway` service (new package, Node/TS, lives beside the server, AuthN via existing Paperclip JWT) that holds ONE Gemini Live session per connected user and bridges three things:

1. **Browser <-> gateway WS**: mic audio chunks up (16kHz PCM), camera frames up (JPEG snapshots ~1fps when user enables camera - this is Dom's requested multimodal input), audio or text down depending on Decision 1. The /voice page swaps its VAD-WAV-POST loop for this socket; client VAD goes away entirely (Gemini Live does server-side VAD + native barge-in).
2. **Gateway <-> Gemini Live**: bidi stream via `@google/genai` SDK, Google AI Studio key sealed the same way as ELEVENLABS (`elevenlabsKeyRef` pattern). System prompt: Conrad voice persona. Tools declared NON_BLOCKING ada_v2-style.
3. **Gateway <-> Paperclip**: Gemini function calls map to Paperclip primitives: `dispatch_agent_run(prompt)` -> heartbeat.wakeup on Conrad (the existing voice turn machinery, minus STT), `check_run(runId)`, plus cheap read-only tools (board summary, today's issues) that answer instantly without an agent run. On run completion the gateway injects the result into the Live session as a system message; Gemini speaks the outcome unprompted - exactly ada_v2's notification pattern (ada.py:786).

**Voice output per Decision 1:** Option A: Gemini native audio streams straight through to the browser. Option B: Gemini responds in text; gateway pipes deltas through `splitIntoSentences()` into `streamTextToSpeech()` (`elevenlabs-stream.ts`, `eleven_flash_v2_5`, Kenn voiceId) and relays MP3 bytes down the browser WS; barge-in = drop ElevenLabs WS + drain client queue.

**What Phase 1 work survives into Phase 2:** the TTS playback queue (Chunk 3) becomes the client-side audio sink for Option B; sentence-buffer is reused in the gateway; the ack pattern dies (Gemini Live acks natively); useVad dies; the turn-based POST route stays as fallback transport.

**Open items to resolve in the Phase 2 plan:** Live session lifetime/cost model (sessions are long-lived; idle timeout policy), reconnect + context restore (ada_v2 pattern 4), how transcripts land in Paperclip history, multi-user session ownership.

**Exit criteria for Phase 2:** wake /voice, talk full-duplex with sub-2s responses, interrupt mid-sentence naturally, point the camera at something and ask about it, ask for real work and have it dispatched as a background Paperclip run whose result is spoken when ready.

---

## Phase 3 backlog (not planned, recorded)

- Wake word ("Conrad") so the session can stay ambient.
- Agent picker in the /voice UI (post-2080f045 it pins Conrad; picker generalizes it).
- Voice transcript rendered as a chat thread in the tab.
- Session resume so consecutive turns share agent context instead of cold-starting.
