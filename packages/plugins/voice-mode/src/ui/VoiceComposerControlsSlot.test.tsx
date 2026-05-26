// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react";
import React from "react";

// Capture the latest onTranscript callback handed to the mocked
// VoiceComposerControls so each test can invoke it directly.
let capturedOnTranscript: ((text: string) => void) | null = null;

vi.mock("./VoiceComposerControls", () => ({
  VoiceComposerControls: (props: { onTranscript: (text: string) => void }) => {
    capturedOnTranscript = props.onTranscript;
    return <div data-testid="voice-composer-controls-mock" />;
  },
}));

// Mutable state for the mocked hook so each test can flip `enabled`.
const voiceModeState = { enabled: true };
vi.mock("./useVoiceMode", () => ({
  useVoiceMode: () => ({
    enabled: voiceModeState.enabled,
    toggle: vi.fn(),
    isRecording: false,
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    isSpeaking: false,
    playAudio: vi.fn(),
    stopSpeaking: vi.fn(),
  }),
}));

// usePluginAction / usePluginData are pulled in by index.tsx via the SDK; stub
// them out so the import graph resolves cleanly in jsdom.
vi.mock("@paperclipai/plugin-sdk/ui", () => ({
  usePluginAction: () => vi.fn(),
  usePluginData: () => ({ data: null, loading: false, error: null }),
}));

import { VoiceComposerControlsSlot } from "./index";

describe("VoiceComposerControlsSlot — auto-send echo", () => {
  let dispatchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    capturedOnTranscript = null;
    dispatchSpy = vi.spyOn(window, "dispatchEvent");
  });

  afterEach(() => {
    dispatchSpy.mockRestore();
    vi.useRealTimers();
  });

  function getEvents() {
    return dispatchSpy.mock.calls.map((c) => c[0] as CustomEvent);
  }

  it("auto-send mode: fires transcript-insert immediately, then auto-send after 300ms", () => {
    voiceModeState.enabled = true;
    render(<VoiceComposerControlsSlot context={{} as any} />);
    expect(capturedOnTranscript).toBeTruthy();

    capturedOnTranscript!("hello world");

    // transcript-insert fires immediately.
    const eventsAfterCall = getEvents();
    expect(eventsAfterCall).toHaveLength(1);
    expect(eventsAfterCall[0].type).toBe("voice-mode:transcript-insert");
    expect(eventsAfterCall[0].detail).toBe("hello world");

    // auto-send has NOT fired yet.
    expect(
      eventsAfterCall.some((e) => e.type === "voice-mode:auto-send"),
    ).toBe(false);

    // Advance 299ms — still no auto-send.
    vi.advanceTimersByTime(299);
    expect(
      getEvents().some((e) => e.type === "voice-mode:auto-send"),
    ).toBe(false);

    // At 300ms total, auto-send fires with the same text.
    vi.advanceTimersByTime(1);
    const finalEvents = getEvents();
    const autoSend = finalEvents.find(
      (e) => e.type === "voice-mode:auto-send",
    );
    expect(autoSend).toBeDefined();
    expect(autoSend!.detail).toBe("hello world");
  });

  it("voice mode off: only transcript-insert fires; auto-send never fires", () => {
    voiceModeState.enabled = false;
    render(<VoiceComposerControlsSlot context={{} as any} />);
    expect(capturedOnTranscript).toBeTruthy();

    capturedOnTranscript!("hi");

    const events = getEvents();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("voice-mode:transcript-insert");
    expect(events[0].detail).toBe("hi");

    // Even after 1000ms, no auto-send.
    vi.advanceTimersByTime(1000);
    expect(
      getEvents().some((e) => e.type === "voice-mode:auto-send"),
    ).toBe(false);
  });
});
