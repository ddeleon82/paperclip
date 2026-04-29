// @vitest-environment jsdom
/**
 * VoiceSettingsPanel — basic render tests.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { VoiceSettingsPanel } from "./VoiceSettingsPanel";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGetAgentVoices = vi.fn().mockResolvedValue({});
const mockSetAgentVoice = vi.fn().mockResolvedValue({ ok: true });

vi.mock("@paperclipai/plugin-sdk/ui", () => ({
  usePluginAction: (key: string) => {
    if (key === "voice.agentVoices.get") return mockGetAgentVoices;
    if (key === "voice.agentVoices.set") return mockSetAgentVoice;
    return vi.fn().mockResolvedValue({});
  },
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
// Shared props
// ---------------------------------------------------------------------------

const defaultProps = {
  context: {
    companyId: null,
    companyPrefix: null,
    projectId: null,
    entityId: null,
    entityType: null,
    userId: null,
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("VoiceSettingsPanel", () => {
  it("renders the settings heading", async () => {
    render(<VoiceSettingsPanel {...defaultProps} />);
    expect(screen.getByText(/Voice Mode Settings/i)).toBeInTheDocument();
  });

  it("renders the JSON textarea for bulk assignment", async () => {
    render(<VoiceSettingsPanel {...defaultProps} />);
    expect(
      screen.getByRole("textbox", { name: /Agent voice JSON mapping/i }),
    ).toBeInTheDocument();
  });

  it("renders the Apply button", async () => {
    render(<VoiceSettingsPanel {...defaultProps} />);
    expect(screen.getByRole("button", { name: /apply/i })).toBeInTheDocument();
  });

  it("calls voice.agentVoices.get on mount", async () => {
    render(<VoiceSettingsPanel {...defaultProps} />);
    await waitFor(() => {
      expect(mockGetAgentVoices).toHaveBeenCalled();
    });
  });

  it("renders voice catalog entries", async () => {
    render(<VoiceSettingsPanel {...defaultProps} />);
    // Multiple elements may contain "Kenn Akomea" (subtitle + catalog list)
    const kennItems = screen.getAllByText(/Kenn Akomea/i);
    expect(kennItems.length).toBeGreaterThan(0);
    expect(screen.getByText(/Rachel/i)).toBeInTheDocument();
  });

  it("renders per-agent selects when the KV map has entries", async () => {
    mockGetAgentVoices.mockResolvedValueOnce({
      "agent-123": "VjSFSNiy9sK85Z9QRu3d",
    });
    render(<VoiceSettingsPanel {...defaultProps} />);
    await waitFor(() => {
      // May appear in both the label and the textarea JSON — use getAllByText
      const matches = screen.getAllByText(/agent-123/i);
      expect(matches.length).toBeGreaterThan(0);
    });
  });
});
