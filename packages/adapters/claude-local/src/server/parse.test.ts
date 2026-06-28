import { describe, expect, it } from "vitest";
import { isClaudeOverloadedError, isClaudeUnknownSessionError } from "./parse.js";

// Real failing result shape captured from FRE-1495 run history (FRE-1521):
// a 529 surfaces as is_error:true / subtype:"success" / num_turns:1.
const overloaded529 = {
  type: "result",
  subtype: "success",
  is_error: true,
  num_turns: 1,
  result:
    'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011CcCARH6qwG81RSEewuLgE"}',
};

describe("isClaudeOverloadedError", () => {
  it("detects the Anthropic 529 overloaded_error result that killed FRE-1495 wakes", () => {
    expect(isClaudeOverloadedError(overloaded529)).toBe(true);
  });

  it("detects a plain 503 service unavailable", () => {
    expect(
      isClaudeOverloadedError({
        is_error: true,
        result: "API Error: 503 Service Unavailable",
      }),
    ).toBe(true);
  });

  it("detects a 500 internal server error", () => {
    expect(
      isClaudeOverloadedError({
        is_error: true,
        result: "API Error: 500 internal_server_error",
      }),
    ).toBe(true);
  });

  it("does not treat a successful run as overloaded", () => {
    expect(
      isClaudeOverloadedError({
        is_error: false,
        subtype: "success",
        result: "Comment posted. Here's the rundown.",
      }),
    ).toBe(false);
  });

  it("does not retry a genuine task error that merely mentions the word", () => {
    // is_error:false guards against false positives from normal task output.
    expect(
      isClaudeOverloadedError({
        is_error: false,
        result: "The server was overloaded last week per the incident report.",
      }),
    ).toBe(false);
  });

  it("does not treat a max-turns error as overloaded", () => {
    expect(
      isClaudeOverloadedError({
        is_error: true,
        subtype: "error_max_turns",
        result: "Reached maximum turns",
      }),
    ).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(isClaudeOverloadedError(null)).toBe(false);
    expect(isClaudeOverloadedError(undefined)).toBe(false);
  });

  it("does not misclassify an overloaded error as an unknown-session error", () => {
    expect(isClaudeUnknownSessionError(overloaded529)).toBe(false);
  });
});
