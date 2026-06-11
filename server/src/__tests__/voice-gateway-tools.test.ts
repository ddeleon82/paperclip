import { describe, expect, it, vi } from "vitest";
import { routeToolCall, type ToolDeps } from "../services/voice-gateway/tools.js";
import { VOICE_SYSTEM_PROMPT } from "../services/voice-prompt.js";

const DEFAULT_MODEL = "claude-sonnet-4-6";

function makeDeps(overrides?: Partial<ToolDeps>): ToolDeps {
  return {
    wakeup: vi.fn().mockResolvedValue({ id: "run-123" }),
    getRunStatus: vi.fn().mockResolvedValue({ status: "running" }),
    boardSnapshot: vi.fn().mockResolvedValue({
      counts: { in_progress: 3, todo: 1 },
      recent: [{ identifier: "FRE-1", title: "Test", status: "in_progress" }],
    }),
    ...overrides,
  };
}

const ctx = {
  companyId: "company-1",
  agentId: "agent-1",
  sessionId: "session-1",
  userId: "user-1",
};

describe("routeToolCall - dispatch_to_conrad", () => {
  it("calls wakeup with correct opts and returns runId", async () => {
    const deps = makeDeps();
    const result = await routeToolCall(deps, ctx, {
      name: "dispatch_to_conrad",
      args: { prompt: "What is on the board?" },
    });

    expect(deps.wakeup).toHaveBeenCalledOnce();
    const [calledAgentId, calledOpts] = (deps.wakeup as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(calledAgentId).toBe(ctx.agentId);
    expect(calledOpts).toMatchObject({
      source: "voice_session",
      contextSnapshot: {
        voiceTurn: {
          transcript: "What is on the board?",
          instructions: VOICE_SYSTEM_PROMPT,
        },
      },
    });
    expect(result).toEqual({
      response: { runId: "run-123", status: "dispatched" },
      dispatchedRunId: "run-123",
    });
  });

  it("respects process.env.VOICE_WAKEUP_MODEL override", async () => {
    const deps = makeDeps();
    const origEnv = process.env.VOICE_WAKEUP_MODEL;
    process.env.VOICE_WAKEUP_MODEL = "custom-model";
    try {
      await routeToolCall(deps, ctx, {
        name: "dispatch_to_conrad",
        args: { prompt: "Test" },
      });
      const [, opts] = (deps.wakeup as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        Record<string, unknown>,
      ];
      const snapshot = opts.contextSnapshot as Record<string, unknown>;
      expect(snapshot.modelOverride).toBe("custom-model");
    } finally {
      if (origEnv === undefined) {
        delete process.env.VOICE_WAKEUP_MODEL;
      } else {
        process.env.VOICE_WAKEUP_MODEL = origEnv;
      }
    }
  });

  it("uses default model when env var is not set", async () => {
    const deps = makeDeps();
    const origEnv = process.env.VOICE_WAKEUP_MODEL;
    delete process.env.VOICE_WAKEUP_MODEL;
    try {
      await routeToolCall(deps, ctx, {
        name: "dispatch_to_conrad",
        args: { prompt: "Test" },
      });
      const [, opts] = (deps.wakeup as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        Record<string, unknown>,
      ];
      const snapshot = opts.contextSnapshot as Record<string, unknown>;
      expect(snapshot.modelOverride).toBe(DEFAULT_MODEL);
    } finally {
      if (origEnv !== undefined) {
        process.env.VOICE_WAKEUP_MODEL = origEnv;
      }
    }
  });

  it("returns error and does not call wakeup for blank prompt", async () => {
    const deps = makeDeps();
    const result = await routeToolCall(deps, ctx, {
      name: "dispatch_to_conrad",
      args: { prompt: "  " },
    });

    expect(deps.wakeup).not.toHaveBeenCalled();
    expect(result).toEqual({ response: { error: "empty prompt" } });
  });

  it("returns error and does not call wakeup for missing prompt", async () => {
    const deps = makeDeps();
    const result = await routeToolCall(deps, ctx, {
      name: "dispatch_to_conrad",
      args: {},
    });

    expect(deps.wakeup).not.toHaveBeenCalled();
    expect(result).toEqual({ response: { error: "empty prompt" } });
  });

  it("maps wakeup returning null to dispatch failed error", async () => {
    const deps = makeDeps({ wakeup: vi.fn().mockResolvedValue(null) });
    const result = await routeToolCall(deps, ctx, {
      name: "dispatch_to_conrad",
      args: { prompt: "Valid prompt" },
    });

    expect(result).toEqual({ response: { error: "dispatch failed" } });
  });
});

describe("routeToolCall - check_run", () => {
  it("returns run status", async () => {
    const deps = makeDeps({ getRunStatus: vi.fn().mockResolvedValue({ status: "succeeded" }) });
    const result = await routeToolCall(deps, ctx, {
      name: "check_run",
      args: { runId: "run-abc" },
    });

    expect(deps.getRunStatus).toHaveBeenCalledWith("run-abc");
    expect(result).toEqual({ response: { status: "succeeded" } });
  });

  it("maps null status to unknown run error", async () => {
    const deps = makeDeps({ getRunStatus: vi.fn().mockResolvedValue(null) });
    const result = await routeToolCall(deps, ctx, {
      name: "check_run",
      args: { runId: "run-missing" },
    });

    expect(result).toEqual({ response: { error: "unknown run" } });
  });
});

describe("routeToolCall - board_snapshot", () => {
  it("passes companyId through and returns snapshot", async () => {
    const snapshot = {
      counts: { in_progress: 5 },
      recent: [{ identifier: "FRE-2", title: "Issue", status: "in_progress" }],
    };
    const deps = makeDeps({ boardSnapshot: vi.fn().mockResolvedValue(snapshot) });
    const result = await routeToolCall(deps, ctx, {
      name: "board_snapshot",
      args: {},
    });

    expect(deps.boardSnapshot).toHaveBeenCalledWith(ctx.companyId);
    expect(result).toEqual({ response: snapshot });
  });
});

describe("routeToolCall - unknown tool", () => {
  it("returns unknown tool error", async () => {
    const deps = makeDeps();
    const result = await routeToolCall(deps, ctx, {
      name: "some_unknown_tool",
      args: {},
    });

    expect(result).toEqual({ response: { error: "unknown tool" } });
    expect(deps.wakeup).not.toHaveBeenCalled();
    expect(deps.getRunStatus).not.toHaveBeenCalled();
    expect(deps.boardSnapshot).not.toHaveBeenCalled();
  });
});
