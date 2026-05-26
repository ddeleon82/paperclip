// @vitest-environment jsdom
/**
 * Tests for useVoiceComposerAutoPlay (FRE-968 Task 19).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { useVoiceComposerAutoPlay } from "./useVoiceComposerAutoPlay";

const playMock = vi.fn(async () => {});
const stopMock = vi.fn();

vi.mock("./useStreamingTts", () => ({
  useStreamingTts: () => ({
    play: playMock,
    stop: stopMock,
    isPlaying: false,
  }),
}));

const listCommentsMock = vi.fn();
vi.mock("@/api/issues", () => ({
  issuesApi: {
    listComments: (...args: unknown[]) => listCommentsMock(...args),
  },
}));

const bridgePerformActionMock = vi.fn();
vi.mock("@/api/plugins", () => ({
  pluginsApi: {
    bridgePerformAction: (...args: unknown[]) => bridgePerformActionMock(...args),
  },
}));

function Harness({ issueId, companyId }: { issueId: string | null; companyId: string | null }) {
  useVoiceComposerAutoPlay({ issueId, companyId });
  return null;
}

const FAKE_AUDIO_B64 = "AAAA"; // 3 zero bytes, decodes via atob fine.

describe("useVoiceComposerAutoPlay", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    playMock.mockClear();
    stopMock.mockClear();
    listCommentsMock.mockReset();
    bridgePerformActionMock.mockReset();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("plays the agent reply when a voice run succeeds for the mounted issue", async () => {
    listCommentsMock.mockResolvedValue([
      { authorAgentId: "agent-1", authorUserId: null, body: "Reply from agent" },
    ]);
    bridgePerformActionMock.mockResolvedValue({
      data: { audioBase64: FAKE_AUDIO_B64, mime: "audio/mpeg" },
    });

    act(() => {
      root.render(<Harness issueId="issue-1" companyId="company-1" />);
    });

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("voice-mode:run-succeeded", {
          detail: { runId: "run-1", issueId: "issue-1", agentId: "agent-1" },
        }),
      );
      // Let the async chain settle.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(listCommentsMock).toHaveBeenCalledWith("issue-1", { order: "desc", limit: 5 });
    expect(bridgePerformActionMock).toHaveBeenCalledWith(
      "voice-mode",
      "voice.speak",
      { text: "Reply from agent", voiceId: "VjSFSNiy9sK85Z9QRu3d" },
      "company-1",
    );
    expect(playMock).toHaveBeenCalledTimes(1);
  });

  it("ignores events for a different issue", async () => {
    act(() => {
      root.render(<Harness issueId="issue-1" companyId="company-1" />);
    });

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("voice-mode:run-succeeded", {
          detail: { runId: "run-1", issueId: "issue-OTHER", agentId: "agent-1" },
        }),
      );
      await Promise.resolve();
    });

    expect(listCommentsMock).not.toHaveBeenCalled();
    expect(playMock).not.toHaveBeenCalled();
  });

  it("no-ops when no matching agent comment is found", async () => {
    listCommentsMock.mockResolvedValue([
      { authorAgentId: "DIFFERENT-AGENT", authorUserId: null, body: "Reply" },
    ]);

    act(() => {
      root.render(<Harness issueId="issue-1" companyId="company-1" />);
    });

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("voice-mode:run-succeeded", {
          detail: { runId: "run-1", issueId: "issue-1", agentId: "agent-1" },
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(listCommentsMock).toHaveBeenCalled();
    expect(bridgePerformActionMock).not.toHaveBeenCalled();
    expect(playMock).not.toHaveBeenCalled();
  });

  it("does not subscribe when issueId is null", async () => {
    act(() => {
      root.render(<Harness issueId={null} companyId="company-1" />);
    });

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("voice-mode:run-succeeded", {
          detail: { runId: "run-1", issueId: "issue-1", agentId: "agent-1" },
        }),
      );
      await Promise.resolve();
    });

    expect(listCommentsMock).not.toHaveBeenCalled();
  });
});
