import { describe, expect, it } from "vitest";
import { extractFinalAssistantText } from "../services/voice-gateway/run-outcome.js";

// ---------------------------------------------------------------------------
// Helpers to build fixture log lines
// ---------------------------------------------------------------------------

function stdoutLine(chunk: string): string {
  return JSON.stringify({ stream: "stdout", chunk });
}

function assistantLine(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  });
}

function assistantToolUse(): string {
  return JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "tu_1", name: "TodoWrite", input: {} }] },
  });
}

function resultLine(result: string, subtype = "success"): string {
  return JSON.stringify({ type: "result", subtype, result });
}

function stderrLine(chunk: string): string {
  return JSON.stringify({ stream: "stderr", chunk });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("extractFinalAssistantText", () => {
  it("returns null on empty log content", () => {
    expect(extractFinalAssistantText("")).toBeNull();
    expect(extractFinalAssistantText("\n\n")).toBeNull();
  });

  it("returns the last assistant text from a multi-line log", () => {
    const log = [
      stdoutLine(assistantLine("First reply.")),
      stdoutLine(assistantLine("Second reply.")),
    ].join("\n");

    const result = extractFinalAssistantText(log);
    expect(result).toBe("Second reply.");
  });

  it("skips tool_use content blocks and finds the last text block", () => {
    const log = [
      stdoutLine(assistantLine("Here is the answer.")),
      stdoutLine(assistantToolUse()),
      stdoutLine(assistantLine("Final text reply.")),
      stdoutLine(assistantToolUse()),
    ].join("\n");

    // Last text is "Final text reply." (tool_use-only blocks are skipped)
    const result = extractFinalAssistantText(log);
    expect(result).toBe("Final text reply.");
  });

  it("does NOT return the result envelope text (regression: c904ad24)", () => {
    // The result envelope should never be spoken aloud. Only the last
    // assistant text block counts.
    const log = [
      stdoutLine(assistantLine("Done with the task.")),
      stdoutLine(resultLine("This is the result envelope that must not be spoken.")),
    ].join("\n");

    const result = extractFinalAssistantText(log);
    expect(result).toBe("Done with the task.");
  });

  it("returns null when log has only tool_use assistant blocks (no spoken text)", () => {
    const log = [
      stdoutLine(assistantToolUse()),
      stdoutLine(assistantToolUse()),
    ].join("\n");

    expect(extractFinalAssistantText(log)).toBeNull();
  });

  it("returns null when log has only a result line and no assistant text", () => {
    const log = stdoutLine(resultLine("Only result, no assistant text."));
    expect(extractFinalAssistantText(log)).toBeNull();
  });

  it("strips markdown for speech", () => {
    const log = stdoutLine(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "**FRE-123** is done. See `output.txt`." }] },
      }),
    );
    const result = extractFinalAssistantText(log);
    // Bold stripped, backtick code stripped
    expect(result).toBe("FRE-123 is done. See output.txt.");
  });

  it("ignores stderr lines", () => {
    const log = [
      stdoutLine(assistantLine("The actual answer.")),
      stderrLine("some error output"),
    ].join("\n");

    expect(extractFinalAssistantText(log)).toBe("The actual answer.");
  });

  it("handles a multi-subline stdout chunk (multiple stream-json events in one chunk)", () => {
    const multiChunk = [assistantToolUse(), assistantLine("Multi-chunk answer.")].join("\n");
    const log = stdoutLine(multiChunk);
    expect(extractFinalAssistantText(log)).toBe("Multi-chunk answer.");
  });

  it("handles non-JSON lines gracefully", () => {
    const log = [
      "some plain text non-json line",
      stdoutLine(assistantLine("Valid reply.")),
      "another bad line {{",
    ].join("\n");
    expect(extractFinalAssistantText(log)).toBe("Valid reply.");
  });

  it("uses redacted fixture structure matching real run logs", () => {
    // Structure from real run logs (redacted):
    const log = [
      JSON.stringify({ stream: "stdout", chunk: JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu_1", name: "TodoWrite", input: {} }] } }) }),
      JSON.stringify({ stream: "stdout", chunk: JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu_1", name: "TodoWrite", input: {} }] } }) }),
      JSON.stringify({ stream: "stdout", chunk: JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Done, anything else?" }] } }) }),
      JSON.stringify({ stream: "stdout", chunk: JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu_1", name: "TodoWrite", input: {} }] } }) }),
      JSON.stringify({ stream: "stdout", chunk: JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu_1", name: "TodoWrite", input: {} }] } }) }),
      JSON.stringify({ stream: "stdout", chunk: JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Done, anything else?" }] } }) }),
      JSON.stringify({ stream: "stdout", chunk: JSON.stringify({ type: "result", subtype: "success", result: "Task completed successfully." }) }),
    ].join("\n");

    // Should return the LAST assistant text, not the result envelope
    expect(extractFinalAssistantText(log)).toBe("Done, anything else?");
  });
});
