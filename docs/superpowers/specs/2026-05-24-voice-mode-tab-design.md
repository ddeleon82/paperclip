# Voice Mode Tab — Design Spec

- **Date:** 2026-05-24
- **Issue:** FRE-968 ("Lack of true voice mode is really hurting my productivity")
- **Owner:** Conrad
- **Reviewer (planned):** Kimi K2 (post-plan)
- **Status:** Approved by Dom, ready for implementation planning

---

## 1. Problem

Dom wants ChatGPT-style voice mode inside Paperclip for hands-free use while driving and on the road. The existing voice plugin ships a composer mic and a comment TTS slot, but there is no dedicated, continuous, fully voice-driven surface. Two related gaps surfaced during design:

1. The composer auto-send flow does not echo transcribed text into the composer before sending, so Dom cannot see what was heard.
2. Agent runs triggered by voice often complete without posting a closing reply comment, so Dom has to navigate into the run output to find the result.

Both gaps make the current partial voice mode unusable hands-free.

## 2. Goals

- A dedicated **Voice Mode** tab under the **Work** sidebar group, route `/voice`.
- Inside the tab: always-listening VAD-driven conversation with Kenn voice (ElevenLabs `VjSFSNiy9sK85Z9QRu3d`).
- Outside the tab: tap-to-talk continues to be the composer behavior.
- Kenn can call a `create_issue` tool when Dom asks, and confirms the result verbally.
- Every agent turn that originated from voice posts a final reply comment **and** auto-plays it as TTS — including tool-only completions.
- Composer auto-send mode shows the transcript in the composer before sending.

## 3. Non-goals (MVP)

- Wake word ("Hey Conrad")
- Multi-language STT
- Selecting voices other than Kenn
- Picking a specific thread to "voice into" (the tab talks to a default Conrad agent)
- Sharing transcripts externally
- Native mobile app (browser-only, mobile-responsive)

## 4. User flows

### 4.1 Voice Mode tab (dedicated `/voice`)

1. Dom opens `/voice` from the **Work** group in the left nav.
2. Browser requests microphone permission (one-time).
3. Page mounts the orb UI, sets state `idle`, then starts VAD.
4. VAD detects speech → state `listening`, recording starts.
5. VAD detects 1.2 s of trailing silence → recording stops, blob → STT.
6. Transcript appended to scrollback as a Dom turn → sent to the agent.
7. State `thinking`. Agent streams response over WebSocket.
8. As each sentence boundary is detected in the stream, fire a TTS chunk; play sentences in order. State `speaking`.
9. While speaking, VAD continues. If Dom speaks → playback halts immediately (barge-in), new turn begins.
10. After Kenn finishes the last sentence and Dom is silent → state returns to `listening`.
11. Dom can hit **End session** to stop, **Mute** to pause mic without leaving the page, **Interrupt** to cut off Kenn manually.

### 4.2 Composer auto-send (existing surface, fixed)

1. Dom taps the mic icon (toggle is on for auto-send).
2. Records until he taps stop (existing behavior).
3. Transcript inserts into the composer (new: visible echo).
4. After a 300 ms display pause, composer submit fires automatically.
5. Server tags the resulting agent run with `originatedVia = "voice"`.
6. Agent does the work and must end its run with a one-paragraph spoken summary as a normal comment.
7. The composer's mic UI listens on the WebSocket `heartbeat.run.log` channel for that run. When the run completes, the final assistant message is auto-played via TTS (no click required).

### 4.3 Create-an-issue from inside `/voice`

1. Dom: "Kenn, create an issue under FRE about adding wake-word support."
2. Agent calls `create_issue` tool with title/body/project derived from the conversation.
3. Tool returns the new issue identifier (e.g. `FRE-987`).
4. Agent emits a one-line spoken confirmation: "Created FRE-987 with title X. Want me to add anything else?"
5. TTS speaks that line. Loop resumes.

## 5. Architecture

### 5.1 Frontend

- **Page**: `ui/src/pages/VoiceMode.tsx`
  - Single route `/voice` mounted via the existing routing layer.
  - Owns the state machine: `idle → listening → thinking → speaking`.
  - Mobile-first responsive layout (Dom uses it on phone in the car).
- **Nav**: extend the left sidebar in the **Work** group with a `Voice Mode` link.
- **VAD**: `@ricky0123/vad-web` (Silero VAD, ONNX, runs in browser via Web Audio API).
- **STT**: reuse `useVoiceActions().transcribeAudio(blob)` (already wired to ElevenLabs Scribe v2).
- **TTS (streaming)**: new `useStreamingTts(text$, voiceId)` hook that connects to ElevenLabs WS endpoint, plays chunks as they arrive via the Web Audio API.
- **Agent stream**: subscribe to the existing `heartbeat.run.log` WebSocket channel for the ephemeral voice run; consume `assistant_text_delta` and `tool_result` events.
- **Scrollback**: simple in-memory list of `{role, text, ts}`, last 8 visible.
- **Orb**: pure CSS / SVG animation, state-driven (no extra dep).

### 5.2 Backend

- **New runtime entry point**: a "voice session" agent runner — an ephemeral agent run that does not belong to an issue. Spawned via `POST /api/voice/session` returning a sessionId. Subsequent turns: `POST /api/voice/session/:id/turn` with transcript text.
- **System prompt** for the voice agent: Conrad persona tuned for speech — short sentences, no markdown, no code fences, no emdashes, never apologize, end every turn with a spoken summary even when calling tools.
- **Tools available to the voice agent**: `create_issue(title, body, projectKey?)`. (Future: `list_my_issues`, `update_issue_status`. Out of scope for MVP.)
- **Voice-tagged runs**: add column `runs.originated_via` (text, nullable, values: `voice` | `voice_session` | null). All composer voice runs and all `/voice` session turns set this column.
- **Transcript log**: new `voice_sessions` table (id, userId, startedAt, endedAt, transcript jsonb). One row per `/voice` visit. Not exposed in the issue list.

### 5.3 Telemetry & safety

- Log VAD events (utterance start/stop, silence duration) to the browser console behind a `?voiceDebug=1` flag — never on by default.
- Mic permission is requested only inside `/voice` or on first composer mic click. No background mic capture.
- On `visibilitychange = hidden`, mute mic and pause TTS to avoid background playback.
- On hard reload or navigation away from `/voice`, terminate the voice session server-side.

## 6. Data flow

```
Dom voice
   │
   ▼
[ Browser mic → VAD ] ──blob──► /api/voice/transcribe ──► STT (ElevenLabs Scribe)
                                                              │
                                                              ▼
                                       /api/voice/session/:id/turn (text)
                                                              │
                                                              ▼
                                       Voice agent runner (Claude) — streams via WS
                                                              │
                                                              ├─ assistant_text_delta ─► sentence buffer
                                                              │                              │
                                                              │                              ▼
                                                              │              ElevenLabs WS TTS ──► browser audio
                                                              │
                                                              └─ tool_call create_issue ──► Paperclip API
                                                                            │
                                                                            ▼
                                                              tool_result confirms id
                                                              (agent then emits final summary text)
```

## 7. Error handling

| Condition | Behavior |
|---|---|
| Mic permission denied | Show full-page "Voice Mode needs microphone access" with a "Try again" button. No silent failure. |
| STT request fails | Speak: "I didn't catch that, try again." Return to `listening`. |
| Agent stream errors mid-turn | Speak: "Something broke on my end. Try again or check the dashboard." Log to console + post error comment to the rolling voice-session log issue. |
| ElevenLabs TTS errors | Fallback to non-streaming TTS via the existing `/api/voice/speak` endpoint. If that also fails, show a text-only fallback in the scrollback. |
| Page hidden / network drops mid-stream | Mute mic, pause playback, reconnect WS with backoff. |
| Tool call fails (e.g. `create_issue` rejected) | Agent must verbalize the failure: "Couldn't create that, the project key doesn't exist. Want me to try a different one?" |

## 8. Testing strategy

### 8.1 Unit
- `useVoiceModeStateMachine` reducer tests for state transitions, including barge-in.
- `sentenceBuffer` parser tests: handles abbreviations, decimals, ellipses correctly.
- `voice-session` agent runner: tool dispatch happy path + 1 failure mode.

### 8.2 Integration
- Server: `POST /api/voice/session` + turn round-trip with a mocked Claude stream.
- DB migration: `runs.originated_via` column added with backfill of null.

### 8.3 Manual
- End-to-end script in `docs/superpowers/specs/2026-05-24-voice-mode-manual-test.md` (created in plan phase):
  - Open `/voice` on desktop Firefox, talk, verify barge-in.
  - Same on iOS Safari (phone).
  - Composer auto-send: speak, see transcript echo, hear TTS reply auto-play.
  - "Kenn create an issue about X" — verify FRE issue exists and confirmation is spoken.

## 9. Rollout

- Single behind-the-flag deploy: `VOICE_MODE_TAB_ENABLED` env var (default off) gates the nav link and the route mount.
- Dom flips the flag to true once he's confirmed in dev.
- After 7 days of clean use, remove the flag.

## 10. Open questions (resolved before plan)

- **Which Claude model?** Use the same model the rest of the Paperclip agent runtime uses. No special model for voice.
- **Where does the rolling voice log live?** New `voice_sessions` table, not an issue. Cleaner separation.
- **Do we keep the existing `commentAnnotation` speaker icons?** No. Dom explicitly said he doesn't need them. Plugin manifest still exports the slot for future use, but the registration is removed.

## 11. Out of scope follow-ups

- Wake word
- Multi-voice picker
- Per-issue voice (talk to a specific thread)
- iOS native shortcut: "Hey Siri, talk to Conrad" → opens `/voice`
- Background continuous mode (CarPlay-style)
