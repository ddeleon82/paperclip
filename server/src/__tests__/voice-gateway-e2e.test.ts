/**
 * Task 12 — E2E transcript-delivery assertion (FRE-1296).
 *
 * Verifies the end-to-end path from a Gemini Live tool call through to the
 * rendered wake prompt that Conrad receives. Specifically:
 *
 *   dispatch_to_conrad(prompt) → wakeup opts.contextSnapshot.voiceTurn.transcript
 *                               → renderPaperclipWakePrompt payload
 *                               → rendered text contains the literal transcript
 *
 * This closes the "pipeline liveness ≠ transcript delivery" gap: the test
 * would fail if routeToolCall stopped threading the transcript through
 * contextSnapshot or if the wake-payload schema changed.
 *
 * Uses REAL routeToolCall and REAL renderPaperclipWakePrompt with a fake
 * wakeup that captures opts. No DB, no network.
 */

import { describe, expect, it, vi } from "vitest";
import { routeToolCall, type ToolDeps } from "../services/voice-gateway/tools.js";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";

const TRANSCRIPT = "What is on the board today?";

const ctx = {
  companyId: "company-e2e",
  agentId: "agent-e2e",
  sessionId: "session-e2e",
  userId: "user-e2e",
};

function makeDeps(overrides?: Partial<ToolDeps>): ToolDeps {
  return {
    wakeup: vi.fn().mockResolvedValue({ id: "run-e2e" }),
    getRunStatus: vi.fn().mockResolvedValue({ status: "running" }),
    boardSnapshot: vi.fn().mockResolvedValue({ counts: {}, recent: [] }),
    ...overrides,
  };
}

describe("voice gateway E2E: transcript delivery", () => {
  it("threads transcript from dispatch_to_conrad through to the rendered wake prompt", async () => {
    const deps = makeDeps();

    const result = await routeToolCall(deps, ctx, {
      name: "dispatch_to_conrad",
      args: { prompt: TRANSCRIPT },
    });

    // 1. Tool call succeeded
    expect(result.response).toMatchObject({ status: "dispatched" });
    expect(result.dispatchedRunId).toBe("run-e2e");

    // 2. wakeup was called once with the correct agentId
    expect(deps.wakeup).toHaveBeenCalledOnce();
    const [calledAgentId, calledOpts] = (deps.wakeup as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(calledAgentId).toBe(ctx.agentId);

    // 3. contextSnapshot.voiceTurn carries the literal transcript
    const contextSnapshot = calledOpts.contextSnapshot as Record<string, unknown>;
    const voiceTurn = contextSnapshot.voiceTurn as Record<string, unknown>;
    expect(voiceTurn).toBeDefined();
    expect(voiceTurn.transcript).toBe(TRANSCRIPT);

    // 4. The rendered wake prompt contains the literal transcript text.
    //    This is the key assertion: even if the pipeline is alive, Conrad will
    //    never hear the user's words unless transcript flows through to here.
    const rendered = renderPaperclipWakePrompt({ voiceTurn });
    expect(rendered).toContain(TRANSCRIPT);

    // 5. The rendered prompt is the voice-turn template, not the generic issue wake
    expect(rendered).toContain("Voice Turn");
    expect(rendered).toContain("Transcript:");
  });

  it("rendered wake prompt includes voice instructions when present", async () => {
    const deps = makeDeps();

    await routeToolCall(deps, ctx, {
      name: "dispatch_to_conrad",
      args: { prompt: TRANSCRIPT },
    });

    const [, calledOpts] = (deps.wakeup as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    const contextSnapshot = calledOpts.contextSnapshot as Record<string, unknown>;
    const voiceTurn = contextSnapshot.voiceTurn as Record<string, unknown>;

    // instructions should be the VOICE_SYSTEM_PROMPT string (non-empty)
    expect(typeof voiceTurn.instructions).toBe("string");
    expect((voiceTurn.instructions as string).length).toBeGreaterThan(0);

    // When instructions are present they appear in the rendered output
    const rendered = renderPaperclipWakePrompt({ voiceTurn });
    expect(rendered).toContain(voiceTurn.instructions as string);
  });

  it("empty prompt does not call wakeup and produces no wake payload", async () => {
    const deps = makeDeps();

    const result = await routeToolCall(deps, ctx, {
      name: "dispatch_to_conrad",
      args: { prompt: "   " },
    });

    expect(deps.wakeup).not.toHaveBeenCalled();
    expect(result.response).toEqual({ error: "empty prompt" });

    // renderPaperclipWakePrompt with no voiceTurn should produce empty string
    const rendered = renderPaperclipWakePrompt({});
    expect(rendered).toBe("");
  });
});
