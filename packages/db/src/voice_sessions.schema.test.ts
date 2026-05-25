import { describe, it, expect } from "vitest";
import { voiceSessions, type VoiceTranscriptTurn } from "./schema/voice_sessions.js";

describe("voiceSessions schema", () => {
  it("exposes the expected columns", () => {
    const cols = Object.keys(voiceSessions);
    expect(cols).toEqual(
      expect.arrayContaining([
        "id",
        "companyId",
        "userId",
        "startedAt",
        "endedAt",
        "transcript",
      ]),
    );
  });

  it("VoiceTranscriptTurn supports user / assistant / tool roles", () => {
    const turns: VoiceTranscriptTurn[] = [
      { role: "user", text: "hi", ts: new Date().toISOString() },
      { role: "assistant", text: "hi back", ts: new Date().toISOString() },
      { role: "tool", text: "ok", ts: new Date().toISOString(), toolName: "create_issue" },
    ];
    expect(turns).toHaveLength(3);
  });
});
