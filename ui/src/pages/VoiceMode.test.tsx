// @vitest-environment jsdom

// React 19.2 dropped `act` from the top-level `react` export under production
// builds; pull it from react-dom/test-utils so this harness keeps working
// regardless of NODE_ENV.
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Router mock — VoiceMode imports useNavigate from "@/lib/router".
// ---------------------------------------------------------------------------
const navigateMock = vi.fn();
vi.mock("@/lib/router", () => ({
  useNavigate: () => navigateMock,
}));

// ---------------------------------------------------------------------------
// Company context — VoiceMode reads `selectedCompanyId`.
// ---------------------------------------------------------------------------
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "co-1" }),
}));

// ---------------------------------------------------------------------------
// React Query — return a synthetic agent list so agentId resolves.
// ---------------------------------------------------------------------------
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: [{ id: "agent-1" }] }),
}));

vi.mock("@/lib/queryKeys", () => ({
  queryKeys: { agents: { list: (id: string) => ["agents", id] } },
}));

// ---------------------------------------------------------------------------
// Hooks — keep them inert so the page test only covers wiring.
// ---------------------------------------------------------------------------
vi.mock("@/hooks/useVad", () => ({
  useVad: () => ({ state: "listening", pause: vi.fn(), resume: vi.fn() }),
}));

const ttsControls = {
  play: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn(),
  isPlaying: false,
  // The orb polls getLevel() each frame; in jsdom it always reports silence.
  getLevel: vi.fn(() => 0),
  // Resolves immediately in tests; real impl awaits clip ended/pause event.
  waitUntilDone: vi.fn().mockResolvedValue(undefined),
};
vi.mock("@/hooks/useStreamingTts", () => ({
  useStreamingTts: () => ttsControls,
}));

const dispatchMock = vi.fn();
vi.mock("@/hooks/useVoiceSessionMachine", () => ({
  useVoiceSessionMachine: () => ({
    state: { phase: "listening" },
    dispatch: dispatchMock,
  }),
}));

// ---------------------------------------------------------------------------
// API mocks — the plugin action client is invoked via pluginsApi.
// ---------------------------------------------------------------------------
vi.mock("@/api/agents", () => ({
  agentsApi: { list: vi.fn().mockResolvedValue([{ id: "agent-1" }]) },
}));
vi.mock("@/api/heartbeats", () => ({
  heartbeatsApi: { log: vi.fn().mockResolvedValue({ content: "" }) },
}));
vi.mock("@/api/plugins", () => ({
  pluginsApi: { bridgePerformAction: vi.fn().mockResolvedValue({ data: {} }) },
}));

// ---------------------------------------------------------------------------
// VoicePoweredOrb — stub the WebGL implementation so we can assert what props
// the page passes through. jsdom can't run the real shader anyway.
// ---------------------------------------------------------------------------
const orbPropsLog: Array<Record<string, unknown>> = [];
vi.mock("@/components/voice/VoicePoweredOrb", () => ({
  VoicePoweredOrb: (props: Record<string, unknown>) => {
    orbPropsLog.push(props);
    return (
      <div
        data-testid="voice-orb"
        data-phase={String(props.phase ?? "")}
        data-has-level={typeof props.getLevel === "function" ? "yes" : "no"}
      />
    );
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { VoiceMode } from "./VoiceMode";

describe("VoiceMode page", () => {
  let container: HTMLDivElement;
  let root: Root;
  const fetchMock = vi.fn();

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    navigateMock.mockReset();
    dispatchMock.mockReset();
    ttsControls.play.mockReset();
    ttsControls.stop.mockReset();
    ttsControls.getLevel.mockReset();
    ttsControls.getLevel.mockReturnValue(0);
    ttsControls.isPlaying = false;
    orbPropsLog.length = 0;

    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (typeof url === "string" && url.includes("/api/voice/session") && init?.method === "POST") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ sessionId: "sess-1" }),
        } as unknown as Response;
      }
      return { ok: true, status: 204, json: async () => ({}) } as unknown as Response;
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // Stub WebSocket so the WS effect does not throw in jsdom.
    class FakeSocket {
      readyState = 1;
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: Event) => void) | null = null;
      onclose: ((e: CloseEvent) => void) | null = null;
      onopen: ((e: Event) => void) | null = null;
      close() {}
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).WebSocket = FakeSocket as any;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders orb, scrollback, and controls", async () => {
    await act(async () => {
      root.render(<VoiceMode />);
    });
    expect(container.querySelector('[data-testid="voice-orb"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="voice-controls"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="voice-scrollback-empty"]') ??
        container.querySelector('[data-testid="voice-scrollback"]'),
    ).not.toBeNull();
  });

  it("renders a mic-ready status indicator wired to the session phase", async () => {
    await act(async () => {
      root.render(<VoiceMode />);
    });
    const status = container.querySelector<HTMLElement>('[data-testid="voice-mode-status"]');
    expect(status).not.toBeNull();
    // Hook mock pins state.phase = "listening" so the indicator must reflect that.
    expect(status!.dataset.phase).toBe("listening");
    expect(status!.textContent ?? "").toMatch(/listening/i);
  });

  it("passes the TTS getLevel function through to the orb so it can react to voice output", async () => {
    await act(async () => {
      root.render(<VoiceMode />);
    });
    const orb = container.querySelector<HTMLElement>('[data-testid="voice-orb"]');
    expect(orb).not.toBeNull();
    expect(orb!.dataset.hasLevel).toBe("yes");
    const lastProps = orbPropsLog[orbPropsLog.length - 1];
    expect(typeof lastProps.getLevel).toBe("function");
    // Calling the prop should delegate to the TTS hook's getLevel.
    (lastProps.getLevel as () => number)();
    expect(ttsControls.getLevel).toHaveBeenCalled();
  });

  it("creates a voice session on mount", async () => {
    await act(async () => {
      root.render(<VoiceMode />);
    });
    // Flush microtasks so the async POST resolves.
    await act(async () => {
      await Promise.resolve();
    });

    const postCalls = fetchMock.mock.calls.filter(
      ([url, init]) => url === "/api/voice/session" && (init as RequestInit | undefined)?.method === "POST",
    );
    expect(postCalls.length).toBe(1);
    const body = JSON.parse(
      (postCalls[0][1] as RequestInit).body as string,
    ) as { companyId: string; agentId: string };
    expect(body).toEqual({ companyId: "co-1", agentId: "agent-1" });
  });

  it("DELETEs the session when End is clicked", async () => {
    await act(async () => {
      root.render(<VoiceMode />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const endButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="voice-control-end"]',
    );
    expect(endButton).not.toBeNull();

    await act(async () => {
      endButton!.click();
    });

    const deleteCalls = fetchMock.mock.calls.filter(
      ([url, init]) =>
        typeof url === "string" &&
        url.startsWith("/api/voice/session/sess-1") &&
        (init as RequestInit | undefined)?.method === "DELETE",
    );
    expect(deleteCalls.length).toBeGreaterThanOrEqual(1);
    expect(navigateMock).toHaveBeenCalledWith("/dashboard");
  });
});
