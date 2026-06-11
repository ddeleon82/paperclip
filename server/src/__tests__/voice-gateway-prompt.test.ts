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

  it("identifies the gateway as the front desk for Conrad", () => {
    expect(prompt).toContain("front desk for Conrad");
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

  it("contains persona containment rule", () => {
    expect(prompt).toContain("Never answer substantive questions");
  });

  it("contains the dispatch instruction", () => {
    expect(prompt).toContain("call dispatch_to_conrad");
  });

  it("contains the relay rule for completed runs", () => {
    expect(prompt).toContain("completed Conrad run");
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

  it("contains create_task call rule for actionable work", () => {
    expect(prompt).toContain("call create_task with a short title and the full request as detail");
  });

  it("contains task identifier acknowledgment rule", () => {
    expect(prompt).toContain("tell the user the task identifier and that Conrad is on it");
  });

  it("contains rule to not create a task for questions or status updates", () => {
    expect(prompt).toContain(
      "do not create a task. Use dispatch_to_conrad, check_run, or board_snapshot instead"
    );
  });

  it("contains alternatives for non-task requests", () => {
    expect(prompt).toContain("dispatch_to_conrad, check_run, or board_snapshot instead");
  });

  it("contains rule against creating more than one task per request", () => {
    expect(prompt).toContain("Never create more than one task per user request");
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
