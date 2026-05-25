import { describe, expect, it } from "vitest";
import {
  initialVoiceMachineState,
  reducer,
  type VoiceMachineState,
} from "./useVoiceSessionMachine";

describe("voice session reducer", () => {
  it("starts in idle", () => {
    expect(initialVoiceMachineState).toEqual({ phase: "idle" });
  });

  it("idle + START -> listening", () => {
    const next = reducer({ phase: "idle" }, { type: "START" });
    expect(next).toEqual({ phase: "listening" });
  });

  it("listening + USER_SPEECH_END -> thinking with turnId", () => {
    const next = reducer(
      { phase: "listening" },
      { type: "USER_SPEECH_END", turnId: "t1" },
    );
    expect(next).toEqual({ phase: "thinking", turnId: "t1" });
  });

  it("listening + STOP -> idle", () => {
    const next = reducer({ phase: "listening" }, { type: "STOP" });
    expect(next).toEqual({ phase: "idle" });
  });

  it("listening + MUTE -> muted (prev=listening)", () => {
    const next = reducer({ phase: "listening" }, { type: "MUTE" });
    expect(next).toEqual({ phase: "muted", prevPhase: "listening" });
  });

  it("thinking + SERVER_THINKING_DONE (matching turnId) -> speaking", () => {
    const next = reducer(
      { phase: "thinking", turnId: "t1" },
      { type: "SERVER_THINKING_DONE", turnId: "t1" },
    );
    expect(next).toEqual({ phase: "speaking", turnId: "t1" });
  });

  it("thinking + ERROR -> error", () => {
    const next = reducer(
      { phase: "thinking", turnId: "t1" },
      { type: "ERROR", message: "explode" },
    );
    expect(next).toEqual({ phase: "error", message: "explode" });
  });

  it("speaking + TTS_END (matching turnId) -> listening", () => {
    const next = reducer(
      { phase: "speaking", turnId: "t1" },
      { type: "TTS_END", turnId: "t1" },
    );
    expect(next).toEqual({ phase: "listening" });
  });

  it("speaking + BARGE_IN -> listening", () => {
    const next = reducer(
      { phase: "speaking", turnId: "t1" },
      { type: "BARGE_IN" },
    );
    expect(next).toEqual({ phase: "listening" });
  });

  it("speaking + ERROR -> error", () => {
    const next = reducer(
      { phase: "speaking", turnId: "t1" },
      { type: "ERROR", message: "tts blew up" },
    );
    expect(next).toEqual({ phase: "error", message: "tts blew up" });
  });

  it("MUTE captures prev across phases (idle, listening, thinking, speaking)", () => {
    expect(reducer({ phase: "idle" }, { type: "MUTE" })).toEqual({
      phase: "muted",
      prevPhase: "idle",
    });
    expect(reducer({ phase: "listening" }, { type: "MUTE" })).toEqual({
      phase: "muted",
      prevPhase: "listening",
    });
    expect(
      reducer({ phase: "thinking", turnId: "t1" }, { type: "MUTE" }),
    ).toEqual({ phase: "muted", prevPhase: "thinking" });
    expect(
      reducer({ phase: "speaking", turnId: "t1" }, { type: "MUTE" }),
    ).toEqual({ phase: "muted", prevPhase: "speaking" });
  });

  it("muted + UNMUTE -> listening when prev != idle", () => {
    expect(
      reducer({ phase: "muted", prevPhase: "thinking" }, { type: "UNMUTE" }),
    ).toEqual({ phase: "listening" });
    expect(
      reducer({ phase: "muted", prevPhase: "speaking" }, { type: "UNMUTE" }),
    ).toEqual({ phase: "listening" });
    expect(
      reducer({ phase: "muted", prevPhase: "listening" }, { type: "UNMUTE" }),
    ).toEqual({ phase: "listening" });
  });

  it("muted + UNMUTE -> idle when prev=idle", () => {
    expect(
      reducer({ phase: "muted", prevPhase: "idle" }, { type: "UNMUTE" }),
    ).toEqual({ phase: "idle" });
  });

  it("error + RECOVER -> idle", () => {
    expect(
      reducer({ phase: "error", message: "x" }, { type: "RECOVER" }),
    ).toEqual({ phase: "idle" });
  });

  it("error absorbs other events (no throw, state unchanged)", () => {
    const state: VoiceMachineState = { phase: "error", message: "boom" };
    expect(reducer(state, { type: "START" })).toBe(state);
    expect(reducer(state, { type: "MUTE" })).toBe(state);
    expect(reducer(state, { type: "STOP" })).toBe(state);
    expect(
      reducer(state, { type: "USER_SPEECH_END", turnId: "t" }),
    ).toBe(state);
  });

  describe("stale turnId guards", () => {
    it("ignores SERVER_THINKING_DONE with mismatched turnId", () => {
      const state: VoiceMachineState = { phase: "thinking", turnId: "current" };
      const next = reducer(state, {
        type: "SERVER_THINKING_DONE",
        turnId: "stale",
      });
      expect(next).toBe(state);
    });

    it("ignores TTS_END with mismatched turnId (post barge-in scenario)", () => {
      // User barged in: we are listening again after TTS started for t1.
      // A stale TTS_END for t1 should NOT bounce us anywhere.
      const state: VoiceMachineState = { phase: "listening" };
      const next = reducer(state, { type: "TTS_END", turnId: "t1" });
      expect(next).toBe(state);
    });

    it("ignores TTS_END targeting a different active turn", () => {
      const state: VoiceMachineState = { phase: "speaking", turnId: "t2" };
      const next = reducer(state, { type: "TTS_END", turnId: "t1" });
      expect(next).toBe(state);
    });
  });

  describe("MUTE/UNMUTE cycle preserves prev correctly", () => {
    it("listening -> mute -> unmute -> listening", () => {
      let state: VoiceMachineState = { phase: "listening" };
      state = reducer(state, { type: "MUTE" });
      expect(state).toEqual({ phase: "muted", prevPhase: "listening" });
      state = reducer(state, { type: "UNMUTE" });
      expect(state).toEqual({ phase: "listening" });
    });

    it("speaking -> mute -> unmute -> listening (resumes safely)", () => {
      let state: VoiceMachineState = { phase: "speaking", turnId: "t1" };
      state = reducer(state, { type: "MUTE" });
      expect(state).toEqual({ phase: "muted", prevPhase: "speaking" });
      state = reducer(state, { type: "UNMUTE" });
      expect(state).toEqual({ phase: "listening" });
    });

    it("MUTE while already muted is a no-op", () => {
      const state: VoiceMachineState = { phase: "muted", prevPhase: "listening" };
      const next = reducer(state, { type: "MUTE" });
      expect(next).toBe(state);
    });

    it("UNMUTE while not muted is a no-op", () => {
      const state: VoiceMachineState = { phase: "listening" };
      const next = reducer(state, { type: "UNMUTE" });
      expect(next).toBe(state);
    });
  });

  it("USER_SPEECH_END outside of listening is ignored", () => {
    const state: VoiceMachineState = { phase: "idle" };
    expect(
      reducer(state, { type: "USER_SPEECH_END", turnId: "t1" }),
    ).toBe(state);
  });

  it("START outside of idle is ignored", () => {
    const state: VoiceMachineState = { phase: "listening" };
    expect(reducer(state, { type: "START" })).toBe(state);
  });
});
