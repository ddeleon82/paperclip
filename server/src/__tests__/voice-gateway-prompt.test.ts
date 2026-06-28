/**
 * Tests for gateway system prompt and tool declarations (FRE-1296).
 * Pure function tests - no network I/O.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { buildGatewaySystemPrompt } from "../services/voice-gateway/prompt.js";
import {
  DISPATCH_TO_CONRAD,
  CHECK_RUN,
  BOARD_SNAPSHOT,
  CREATE_TASK,
} from "../services/voice-gateway/tool-defs.js";

// ---------------------------------------------------------------------------
// buildGatewaySystemPrompt content checks
// ---------------------------------------------------------------------------

describe("buildGatewaySystemPrompt", () => {
  let prompt: string;

  beforeAll(() => {
    prompt = buildGatewaySystemPrompt();
  });

  it("returns a non-empty string", () => {
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("identifies the speaker as Conrad himself", () => {
    expect(prompt).toContain("You are Conrad, the AI chief of staff");
  });

  it("does not frame the gateway as a front desk for Conrad", () => {
    expect(prompt).not.toContain("front desk");
  });

  it("contains the first person rule", () => {
    expect(prompt).toContain("Speak in the first person");
  });

  it("forbids referring to Conrad in the third person", () => {
    expect(prompt).toContain("Never refer to Conrad in the third person");
  });

  it("forbids saying work was handed off to Conrad", () => {
    expect(prompt).toContain("never say you have handed anything off to Conrad");
  });

  it("contains the wake word gating rule", () => {
    expect(prompt).toContain("Respond only when the user addresses you as Conrad");
  });

  it("contains the wake word continuation clause", () => {
    expect(prompt).toContain("continuing an exchange the user is actively engaged in");
  });

  it("contains the silence rule when not addressed", () => {
    expect(prompt).toContain("output nothing at all");
  });

  it("contains answer containment rule", () => {
    expect(prompt).toContain("ANSWER CONTAINMENT - CRITICAL");
  });

  it("states the gateway does not know work items without tools", () => {
    expect(prompt).toContain("do NOT know anything about work, tasks, issues, or projects unless a tool tells you");
  });

  it("requires tool calls for work questions", () => {
    expect(prompt).toContain("you MUST call dispatch_to_conrad");
  });

  it("forbids answering work questions from own head", () => {
    expect(prompt).toContain("You MUST NOT answer from your own head");
  });

  it("forbids claiming actionable work without create_task", () => {
    expect(prompt).toContain("you MUST call create_task");
  });

  it("limits direct handling to pure chitchat", () => {
    expect(prompt).toContain("You may ONLY handle pure chitchat directly");
  });

  it("contains the lying warning", () => {
    expect(prompt).toContain("you are lying to the user");
  });

  it("routes all substantive replies through tool calls", () => {
    expect(prompt).toContain("you MUST call dispatch_to_conrad");
  });

  it("contains the relay rule for completed runs", () => {
    expect(prompt).toContain("completed background run");
  });

  it("requires exact reading of run outcomes", () => {
    expect(prompt).toContain("read the outcome EXACTLY as provided");
  });

  it("forbids summarizing or rephrasing run outcomes", () => {
    expect(prompt).toContain("Do not summarize, rephrase, or add commentary");
  });

  it("contains voice style: short sentences", () => {
    expect(prompt).toContain("short sentence");
  });

  it("contains voice style: no markdown", () => {
    expect(prompt.toLowerCase()).toContain("no markdown");
  });

  it("contains voice style: max two sentences", () => {
    expect(prompt).toContain("two sentence");
  });

  it("does not contain emdashes", () => {
    expect(prompt).not.toContain("\u2014");
  });

  it("contains TASK CREATION section header", () => {
    expect(prompt).toContain("TASK CREATION:");
  });

  it("makes create_task the default for any actionable work", () => {
    expect(prompt).toContain(
      "always call create_task with a short title and the full request as detail"
    );
  });

  it("contains the existing-task exception", () => {
    expect(prompt).toContain("unless the user refers to a task that already exists in the system");
  });

  it("contains first person task acknowledgment rule", () => {
    expect(prompt).toContain("tell the user the task identifier and that you are on it");
  });

  it("contains rule to not create a task for questions or status updates", () => {
    expect(prompt).toContain(
      "do not create a task. Use dispatch_to_conrad, check_run, or board_snapshot instead"
    );
  });

  it("contains rule against creating more than one task per request", () => {
    expect(prompt).toContain("Never create more than one task per user request");
  });

  it("forbids claiming work is underway without a tool result", () => {
    expect(prompt).toContain(
      "Never tell the user work is underway unless a tool call has returned a result in this turn"
    );
  });
});

// ---------------------------------------------------------------------------
// DISPATCH_TO_CONRAD tool declaration
// ---------------------------------------------------------------------------

describe("DISPATCH_TO_CONRAD tool declaration", () => {
  it("has name dispatch_to_conrad", () => {
    expect(DISPATCH_TO_CONRAD.name).toBe("dispatch_to_conrad");
  });

  it("has a non-empty description", () => {
    expect(typeof DISPATCH_TO_CONRAD.description).toBe("string");
    expect(DISPATCH_TO_CONRAD.description.length).toBeGreaterThan(0);
  });

  it("description mentions background task", () => {
    expect(DISPATCH_TO_CONRAD.description).toContain("background task");
  });

  it("description mentions runId", () => {
    expect(DISPATCH_TO_CONRAD.description).toContain("runId");
  });

  it("description scopes it to questions and existing work", () => {
    expect(DISPATCH_TO_CONRAD.description.toLowerCase()).toContain("existing");
  });

  it("description points new actionable work to create_task", () => {
    expect(DISPATCH_TO_CONRAD.description).toContain("create_task");
  });

  it("description no longer claims it is for any substantive request", () => {
    expect(DISPATCH_TO_CONRAD.description).not.toContain("ANY substantive request");
  });

  it("has a prompt string parameter in JSON schema", () => {
    const props = DISPATCH_TO_CONRAD.parameters.properties as Record<string, { type: string }>;
    expect(props["prompt"]).toBeDefined();
    expect(props["prompt"].type).toBe("string");
  });

  it("requires prompt", () => {
    const required = DISPATCH_TO_CONRAD.parameters.required as string[];
    expect(required).toContain("prompt");
  });
});

// ---------------------------------------------------------------------------
// CREATE_TASK tool declaration description
// ---------------------------------------------------------------------------

describe("CREATE_TASK tool declaration description", () => {
  it("describes create_task as the default for new actionable work", () => {
    expect(CREATE_TASK.description).toContain("default for ANY new actionable work");
  });

  it("does not describe Conrad in the third person", () => {
    expect(CREATE_TASK.description).not.toContain("start Conrad working");
  });
});

// ---------------------------------------------------------------------------
// CHECK_RUN tool declaration
// ---------------------------------------------------------------------------

describe("CHECK_RUN tool declaration", () => {
  it("has name check_run", () => {
    expect(CHECK_RUN.name).toBe("check_run");
  });

  it("has a non-empty description", () => {
    expect(typeof CHECK_RUN.description).toBe("string");
    expect(CHECK_RUN.description.length).toBeGreaterThan(0);
  });

  it("description mentions previously dispatched", () => {
    expect(CHECK_RUN.description.toLowerCase()).toContain("dispatched");
  });

  it("has a runId string parameter", () => {
    const props = CHECK_RUN.parameters.properties as Record<string, { type: string }>;
    expect(props["runId"]).toBeDefined();
    expect(props["runId"].type).toBe("string");
  });

  it("requires runId", () => {
    const required = CHECK_RUN.parameters.required as string[];
    expect(required).toContain("runId");
  });
});

// ---------------------------------------------------------------------------
// BOARD_SNAPSHOT tool declaration
// ---------------------------------------------------------------------------

describe("BOARD_SNAPSHOT tool declaration", () => {
  it("has name board_snapshot", () => {
    expect(BOARD_SNAPSHOT.name).toBe("board_snapshot");
  });

  it("has a non-empty description", () => {
    expect(typeof BOARD_SNAPSHOT.description).toBe("string");
    expect(BOARD_SNAPSHOT.description.length).toBeGreaterThan(0);
  });

  it("description mentions read-only", () => {
    expect(BOARD_SNAPSHOT.description.toLowerCase()).toContain("read-only");
  });

  it("description mentions board", () => {
    expect(BOARD_SNAPSHOT.description.toLowerCase()).toContain("board");
  });

  it("has object type parameters (no required params)", () => {
    expect(BOARD_SNAPSHOT.parameters.type).toBe("object");
  });
});
