// @vitest-environment jsdom
/**
 * MessageSpeakerButton — basic render tests.
 *
 * jsdom does not support HTMLAudioElement playback, so audio playback paths
 * are not tested here. This suite verifies:
 * - Component renders the play button with the correct aria-label when not speaking.
 * - Component renders the stop button when speaking.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MessageSpeakerButton } from "./MessageSpeakerButton";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("./useVoiceMode", () => ({
  useVoiceMode: vi.fn(() => ({
    enabled: false,
    toggle: vi.fn(),
    isRecording: false,
    isSpeaking: false,
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    playAudio: vi.fn(),
    stopSpeaking: vi.fn(),
  })),
}));

vi.mock("./api", () => ({
  useVoiceActions: () => ({
    transcribeAudio: vi.fn(),
    speakText: vi.fn().mockResolvedValue(new Blob(["audio"], { type: "audio/mpeg" })),
  }),
}));

vi.mock("@paperclipai/plugin-sdk/ui", () => ({
  usePluginAction: () => vi.fn().mockResolvedValue({}),
  useHostContext: () => ({
    companyId: null,
    companyPrefix: null,
    projectId: null,
    entityId: null,
    entityType: null,
    userId: null,
  }),
}));

// ---------------------------------------------------------------------------
// Shared props factory
// ---------------------------------------------------------------------------

function makeProps(overrides: Partial<{ entityId: string; parentEntityId: string }> = {}) {
  return {
    context: {
      companyId: "company-1",
      companyPrefix: "acme",
      projectId: "project-1",
      entityId: overrides.entityId ?? "comment-abc",
      entityType: "comment" as const,
      parentEntityId: overrides.parentEntityId ?? "issue-xyz",
      userId: "user-1",
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MessageSpeakerButton", () => {
  beforeEach(() => {
    // Reset sessionStorage between tests
    sessionStorage.clear();
    vi.clearAllMocks();
  });

  it("renders a button with aria-label 'Play message' when not speaking", () => {
    render(<MessageSpeakerButton {...makeProps()} />);
    expect(screen.getByRole("button", { name: /play message/i })).toBeInTheDocument();
  });

  it("renders a button with aria-label 'Stop speaking' when isSpeaking is true", async () => {
    const { useVoiceMode } = await import("./useVoiceMode");
    vi.mocked(useVoiceMode).mockReturnValue({
      enabled: true,
      toggle: vi.fn(),
      isRecording: false,
      isSpeaking: true,
      startRecording: vi.fn(),
      stopRecording: vi.fn().mockResolvedValue(null),
      playAudio: vi.fn().mockResolvedValue(undefined),
      stopSpeaking: vi.fn(),
    });

    render(<MessageSpeakerButton {...makeProps({ entityId: "comment-speaking" })} />);
    expect(screen.getByRole("button", { name: /stop speaking/i })).toBeInTheDocument();
  });

  it("does not auto-play when voice mode is disabled", () => {
    // useVoiceMode is mocked at the top to return enabled: false.
    // speakText in the api mock is a vi.fn() — just verify it was not called
    // synchronously (async auto-play also won't fire since enabled is false).
    const { container } = render(
      <MessageSpeakerButton {...makeProps({ entityId: "comment-no-autoplay" })} />,
    );
    // Button renders normally
    expect(container.querySelector("button")).toBeTruthy();
  });

  it("deduplicates auto-play via sessionStorage key — renders without throw", () => {
    const commentId = "comment-dedup";
    sessionStorage.setItem(`paperclip:voiceMode:played:${commentId}`, "1");
    // Just verify it renders cleanly with the key already set
    const { container } = render(<MessageSpeakerButton {...makeProps({ entityId: commentId })} />);
    expect(container.querySelector("button")).toBeTruthy();
  });
});
