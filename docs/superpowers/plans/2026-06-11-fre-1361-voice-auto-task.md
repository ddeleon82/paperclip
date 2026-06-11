# FRE-1361: Voice Auto-Create Task + Live Working State Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When Dom makes an actionable request by voice, the gateway creates a Paperclip board issue, dispatches Conrad against it, speaks the identifier back, and the existing voice orb shifts color and gains motion while the run is active (Dom's explicit minimal-UI directive, see Chunk 3).

**Architecture:** One new gateway tool, `create_task`, that creates a board issue via the server's existing issue-creation path and then dispatches a Conrad run referencing it (single tool call per turn for Gemini). One new client protocol message, `task-created`, emitted alongside the existing `run-dispatched`. The voice UI derives a "working" display phase from active runIds and feeds it to the existing VoicePoweredOrb, resolved by the existing `run-complete` message. Prompt gains a create-vs-dispatch decision rule.

**Tech Stack:** TypeScript, vitest, drizzle, React (ui/), existing voice-gateway module layout on branch feat/voice-mode-tab.

**Context for implementers (verified 2026-06-11):**
- Tool declarations: `server/src/services/voice-gateway/tool-defs.ts` (GATEWAY_TOOL_DEFS array).
- Tool router + deps: `server/src/services/voice-gateway/tools.ts` (`routeToolCall`, `ToolDeps`, `makeToolDeps`). Deps are injected, never imported, so tests stay hermetic.
- Client protocol union: `server/src/services/voice-gateway/protocol.ts` lines 16-24.
- TWO places send `run-dispatched`: `session.ts` (~line 287, live-event subscription path) and `session-registry.ts` (~line 308, polling path). Determine which is wired in `server/src/index.ts` (~lines 584-646) and update the live one; if both are reachable, update both identically.
- UI handler: `ui/src/pages/VoiceMode.tsx` switch cases `run-dispatched` (line 163) and `run-complete` (line 167), both currently no-ops. Socket hook: `ui/src/hooks/useVoiceGatewaySocket.ts`.
- Prompt: `server/src/services/voice-gateway/prompt.ts` (`buildGatewaySystemPrompt`); every rule is tested verbatim in `voice-gateway-prompt.test.ts`.
- Existing tests to mirror: `server/src/__tests__/voice-gateway-tools.test.ts`, `voice-gateway-prompt.test.ts`, `voice-gateway-session.test.ts`.
- Issue creation MUST reuse the server's existing issue-creation service (the code path behind POST /api/issues) so identifier sequencing (FRE-NNNN), defaults, and live-event emission stay consistent. Grep for the route handler and call the same service function from `makeToolDeps`. Do NOT hand-insert into the issues table.
- NO emdashes anywhere (code, comments, commit messages). Run tests with `cd /home/deploy/paperclip/server && npx -y pnpm@9.15.4 exec vitest run src/__tests__/<file> --reporter=dot`. Never restart pm2.

---

## Chunk 1: Server tool surface

### Task 1: create_task tool declaration + protocol message

**Files:**
- Modify: `server/src/services/voice-gateway/tool-defs.ts`
- Modify: `server/src/services/voice-gateway/protocol.ts`
- Test: `server/src/__tests__/voice-gateway-tools.test.ts` (declaration shape assertions live wherever GATEWAY_TOOL_DEFS is already asserted)

- [ ] **Step 1: Write failing tests** asserting GATEWAY_TOOL_DEFS contains a `create_task` declaration with required `title` (string) and optional `detail` (string) properties, and that the protocol union accepts `{ type: "task-created", identifier, title, runId }` (type-level test via a literal assignment in a test file).
- [ ] **Step 2: Run tests, verify FAIL.**
- [ ] **Step 3: Implement.** Add to tool-defs.ts:

```ts
/**
 * Create a Paperclip board task from the user's request, then start Conrad on it.
 */
export const CREATE_TASK: GatewayFunctionDeclaration = {
  name: "create_task",
  description:
    "Create a task on the Paperclip board from the user's request and start Conrad working on it. Returns the task identifier and a runId. Use when the user asks for NEW actionable work. Do not use for questions or status checks.",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Short imperative task title, under 80 characters.",
      },
      detail: {
        type: "string",
        description: "The user's full request, verbatim or lightly cleaned up.",
      },
    },
    required: ["title"],
  },
};
```

Append CREATE_TASK to GATEWAY_TOOL_DEFS. Add to protocol.ts union: `| { type: "task-created"; identifier: string; title: string; runId: string }`.
- [ ] **Step 4: Run tests, verify PASS.**
- [ ] **Step 5: Commit** `feat(voice-gateway): declare create_task tool + task-created protocol message (FRE-1361)`.

### Task 2: route create_task in tools.ts

**Files:**
- Modify: `server/src/services/voice-gateway/tools.ts`
- Test: `server/src/__tests__/voice-gateway-tools.test.ts`

- [ ] **Step 1: Write failing tests** with fake deps covering: (a) create_task with title creates an issue via `deps.createIssue(companyId, { title, body })` then dispatches via `deps.wakeup` with the issue identifier woven into the transcript payload, returning `{ response: { identifier, runId, status: "dispatched" }, dispatchedRunId, createdTask: { identifier, title } }`; (b) empty/missing title returns `{ response: { error: "empty title" } }` and calls nothing; (c) createIssue returning null yields `{ response: { error: "task creation failed" } }` and no wakeup; (d) wakeup returning null still reports the created identifier with `{ response: { identifier, error: "dispatch failed" } }` (task exists even if dispatch failed).
- [ ] **Step 2: Run tests, verify FAIL.**
- [ ] **Step 3: Implement.** Extend ToolDeps with `createIssue(companyId: string, input: { title: string; body: string }): Promise<{ id: string; identifier: string } | null>`. Extend ToolCallResult with optional `createdTask?: { identifier: string; title: string }`. Add the `create_task` case mirroring `dispatch_to_conrad` (same wakeup options: source voice_session, VOICE_SYSTEM_PROMPT override, modelOverride), with the dispatch prompt formed as `Work board task ${identifier}: ${title}. ${detail}`. In `makeToolDeps`, wire `createIssue` to the existing issue-creation service used by POST /api/issues (default status per board convention, e.g. "todo"; assignee left to service defaults).
- [ ] **Step 4: Run tests, verify PASS.**
- [ ] **Step 5: Commit** `feat(voice-gateway): route create_task to issue creation + dispatch (FRE-1361)`.

## Chunk 2: Session emission + prompt

### Task 3: emit task-created from the live session path(s)

**Files:**
- Modify: `server/src/services/voice-gateway/session.ts` (and `session-registry.ts` if also live, see context note)
- Test: `server/src/__tests__/voice-gateway-session.test.ts`

- [ ] **Step 1: Write failing test:** when routeToolCall resolves with `createdTask` + `dispatchedRunId`, the session sends `{ type: "task-created", identifier, title, runId }` to the client BEFORE `{ type: "run-dispatched", runId }`, and the existing run-completion watch still fires `run-complete`.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** in the tool-result handling block (session.ts ~line 285): if `result.createdTask && result.dispatchedRunId`, send task-created first. Mirror in session-registry.ts if it is reachable from index.ts wiring.
- [ ] **Step 4: Run full voice-gateway-session tests, verify PASS.**
- [ ] **Step 5: Commit** `feat(voice-gateway): emit task-created before run-dispatched (FRE-1361)`.

### Task 4: prompt create-vs-dispatch rule

**Files:**
- Modify: `server/src/services/voice-gateway/prompt.ts`
- Test: `server/src/__tests__/voice-gateway-prompt.test.ts`

- [ ] **Step 1: Write failing tests** asserting the prompt contains a TASK CREATION section with the rules below (verbatim substring assertions, matching the existing test style).
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement.** Add after PERSONA CONTAINMENT:

```
TASK CREATION:
When the user asks for new actionable work, call create_task with a short title and the full request as detail. Then tell the user the task identifier and that Conrad is on it.
When the user asks a question, wants a status update, or asks about existing work, do not create a task. Use dispatch_to_conrad, check_run, or board_snapshot instead.
Never create more than one task per user request.
```

- [ ] **Step 4: Run prompt tests, verify PASS.**
- [ ] **Step 5: Commit** `feat(voice-gateway): prompt rule for create_task vs dispatch (FRE-1361)`.

## Chunk 3: UI working state via orb

**Scope directive from Dom (FRE-1296 comment 5a191132, 2026-06-11):** NO activity card. "Ideal solution is minimal ui-a color change in the existing ring animation and new motion to show its working before Conrad answers." The orb is `ui/src/components/voice/VoicePoweredOrb.tsx`; its per-phase visuals live in the `PHASE_TO_TARGETS` map (hover = surface motion, rotation = spin speed, hueOffset = color shift in degrees). Phase comes from `VoiceMode.tsx` state (`Phase` union at line 38, status label fn at line 40, status dot classes ~line 292).

### Task 5: orb "working" state

**Files:**
- Modify: `ui/src/components/voice/VoicePoweredOrb.tsx`, `ui/src/pages/VoiceMode.tsx`
- Test: extend `ui/src/pages/VoiceMode.test.tsx` (existing test file; follow its harness/mocks)

- [ ] **Step 1: Write failing tests:** (a) after a `run-dispatched` message, the orb element (`data-testid="voice-orb"`) has `data-phase="working"` and the status label reads "Conrad is working on it"; (b) the working state holds while server `status` messages report listening or thinking, but `status: speaking` shows "speaking" (speaking wins over working); (c) after `run-complete` for the only active runId, the orb returns to the underlying machine phase; (d) two dispatched runs: completing one keeps working, completing both clears it.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement.**
  - VoicePoweredOrb.tsx: add `"working"` to the MutablePhase union and PHASE_TO_TARGETS: `working: { hover: 0.3, rotation: 1.6, hueOffset: 60 }` (distinct color shift plus faster spin and visible surface motion = new motion while Conrad works; values may be tuned but must differ clearly from idle, thinking, and speaking).
  - VoiceMode.tsx: keep the machine `phase` state untouched; add `activeRunIds: Set<string>` updated in the message switch (`run-dispatched` and `task-created` add, `run-complete` deletes). Derive `displayPhase = activeRunIds.size > 0 && (phase === "idle" || phase === "listening" || phase === "thinking") ? "working" : phase` and pass it to VoicePoweredOrb, phaseToStatusLabel, and the status dot. Add label case "Conrad is working on it" and a status dot class (e.g. `animate-pulse bg-violet-500`) for working. No new components, no card.
- [ ] **Step 4: Run UI tests, verify PASS.**
- [ ] **Step 5: Commit** `feat(voice-ui): orb working state while a dispatched run is active (FRE-1361)`.

### Task 6: verification + field handoff

- [ ] **Step 1:** Full suites: server `npx -y pnpm@9.15.4 exec vitest run src/__tests__/ --reporter=dot` (voice files all green, no regressions) and `npx -y pnpm@9.15.4 exec tsc --noEmit`; ui test + typecheck per ui/ package scripts.
- [ ] **Step 2:** Rebuild UI into server/ui-dist using the repo's existing prepare:ui-dist flow, preserving /vad assets (see commit afef3cb7 for the clobber regression to avoid).
- [ ] **Step 3:** Commit any ui-dist artifacts per repo convention.
- [ ] **Step 4:** Comment on FRE-1361 for Dom: what shipped, that it needs `pm2 restart paperclip` (his action, never ours) plus a browser hard refresh, and a 3-line acceptance script (speak an actionable request, hear the FRE identifier spoken, watch the orb shift color and motion until Conrad answers, new issue visible on the board).
