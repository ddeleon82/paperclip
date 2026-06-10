import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  normalizePaperclipWakePayload,
  renderPaperclipWakePrompt,
  runChildProcess,
  stringifyPaperclipWakePayload,
} from "./server-utils.js";

describe("paperclip wake payload voice turns", () => {
  const voicePayload = {
    reason: "voice_turn",
    voiceTurn: {
      transcript: "Testing, checking to see if this is working.",
      instructions: "Reply in short spoken sentences. No markdown.",
    },
  };

  it("still returns null for a payload with no comments, stage, issue, or voice turn", () => {
    expect(normalizePaperclipWakePayload({ reason: "voice_turn" })).toBeNull();
  });

  it("normalizes a voice-turn-only payload instead of dropping it", () => {
    const normalized = normalizePaperclipWakePayload(voicePayload);
    expect(normalized).not.toBeNull();
    expect(normalized?.voiceTurn).toEqual({
      transcript: "Testing, checking to see if this is working.",
      instructions: "Reply in short spoken sentences. No markdown.",
    });
    expect(normalized?.reason).toBe("voice_turn");
  });

  it("treats a blank transcript as no voice turn", () => {
    expect(
      normalizePaperclipWakePayload({ reason: "voice_turn", voiceTurn: { transcript: "   " } }),
    ).toBeNull();
  });

  it("renders the transcript and voice instructions on a fresh session", () => {
    const prompt = renderPaperclipWakePrompt(voicePayload);
    expect(prompt).toContain("Testing, checking to see if this is working.");
    expect(prompt).toContain("Reply in short spoken sentences. No markdown.");
    expect(prompt).not.toContain("## Paperclip Wake Payload");
    expect(prompt).not.toContain("issue below");
  });

  it("renders the transcript on a resumed session too", () => {
    const prompt = renderPaperclipWakePrompt(voicePayload, { resumedSession: true });
    expect(prompt).toContain("Testing, checking to see if this is working.");
    expect(prompt).not.toContain("## Paperclip Resume Delta");
  });

  it("round-trips voiceTurn through stringifyPaperclipWakePayload", () => {
    const json = stringifyPaperclipWakePayload(voicePayload);
    expect(json).not.toBeNull();
    const parsed = JSON.parse(json as string);
    expect(parsed.voiceTurn.transcript).toBe("Testing, checking to see if this is working.");
  });
});

describe("runChildProcess", () => {
  it("waits for onSpawn before sending stdin to the child", async () => {
    const spawnDelayMs = 150;
    const startedAt = Date.now();
    let onSpawnCompletedAt = 0;

    const result = await runChildProcess(
      randomUUID(),
      process.execPath,
      [
        "-e",
        "let data='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>data+=chunk);process.stdin.on('end',()=>process.stdout.write(data));",
      ],
      {
        cwd: process.cwd(),
        env: {},
        stdin: "hello from stdin",
        timeoutSec: 5,
        graceSec: 1,
        onLog: async () => {},
        onSpawn: async () => {
          await new Promise((resolve) => setTimeout(resolve, spawnDelayMs));
          onSpawnCompletedAt = Date.now();
        },
      },
    );
    const finishedAt = Date.now();

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello from stdin");
    expect(onSpawnCompletedAt).toBeGreaterThanOrEqual(startedAt + spawnDelayMs);
    expect(finishedAt - startedAt).toBeGreaterThanOrEqual(spawnDelayMs);
  });
});
