import { describe, expect, it, vi } from "vitest";
import { routeToolCall, type ToolDeps } from "../services/voice-gateway/tools.js";
import { VOICE_SYSTEM_PROMPT } from "../services/voice-prompt.js";
import { GATEWAY_TOOL_DEFS } from "../services/voice-gateway/tool-defs.js";
import type { ServerMessage } from "../services/voice-gateway/protocol.js";

const DEFAULT_MODEL = "claude-sonnet-4-6";

function makeDeps(overrides?: Partial<ToolDeps>): ToolDeps {
  return {
    wakeup: vi.fn().mockResolvedValue({ id: "run-123" }),
    getRunStatus: vi.fn().mockResolvedValue({ status: "running" }),
    boardSnapshot: vi.fn().mockResolvedValue({
      counts: { in_progress: 3, todo: 1 },
      recent: [{ identifier: "FRE-1", title: "Test", status: "in_progress" }],
    }),
    createIssue: vi.fn().mockResolvedValue({ id: "issue-uuid-1", identifier: "FRE-42" }),
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

describe("GATEWAY_TOOL_DEFS - create_task declaration", () => {
  it("contains a create_task declaration", () => {
    const decl = GATEWAY_TOOL_DEFS.find((d) => d.name === "create_task");
    expect(decl).toBeDefined();
  });

  it("create_task declaration has required title (string) property", () => {
    const decl = GATEWAY_TOOL_DEFS.find((d) => d.name === "create_task");
    expect(decl?.parameters.properties["title"]).toMatchObject({ type: "string" });
    expect(decl?.parameters.required).toContain("title");
  });

  it("create_task declaration has optional detail (string) property", () => {
    const decl = GATEWAY_TOOL_DEFS.find((d) => d.name === "create_task");
    expect(decl?.parameters.properties["detail"]).toMatchObject({ type: "string" });
    expect(decl?.parameters.required).not.toContain("detail");
  });
});

describe("routeToolCall - create_task", () => {
  it("creates an issue then dispatches via wakeup with identifier woven into transcript, returning identifier + runId + createdTask", async () => {
    const deps = makeDeps();
    const result = await routeToolCall(deps, ctx, {
      name: "create_task",
      args: { title: "Ship the new feature", detail: "Make sure tests pass first." },
    });

    expect(deps.createIssue).toHaveBeenCalledOnce();
    const [calledCompanyId, calledInput] = (deps.createIssue as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { title: string; body: string },
    ];
    expect(calledCompanyId).toBe(ctx.companyId);
    expect(calledInput.title).toBe("Ship the new feature");
    expect(calledInput.body).toBe("Make sure tests pass first.");

    expect(deps.wakeup).toHaveBeenCalledOnce();
    const [calledAgentId, calledOpts] = (deps.wakeup as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(calledAgentId).toBe(ctx.agentId);
    expect(calledOpts).toMatchObject({
      source: "voice_session",
      contextSnapshot: {
        voiceSystemPromptOverride: VOICE_SYSTEM_PROMPT,
        voiceTurn: expect.objectContaining({
          transcript: expect.stringContaining("FRE-42"),
        }),
      },
    });

    expect(result).toEqual({
      response: { identifier: "FRE-42", runId: "run-123", status: "dispatched" },
      dispatchedRunId: "run-123",
      createdTask: { identifier: "FRE-42", title: "Ship the new feature" },
    });
  });

  it("returns empty title error and calls nothing when title is blank", async () => {
    const deps = makeDeps();
    const result = await routeToolCall(deps, ctx, {
      name: "create_task",
      args: { title: "   " },
    });

    expect(deps.createIssue).not.toHaveBeenCalled();
    expect(deps.wakeup).not.toHaveBeenCalled();
    expect(result).toEqual({ response: { error: "empty title" } });
  });

  it("returns empty title error and calls nothing when title is missing", async () => {
    const deps = makeDeps();
    const result = await routeToolCall(deps, ctx, {
      name: "create_task",
      args: {},
    });

    expect(deps.createIssue).not.toHaveBeenCalled();
    expect(deps.wakeup).not.toHaveBeenCalled();
    expect(result).toEqual({ response: { error: "empty title" } });
  });

  it("returns task creation failed error and no wakeup when createIssue returns null", async () => {
    const deps = makeDeps({ createIssue: vi.fn().mockResolvedValue(null) });
    const result = await routeToolCall(deps, ctx, {
      name: "create_task",
      args: { title: "Valid title" },
    });

    expect(deps.createIssue).toHaveBeenCalledOnce();
    expect(deps.wakeup).not.toHaveBeenCalled();
    expect(result).toEqual({ response: { error: "task creation failed" } });
  });

  it("reports created identifier with dispatch failed error when wakeup returns null", async () => {
    const deps = makeDeps({ wakeup: vi.fn().mockResolvedValue(null) });
    const result = await routeToolCall(deps, ctx, {
      name: "create_task",
      args: { title: "Valid title" },
    });

    expect(deps.createIssue).toHaveBeenCalledOnce();
    expect(deps.wakeup).toHaveBeenCalledOnce();
    expect(result).toEqual({
      response: { identifier: "FRE-42", error: "dispatch failed" },
      createdTask: { identifier: "FRE-42", title: "Valid title" },
    });
  });

  it("builds dispatch prompt without trailing undefined when detail is absent", async () => {
    const deps = makeDeps();
    await routeToolCall(deps, ctx, {
      name: "create_task",
      args: { title: "Task with no detail" },
    });

    const [, calledOpts] = (deps.wakeup as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    const snapshot = calledOpts.contextSnapshot as Record<string, unknown>;
    const voiceTurn = snapshot.voiceTurn as Record<string, unknown>;
    expect(typeof voiceTurn.transcript).toBe("string");
    expect((voiceTurn.transcript as string)).not.toContain("undefined");
  });
});

describe("ServerMessage protocol - task-created member", () => {
  it("accepts a task-created message (type-level assignment)", () => {
    // If ServerMessage does not include { type: "task-created"; ... }, TypeScript compilation fails.
    const msg: ServerMessage = {
      type: "task-created",
      identifier: "FRE-1234",
      title: "Build the thing",
      runId: "run-abc",
    };
    expect(msg.type).toBe("task-created");
  });
});
