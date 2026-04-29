// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { VoiceComposerControls } from "./VoiceComposerControls";

// Mock useVoiceMode and the api module
vi.mock("./useVoiceMode", () => ({
  useVoiceMode: () => ({
    enabled: false,
    toggle: vi.fn(),
    isRecording: false,
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    isSpeaking: false,
    playAudio: vi.fn(),
    stopSpeaking: vi.fn(),
  }),
}));

vi.mock("./api", () => ({
  useVoiceActions: () => ({
    transcribeAudio: vi.fn(),
    speakText: vi.fn(),
  }),
}));

describe("VoiceComposerControls", () => {
  it("renders mic + voice-mode toggle buttons", () => {
    render(<VoiceComposerControls onTranscript={vi.fn()} />);
    expect(screen.getByLabelText(/voice mode/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/record|mic/i)).toBeInTheDocument();
  });

  it("mic is disabled when voice mode is off", () => {
    render(<VoiceComposerControls onTranscript={vi.fn()} />);
    const mic = screen.getByLabelText(/record|mic/i);
    expect(mic).toBeDisabled();
  });
});
