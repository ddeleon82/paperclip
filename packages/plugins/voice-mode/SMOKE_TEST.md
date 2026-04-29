# Voice Mode Plugin — Manual Smoke Test Checklist

**Plugin version:** 0.1.0  
**Branch:** feat/fre-381-voice-mode  
**Last updated:** 2026-04-29

---

## Prerequisites

- [ ] Plugin installed on target Paperclip instance
- [ ] `ELEVENLABS_API_KEY` secret registered in instance secrets under the key `ELEVENLABS_API_KEY`
- [ ] At least one issue with one or more comments exists in the test workspace
- [ ] Browser: Chrome or Firefox (MediaRecorder + Web Audio required)

---

## 1. Plugin Worker Health

| Step | Expected |
|---|---|
| Navigate to instance admin > Plugins > Voice Mode | Plugin shows status "active" |
| Click "Ping Worker" on the DashboardWidget | No error toast, widget shows `status: ok` and a recent `checkedAt` timestamp |

---

## 2. Voice Mode Toggle (Composer Controls)

The `VoiceComposerControlsSlot` is mounted as a **toolbarButton** on the issue page (interim placement until `chat-composer-trailing` slot is added to core).

| Step | Expected |
|---|---|
| Open any issue detail page | Voice controls icon (Volume2) visible in issue toolbar |
| Click the Volume2 icon | Icon opacity changes to 1.0 (voice mode ON); state persists in `localStorage` |
| Refresh the page | Voice mode toggle remains ON |
| Click icon again | Toggles OFF |

---

## 3. Push-to-Talk Recording (Mic)

_Requires voice mode ON and microphone permission._

| Step | Expected |
|---|---|
| With voice mode ON, focus outside any text input | Spacebar held > 200ms triggers recording (mic icon turns red) |
| Release spacebar | Recording stops; transcript auto-inserts into the compose field via `voice-mode:auto-send` event |
| Press spacebar < 200ms | Recording discarded, no transcript |
| Click mic button | Same start/stop behavior via click |

---

## 4. Per-Comment TTS (MessageSpeakerButton)

The `MessageSpeakerButton` is mounted as a **commentAnnotation** slot below each comment.

| Step | Expected |
|---|---|
| Open an issue with at least one comment | Small Volume2 button appears below the comment body |
| With voice mode OFF: click the Volume2 button | No audio plays (button still renders) |
| Turn voice mode ON; navigate to an issue with a new comment (not yet played this session) | Comment auto-plays once on mount |
| Refresh the page | Comment does NOT auto-play again (sessionStorage key set) |
| Click Volume2 button manually | Audio plays; button switches to Square (stop) icon |
| Click Square button while audio is playing | Playback stops immediately |
| Press spacebar while audio is playing | Playback stops (spacebar stop handler in useVoiceMode) |

---

## 5. Per-Agent Voice Settings

The `VoiceSettingsPanel` is mounted as a **settingsPage** slot.

| Step | Expected |
|---|---|
| Navigate to Plugin Settings > Voice Mode | Settings panel renders with "Voice Mode Settings" heading |
| Paste valid JSON `{ "agent-uuid": "VjSFSNiy9sK85Z9QRu3d" }` into the textarea | No JSON error shown |
| Click "Apply" | "Saved." status appears briefly; entry persists across page refresh |
| Paste invalid JSON and click Apply | Error message "Invalid JSON." appears |
| After saving an agent entry, reload the panel | Entry appears in the "Stored Agent Voice Assignments" section with a voice select dropdown |
| Change the voice select dropdown | New voice ID saves immediately; subsequent TTS for that agent uses the new voice |

---

## 6. Known Limitations (V1)

- **Secret must be manually registered.** The `ELEVENLABS_API_KEY` secret ref is not provisioned automatically. An instance admin must add it via the Secrets management UI before TTS/STT will work. Without it, the plugin worker will fail setup.
- **Comment text extraction is heuristic.** `MessageSpeakerButton` reads comment text via `[data-comment-id]` or `[data-entity-id]` DOM selectors. If the host renders comments without these attributes, auto-play will silently skip (no text found).
- **Agent enumeration not available.** The settings panel uses manual JSON input because `PluginHostContext` does not expose an agent list. Per-agent voice assignments use `parentEntityId` (issue ID) as a proxy scope key.
- **Composer slot is interim.** `VoiceComposerControlsSlot` renders in the issue toolbar, not the composer trailing area. Requires a `chat-composer-trailing` slot addition to core `IssueChatThread.tsx` for production placement.
- **Auto-send wiring is interim.** Transcript dispatch uses `CustomEvent("voice-mode:auto-send")` which requires a listener in core. Until that listener exists, transcripts won't auto-insert into the composer.
