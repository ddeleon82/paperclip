// @vitest-environment jsdom

// React 19.2 dropped `act` from the top-level `react` export under production
// builds; pull it from react-dom/test-utils so this harness keeps working
// regardless of NODE_ENV.
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Router mock
// ---------------------------------------------------------------------------
const navigateMock = vi.fn();
vi.mock("@/lib/router", () => ({
  useNavigate: () => navigateMock,
}));

// ---------------------------------------------------------------------------
// Company context
// ---------------------------------------------------------------------------
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "co-1" }),
}));

// ---------------------------------------------------------------------------
// React Query — synthetic agent list: Conrad is first.
// ---------------------------------------------------------------------------
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: [{ id: "agent-1", name: "Conrad" }] }),
}));

vi.mock("@/lib/queryKeys", () => ({
  queryKeys: { agents: { list: (id: string) => ["agents", id] } },
}));

vi.mock("@/api/agents", () => ({
  agentsApi: { list: vi.fn().mockResolvedValue([{ id: "agent-1", name: "Conrad" }]) },
}));

// ---------------------------------------------------------------------------
// useMicPcmStream — noop (we don't test mic capture at this level)
// ---------------------------------------------------------------------------
vi.mock("@/hooks/useMicPcmStream", () => ({
  useMicPcmStream: () => ({ state: "capturing" }),
}));

// ---------------------------------------------------------------------------
// audio-frame-queue — stub sink so no real audio is enqueued
// ---------------------------------------------------------------------------
vi.mock("@/hooks/audio-frame-queue", () => ({
  createAudioFrameSink: () => ({
    onAudioStart: vi.fn(),
    onAudioChunk: vi.fn(),
    onAudioEnd: vi.fn(),
    interrupt: vi.fn(),
    end: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// useVoiceGatewaySocket — expose captured callbacks so tests can simulate
// server messages and audio frames.
// ---------------------------------------------------------------------------
import type { GatewaySocketCallbacks, ServerMessage } from "@/hooks/useVoiceGatewaySocket";

let capturedCallbacks: GatewaySocketCallbacks | null = null;
const sendMock = vi.fn();
const sendAudioMock = vi.fn();

vi.mock("@/hooks/useVoiceGatewaySocket", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/hooks/useVoiceGatewaySocket")>();
  return {
    ...original,
    useVoiceGatewaySocket: (opts: {
      companyId: string;
      agentId: string;
      enabled: boolean;
      callbacks: GatewaySocketCallbacks;
    }) => {
      capturedCallbacks = opts.callbacks;
      return {
        send: sendMock,
        sendAudio: sendAudioMock,
        state: "idle",
      };
    },
  };
});

// ---------------------------------------------------------------------------
// VoicePoweredOrb — stub; jsdom can't run WebGL
// ---------------------------------------------------------------------------
const orbPropsLog: Array<Record<string, unknown>> = [];
vi.mock("@/components/voice/VoicePoweredOrb", () => ({
  VoicePoweredOrb: (props: Record<string, unknown>) => {
    orbPropsLog.push(props);
    return (
      <div
        data-testid="voice-orb"
        data-phase={String(props.phase ?? "")}
      />
    );
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { VoiceMode } from "./VoiceMode";

// ---------------------------------------------------------------------------
// Helper to push a server message through the captured callbacks
// ---------------------------------------------------------------------------
function pushMsg(msg: ServerMessage) {
  capturedCallbacks?.onServerMessage(msg);
}

describe("VoiceMode page (gateway client)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    navigateMock.mockReset();
    sendMock.mockReset();
    sendAudioMock.mockReset();
    orbPropsLog.length = 0;
    capturedCallbacks = null;

    // Stub HTMLAudioElement.play (jsdom doesn't implement media playback)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).HTMLMediaElement.prototype.pause = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).URL.createObjectURL = vi.fn(() => "blob:test");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders orb, scrollback, and controls", async () => {
    await act(async () => { root.render(<VoiceMode />); });
    expect(container.querySelector('[data-testid="voice-orb"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="voice-controls"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="voice-scrollback-empty"]') ??
        container.querySelector('[data-testid="voice-scrollback"]'),
    ).not.toBeNull();
  });

  it("starts in idle/connecting phase with Connecting status", async () => {
    await act(async () => { root.render(<VoiceMode />); });
    const status = container.querySelector<HTMLElement>('[data-testid="voice-mode-status"]');
    expect(status).not.toBeNull();
    expect(status!.dataset.phase).toBe("idle");
    expect(status!.textContent ?? "").toMatch(/connecting/i);
  });

  it("transitions to listening when server sends ready", async () => {
    await act(async () => { root.render(<VoiceMode />); });
    await act(async () => { pushMsg({ type: "ready", sessionId: "sess-1" }); });
    const status = container.querySelector<HTMLElement>('[data-testid="voice-mode-status"]');
    expect(status!.dataset.phase).toBe("listening");
    expect(status!.textContent ?? "").toMatch(/listening/i);
  });

  it("transitions to thinking when server sends status:thinking", async () => {
    await act(async () => { root.render(<VoiceMode />); });
    await act(async () => { pushMsg({ type: "status", state: "thinking" }); });
    const status = container.querySelector<HTMLElement>('[data-testid="voice-mode-status"]');
    expect(status!.dataset.phase).toBe("thinking");
    expect(status!.textContent ?? "").toMatch(/thinking/i);
  });

  it("transitions to speaking when server sends status:speaking", async () => {
    await act(async () => { root.render(<VoiceMode />); });
    await act(async () => { pushMsg({ type: "status", state: "speaking" }); });
    const status = container.querySelector<HTMLElement>('[data-testid="voice-mode-status"]');
    expect(status!.dataset.phase).toBe("speaking");
  });

  it("adds a final transcript turn to the scrollback", async () => {
    await act(async () => { root.render(<VoiceMode />); });
    await act(async () => {
      pushMsg({ type: "transcript", role: "user", text: "Hello Conrad", final: true });
    });
    const scrollback = container.querySelector('[data-testid="voice-scrollback"]');
    expect(scrollback?.textContent ?? "").toContain("Hello Conrad");
  });

  it("does NOT add non-final transcript turns to scrollback", async () => {
    await act(async () => { root.render(<VoiceMode />); });
    await act(async () => {
      pushMsg({ type: "transcript", role: "user", text: "Hello", final: false });
    });
    const scrollback = container.querySelector('[data-testid="voice-scrollback"]');
    // No turns rendered yet; the empty state testid should be present
    expect(
      container.querySelector('[data-testid="voice-scrollback-empty"]'),
    ).not.toBeNull();
    expect(scrollback?.textContent ?? "").not.toContain("Hello");
  });

  it("shows error message and sets error phase on server error", async () => {
    await act(async () => { root.render(<VoiceMode />); });
    await act(async () => {
      pushMsg({ type: "error", message: "something went wrong" });
    });
    const status = container.querySelector<HTMLElement>('[data-testid="voice-mode-status"]');
    expect(status!.dataset.phase).toBe("error");
    const errEl = container.querySelector('[data-testid="voice-mode-error"]');
    expect(errEl?.textContent).toContain("something went wrong");
  });

  it("sends mute/unmute messages on toggle and updates phase", async () => {
    await act(async () => { root.render(<VoiceMode />); });
    // Transition to listening first so toggle is meaningful
    await act(async () => { pushMsg({ type: "ready", sessionId: "s1" }); });

    const muteButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="voice-control-mute"]',
    );
    expect(muteButton).not.toBeNull();

    // Mute
    await act(async () => { muteButton!.click(); });
    expect(sendMock).toHaveBeenCalledWith({ type: "mute" });
    const status = container.querySelector<HTMLElement>('[data-testid="voice-mode-status"]');
    expect(status!.dataset.phase).toBe("muted");

    // Unmute
    await act(async () => { muteButton!.click(); });
    expect(sendMock).toHaveBeenCalledWith({ type: "unmute" });
    expect(status!.dataset.phase).toBe("listening");
  });

  it("sends end message and navigates on End button click", async () => {
    await act(async () => { root.render(<VoiceMode />); });

    const endButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="voice-control-end"]',
    );
    expect(endButton).not.toBeNull();

    await act(async () => { endButton!.click(); });

    expect(sendMock).toHaveBeenCalledWith({ type: "end" });
    expect(navigateMock).toHaveBeenCalledWith("/dashboard");
  });

  it("orb receives the correct phase prop", async () => {
    await act(async () => { root.render(<VoiceMode />); });
    await act(async () => { pushMsg({ type: "ready", sessionId: "s1" }); });
    const orb = container.querySelector<HTMLElement>('[data-testid="voice-orb"]');
    expect(orb!.dataset.phase).toBe("listening");
  });
});
