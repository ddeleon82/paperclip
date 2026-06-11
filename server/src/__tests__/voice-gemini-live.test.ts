/**
 * Pure-function tests for mapServerMessage (FRE-1296).
 * No network I/O - all inputs are literal SDK message shapes.
 */

import { describe, expect, it } from "vitest";
import { mapServerMessage } from "../services/voice-gateway/gemini-live.js";
import type { LiveServerMessage } from "@google/genai";

// ---------------------------------------------------------------------------
// Helpers to build minimal SDK message shapes
// ---------------------------------------------------------------------------

function makeMsg(overrides: Partial<LiveServerMessage> = {}): LiveServerMessage {
  return overrides as unknown as LiveServerMessage;
}

// ---------------------------------------------------------------------------
// textDelta
// ---------------------------------------------------------------------------

describe("mapServerMessage - textDelta", () => {
  it("extracts text delta from modelTurn part", () => {
    const raw = makeMsg({
      serverContent: {
        modelTurn: {
          parts: [{ text: "Hello there" }],
        },
      } as LiveServerMessage["serverContent"],
    });
    const evt = mapServerMessage(raw);
    expect(evt.textDelta).toBe("Hello there");
  });

  it("concatenates multiple text parts", () => {
    const raw = makeMsg({
      serverContent: {
        modelTurn: {
          parts: [{ text: "Foo" }, { text: " bar" }],
        },
      } as LiveServerMessage["serverContent"],
    });
    const evt = mapServerMessage(raw);
    expect(evt.textDelta).toBe("Foo bar");
  });

  it("returns undefined textDelta when no parts", () => {
    const raw = makeMsg({ serverContent: { modelTurn: {} } as LiveServerMessage["serverContent"] });
    const evt = mapServerMessage(raw);
    expect(evt.textDelta).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// audioDelta
// ---------------------------------------------------------------------------

describe("mapServerMessage - audioDelta", () => {
  it("decodes base64 inline data from a part", () => {
    const bytes = Buffer.from([1, 2, 3, 4]);
    const b64 = bytes.toString("base64");
    const raw = makeMsg({
      serverContent: {
        modelTurn: {
          parts: [{ inlineData: { mimeType: "audio/pcm", data: b64 } }],
        },
      } as LiveServerMessage["serverContent"],
    });
    const evt = mapServerMessage(raw);
    expect(evt.audioDelta).toBeInstanceOf(Uint8Array);
    expect(evt.audioDelta).toEqual(new Uint8Array(bytes));
  });

  it("returns undefined audioDelta when no inline data", () => {
    const raw = makeMsg({
      serverContent: {
        modelTurn: { parts: [{ text: "hi" }] },
      } as LiveServerMessage["serverContent"],
    });
    const evt = mapServerMessage(raw);
    expect(evt.audioDelta).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// userTranscript
// ---------------------------------------------------------------------------

describe("mapServerMessage - userTranscript", () => {
  it("maps inputTranscription to userTranscript with final=true when finished", () => {
    const raw = makeMsg({
      serverContent: {
        inputTranscription: { text: "what time is it", finished: true },
      } as LiveServerMessage["serverContent"],
    });
    const evt = mapServerMessage(raw);
    expect(evt.userTranscript).toEqual({ text: "what time is it", final: true });
  });

  it("maps inputTranscription with final=false when finished is false", () => {
    const raw = makeMsg({
      serverContent: {
        inputTranscription: { text: "partial", finished: false },
      } as LiveServerMessage["serverContent"],
    });
    const evt = mapServerMessage(raw);
    expect(evt.userTranscript).toEqual({ text: "partial", final: false });
  });

  it("maps inputTranscription with final=false when finished is undefined", () => {
    const raw = makeMsg({
      serverContent: {
        inputTranscription: { text: "interim" },
      } as LiveServerMessage["serverContent"],
    });
    const evt = mapServerMessage(raw);
    expect(evt.userTranscript).toEqual({ text: "interim", final: false });
  });

  it("returns undefined userTranscript when no inputTranscription", () => {
    const raw = makeMsg({ serverContent: {} as LiveServerMessage["serverContent"] });
    const evt = mapServerMessage(raw);
    expect(evt.userTranscript).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// interrupted
// ---------------------------------------------------------------------------

describe("mapServerMessage - interrupted", () => {
  it("maps serverContent.interrupted=true", () => {
    const raw = makeMsg({
      serverContent: { interrupted: true } as LiveServerMessage["serverContent"],
    });
    const evt = mapServerMessage(raw);
    expect(evt.interrupted).toBe(true);
  });

  it("returns undefined interrupted when false", () => {
    const raw = makeMsg({
      serverContent: { interrupted: false } as LiveServerMessage["serverContent"],
    });
    const evt = mapServerMessage(raw);
    expect(evt.interrupted).toBeUndefined();
  });

  it("returns undefined interrupted when serverContent is absent", () => {
    const raw = makeMsg({});
    const evt = mapServerMessage(raw);
    expect(evt.interrupted).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// turnComplete
// ---------------------------------------------------------------------------

describe("mapServerMessage - turnComplete", () => {
  it("maps serverContent.turnComplete=true", () => {
    const raw = makeMsg({
      serverContent: { turnComplete: true } as LiveServerMessage["serverContent"],
    });
    const evt = mapServerMessage(raw);
    expect(evt.turnComplete).toBe(true);
  });

  it("returns undefined turnComplete when false", () => {
    const raw = makeMsg({
      serverContent: { turnComplete: false } as LiveServerMessage["serverContent"],
    });
    const evt = mapServerMessage(raw);
    expect(evt.turnComplete).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// toolCalls
// ---------------------------------------------------------------------------

describe("mapServerMessage - toolCalls", () => {
  it("maps toolCall.functionCalls to toolCalls array", () => {
    const raw = makeMsg({
      toolCall: {
        functionCalls: [
          { id: "fc-1", name: "dispatch_to_conrad", args: { prompt: "hello" } },
          { id: "fc-2", name: "check_run", args: { runId: "run-abc" } },
        ],
      },
    });
    const evt = mapServerMessage(raw);
    expect(evt.toolCalls).toHaveLength(2);
    expect(evt.toolCalls![0]).toEqual({ id: "fc-1", name: "dispatch_to_conrad", args: { prompt: "hello" } });
    expect(evt.toolCalls![1]).toEqual({ id: "fc-2", name: "check_run", args: { runId: "run-abc" } });
  });

  it("returns undefined toolCalls when no toolCall", () => {
    const raw = makeMsg({});
    const evt = mapServerMessage(raw);
    expect(evt.toolCalls).toBeUndefined();
  });

  it("returns undefined toolCalls when functionCalls is empty array", () => {
    const raw = makeMsg({ toolCall: { functionCalls: [] } });
    const evt = mapServerMessage(raw);
    expect(evt.toolCalls).toBeUndefined();
  });

  it("handles missing id and name gracefully, defaulting to empty string", () => {
    const raw = makeMsg({
      toolCall: {
        functionCalls: [{ args: { x: 1 } }],
      },
    });
    const evt = mapServerMessage(raw);
    expect(evt.toolCalls).toHaveLength(1);
    expect(evt.toolCalls![0].id).toBe("");
    expect(evt.toolCalls![0].name).toBe("");
    expect(evt.toolCalls![0].args).toEqual({ x: 1 });
  });
});

// ---------------------------------------------------------------------------
// empty message returns empty event
// ---------------------------------------------------------------------------

describe("mapServerMessage - empty message", () => {
  it("returns an empty event object for an empty message", () => {
    const raw = makeMsg({});
    const evt = mapServerMessage(raw);
    expect(evt.textDelta).toBeUndefined();
    expect(evt.audioDelta).toBeUndefined();
    expect(evt.userTranscript).toBeUndefined();
    expect(evt.interrupted).toBeUndefined();
    expect(evt.turnComplete).toBeUndefined();
    expect(evt.toolCalls).toBeUndefined();
  });
});
