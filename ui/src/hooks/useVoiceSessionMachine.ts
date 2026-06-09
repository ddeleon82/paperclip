import { useReducer } from "react";

export type MutablePhase = "idle" | "listening" | "thinking" | "speaking";

export type VoiceMachineState =
  | { phase: "idle" }
  | { phase: "listening" }
  | { phase: "thinking"; turnId: string }
  | { phase: "speaking"; turnId: string }
  | { phase: "muted"; prevPhase: MutablePhase }
  | { phase: "error"; message: string };

export type VoiceMachineEvent =
  | { type: "START" }
  | { type: "STOP" }
  | { type: "MUTE" }
  | { type: "UNMUTE" }
  | { type: "USER_SPEECH_END"; turnId: string }
  | { type: "SERVER_THINKING_DONE"; turnId: string }
  | { type: "TTS_END"; turnId: string }
  | { type: "BARGE_IN" }
  | { type: "ERROR"; message: string }
  | { type: "RECOVER" };

export const initialVoiceMachineState: VoiceMachineState = { phase: "idle" };

/**
 * Pure reducer for the /voice page session lifecycle.
 *
 * Unknown / disallowed transitions return the state unchanged, including
 * stale turnId events arriving after a barge-in.
 */
export function reducer(
  state: VoiceMachineState,
  event: VoiceMachineEvent,
): VoiceMachineState {
  // Errors absorb everything except RECOVER.
  if (state.phase === "error") {
    if (event.type === "RECOVER") return { phase: "idle" };
    return state;
  }

  switch (event.type) {
    case "START": {
      if (state.phase === "idle") return { phase: "listening" };
      return state;
    }
    case "STOP": {
      // STOP from any non-error state returns to idle.
      return { phase: "idle" };
    }
    case "MUTE": {
      if (state.phase === "muted") return state;
      // Cap prevPhase to known mutable phases.
      const prev: MutablePhase =
        state.phase === "idle" ||
        state.phase === "listening" ||
        state.phase === "thinking" ||
        state.phase === "speaking"
          ? state.phase
          : "idle";
      return { phase: "muted", prevPhase: prev };
    }
    case "UNMUTE": {
      if (state.phase !== "muted") return state;
      // For simplicity always resume to listening (per plan).
      if (state.prevPhase === "idle") return { phase: "idle" };
      return { phase: "listening" };
    }
    case "USER_SPEECH_END": {
      if (state.phase === "listening") {
        return { phase: "thinking", turnId: event.turnId };
      }
      return state;
    }
    case "SERVER_THINKING_DONE": {
      if (state.phase === "thinking" && state.turnId === event.turnId) {
        return { phase: "speaking", turnId: state.turnId };
      }
      // Stale or unexpected: ignore.
      return state;
    }
    case "TTS_END": {
      if (state.phase === "speaking" && state.turnId === event.turnId) {
        return { phase: "listening" };
      }
      return state;
    }
    case "BARGE_IN": {
      // From "speaking": user interrupted playback. From "thinking": the turn
      // was abandoned client-side (e.g. the server deduped the wakeup), so
      // return to listening instead of waiting forever - BARGE_IN as a no-op
      // here left the machine stuck in "thinking" (FRE-1296).
      if (state.phase === "speaking" || state.phase === "thinking") {
        return { phase: "listening" };
      }
      return state;
    }
    case "ERROR": {
      return { phase: "error", message: event.message };
    }
    case "RECOVER": {
      // RECOVER outside of error: no-op.
      return state;
    }
    default: {
      // Exhaustiveness check.
      const _exhaustive: never = event;
      void _exhaustive;
      return state;
    }
  }
}

export function useVoiceSessionMachine(): {
  state: VoiceMachineState;
  dispatch: (event: VoiceMachineEvent) => void;
} {
  const [state, dispatch] = useReducer(reducer, initialVoiceMachineState);
  return { state, dispatch };
}
