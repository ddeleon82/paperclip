# Voice Gateway Rip-and-Replace Design (FRE-1296)

**Date:** 2026-06-10
**Status:** Proposed (awaiting Dom approval)
**Supersedes:** the incremental Phase 1/Phase 2 split in `docs/superpowers/plans/2026-06-09-fre1296-jarvis-voice-gateway.md`. Chunk 5 of that plan is the architectural ancestor of this spec; Decision 1 (Option B cascade, closed 2026-06-10) carries forward unchanged.

## 1. Problem

The current /voice pipeline (browser Silero VAD -> WAV -> ElevenLabs Scribe STT -> turn POST -> agent run -> TTS) has failed every field test. The latest failure is structural, not a bug: the browser must download ~26 MB of ONNX/WASM models before it can even request microphone permission. On a phone that is ~30 seconds of dead air. Cache headers (commit b93c8ed6) only help repeat visits, and iOS Safari evicts cache aggressively. No amount of patching removes the download, because client-side VAD IS the download.

Dom's directive (comment efe790de, 2026-06-10): rip out the old voice plumbing, replace it with the ada_v2 architecture, tailored to our needs: Conrad stays the brain, "Conrad" is the wake word.

## 2. What ada_v2 actually is, and what "tailored" means

ada_v2 (github.com/nazirlouis/ada_v2) is a single-user Python desktop app: local mic via PyAudio, Gemini Live API full-duplex session, non-blocking tool calls with verbal acks, barge-in via audio queue drain. Its load-bearing idea is: **no client VAD, no STT step, no TTS round-trip per turn. The mic streams raw audio to Gemini Live over a WebSocket and Gemini handles voice activity, transcription, interruption, and conversation state server-side.**

We do not fork the code (Python desktop app; Dom drives /voice from iPhone Safari). We transplant the architecture into Paperclip:

- **Ears/eyes:** Gemini Live session (audio in, optional camera frames in)
- **Brain:** Conrad (Claude) only. Gemini never answers substantive asks; it dispatches them to Conrad as non-blocking tool calls and relays Conrad's answers.
- **Mouth:** ElevenLabs Flash streaming TTS, Kenn voice (Decision 1 Option B, already blessed)
- **Wake word:** "Conrad" gates when Gemini responds (v1: instruction-level gating while the tab is open; true ambient wake word is a later phase)

## 3. Approaches considered

**A. Fork ada_v2 literally (Python desktop app + Paperclip API calls).** Rejected. It cannot run in a phone browser, has no auth/multi-user story, and carries CAD/3D-printer baggage. Dom's primary voice device is his iPhone.

**B. Rebuild /voice as a thin Gemini Live client behind a server-side gateway (RECOMMENDED).** The browser does two things only: `getUserMedia` (mic permission requested on first tap, <1s, nothing to download) and a WebSocket to our server. The server holds the Gemini Live session and bridges it to Paperclip and ElevenLabs. This is ada_v2's architecture with our stack as the body. Detailed below.

**C. Same as B but Gemini native audio out (ada_v2's exact audio path).** Simplest plumbing, sub-second voice, but the voice is Gemini's stock voice: Kenn is gone. Kept as a config flag (`voiceOutput: "native" | "cascade"`) so Dom can A/B it by ear; cascade (B) is the default per Decision 1.

## 4. Architecture (Approach B)

```
iPhone Safari /voice tab
  |  getUserMedia -> 16kHz PCM chunks ->
  |  WS /api/voice/live (Paperclip JWT auth)
  v
Paperclip server: voice-gateway module
  |  bidi stream (@google/genai SDK, Gemini API key sealed like ELEVENLABS)
  v
Gemini Live session (gemini-3.1-flash-live-preview, TEXT response mode)
  |  server-side VAD, transcription, barge-in, wake-word gating via system prompt
  |  function calls:
  |    dispatch_to_conrad(prompt)  -> heartbeat.wakeup voiceTurn (existing, live since b89ff6a2)
  |    check_run(runId)            -> run status, for "is that done yet?" mid-wait
  |    board_snapshot()            -> cheap read-only answers, no agent run
  v
gateway: Gemini text deltas -> splitIntoSentences() -> elevenlabs-stream.ts
  (eleven_flash_v2_5, Kenn voiceId) -> audio bytes down the browser WS
  v
browser: existing sentence playback queue (useSentenceTtsQueue) as audio sink;
  barge-in = Gemini interrupt event -> gateway drops ElevenLabs WS -> client drains queue
```

### Components

1. **Gateway module** (`server/src/services/voice-gateway.ts` + WS route in app.ts). Lives inside the existing server process: one process to restart, existing JWT auth, no new ops surface on a 7.6 GB VPS. Extract to a separate service only if it ever needs independent scaling. Owns: one Live session per connected user (a second tab from the same user takes over the session; the old socket is closed with a "superseded" close code), session lifecycle (idle timeout ~5 min, reconnect with last-N-messages context restore, ada_v2 pattern 4), function-call routing, TTS piping, **DB turn persistence** (the gateway becomes the writer of `appendTurn` for both user and assistant turns, replacing the turn POST route as the transcript writer), and JSONL flywheel logging. Exact browser<->gateway WS message framing (PCM chunks up; audio bytes, transcript deltas, and interrupt/reconnect control events down) is deliberately left to the implementation plan.
2. **Browser client** (VoiceMode.tsx rewrite). Mic capture (AudioWorklet downsampler to 16kHz PCM), WS framing, audio playback queue (reuse useSentenceTtsQueue), tap-to-start (doubles as the iOS audio unlock), live transcript rendering. Camera frames (~1 fps JPEG) when user enables camera.
3. **Conrad dispatch** (already built). `dispatch_to_conrad` calls the same heartbeat.wakeup with `contextSnapshot.voiceTurn` that shipped in b89ff6a2, minus the STT step. Run completion is injected back into the Live session as a system message; Gemini speaks the outcome unprompted (ada_v2's notification pattern). Sonnet override stays.
4. **Persona containment.** Gemini's system prompt forces: respond only when addressed as "Conrad" or in an active exchange; never answer substantive questions itself; dispatch and relay. Two-personality drift is the main quality risk; the JSONL flywheel gives us the transcript evidence to tune it.

### What gets ripped out (Dom's explicit instruction)

- `@ricky0123/vad-web` + `onnxruntime-web` dependencies, the 26 MB `/vad/` assets, `copy-vad-assets.mjs` build step: the entire cause of the 30-second load
- `voice.transcribe` (ElevenLabs Scribe) from the turn path
- The VAD -> WAV -> POST turn loop in VoiceMode.tsx, useVad, useAckPlayer (Gemini acks natively)
- The turn POST route stays server-side for one release as an API-level fallback (it is the only voice path with test coverage until the gateway has its own), then dies

### What survives

- voiceTurn wake plumbing (b89ff6a2), Sonnet voice override, SPA-404 fix
- `elevenlabs-stream.ts` + `sentence-buffer.ts` (written for this exact purpose, currently unwired; whether the gateway imports them from the voice-mode plugin package or the files move into the server is a plan-level detail, and it decides whether the `voice.speak` fallback keeps the plugin worker alive)
- `useSentenceTtsQueue` playback/barge-in queue and its 20 tests
- Voice session persistence (sessions/turns tables) for transcript history
- JSONL data flywheel requirement from the ada_local evaluation

**Explicitly dropped from the superseded plan:** the local CPU intent router (ada_local item 2). Gemini Live's function-calling already performs the chitchat-vs-dispatch split server-side, and this VPS has no headroom for another resident model. Do not resurrect it from the old plan.

## 5. Wake word "Conrad" (v1 scope)

While the /voice tab is open, the mic streams and Gemini is instructed to stay silent unless addressed ("Conrad, ..." or continuation of an active exchange). Cost of open mic: ~$0.30/hr, tab-gated. True ambient always-on wake word (screen locked, phone in pocket) requires either a local wake-word model in the browser (new download, the thing we are deleting) or a native shell; explicitly out of scope for v1, recorded for the phase after.

## 6. Error handling

- **iOS tab suspension (the most common drop on the primary device):** locking the screen, switching apps, or Safari memory eviction suspends `getUserMedia` and kills the client WS. Decision: the gateway holds the Gemini Live session warm for 60 seconds after client disconnect; if the same user reconnects inside that window (refocusing the tab), the conversation continues where it left off; past 60s the session closes and the next tap starts fresh. The client treats `visibilitychange`/`pageshow` as reconnect triggers. No attempt at background audio in v1: locked phone = not listening, by design.
- Gemini WS drop: gateway reconnects with context restore; client shows reconnect state, mic keeps buffering ~5s.
- ElevenLabs WS drop: fall back to non-streaming `voice.speak` per sentence (existing path); log loudly.
- Conrad run failure: gateway injects the failure as a system message; Gemini tells Dom verbally what failed.
- iOS autoplay: audio unlocked by the tap-to-start gesture before anything tries to play.

## 7. Testing

- Gateway: unit tests with a mocked `@google/genai` session (function-call routing, sentence piping, barge-in drain, reconnect restore, JSONL writes, `appendTurn` persistence for both user and assistant turns).
- Client: hook tests for mic framing + playback queue (queue tests exist).
- End-to-end smoke that proves the lesson of wake 9/10: a scripted WS session must show the dispatched prompt ARRIVING in the Conrad run log (transcript delivery is the assertion, not just pipeline liveness).
- Field acceptance (Dom, on phone): mic permission < 2s from tap, spoken reply to chitchat < 2s, real task dispatched and result spoken when ready, mid-sentence interruption works.

## 8. Cost

Voice layer is pennies per hour (audio in $0.005/min, text out ~$0.001/reply, Flash TTS ~$0.05-0.08/spoken-min). Claude runs remain 90-95% of spend; unchanged by this rearchitecture (Sonnet on voice turns already shipped).

## 9. Decisions for Dom

1. **Approve rip-and-replace scope** (section 4): old browser pipeline deleted, gateway lives inside the server process.
2. **Voice output default:** confirm cascade-with-Kenn (Decision 1 Option B) stays the default, native-audio behind a flag. "Replace with ada_v2" taken literally would mean native audio and no Kenn.
3. **Wake word v1 = tab-open gating** (section 5); true ambient is a follow-up phase.
