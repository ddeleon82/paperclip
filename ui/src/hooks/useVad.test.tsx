// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

interface CapturedHandlers {
  onSpeechStart?: () => void;
  onSpeechEnd?: (audio: Float32Array) => void;
  onVADMisfire?: () => void;
}

const fakeVadInstance = {
  start: vi.fn(),
  pause: vi.fn(),
  destroy: vi.fn(),
};

let capturedHandlers: CapturedHandlers = {};
let micVadNewSpy: ReturnType<typeof vi.fn>;
let micVadNewImpl: (
  opts: CapturedHandlers & Record<string, unknown>,
) => Promise<typeof fakeVadInstance>;

vi.mock("@ricky0123/vad-web", () => {
  return {
    MicVAD: {
      new: (...args: unknown[]) => micVadNewSpy(...args),
    },
  };
});

import { useVad } from "./useVad";

function Harness({
  enabled,
  onSpeechEnd,
}: {
  enabled: boolean;
  onSpeechEnd: (audio: Float32Array) => void;
}) {
  const { state } = useVad({ enabled, onSpeechEnd });
  return <div data-testid="state">{state}</div>;
}

describe("useVad", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    fakeVadInstance.start.mockReset();
    fakeVadInstance.pause.mockReset();
    fakeVadInstance.destroy.mockReset();
    capturedHandlers = {};
    micVadNewImpl = async (opts) => {
      capturedHandlers = {
        onSpeechStart: opts.onSpeechStart as () => void,
        onSpeechEnd: opts.onSpeechEnd as (a: Float32Array) => void,
        onVADMisfire: opts.onVADMisfire as () => void,
      };
      return fakeVadInstance;
    };
    micVadNewSpy = vi.fn((opts: CapturedHandlers & Record<string, unknown>) =>
      micVadNewImpl(opts),
    );
  });

  afterEach(() => {
    container.remove();
    vi.restoreAllMocks();
  });

  function getStateText(): string {
    return container.querySelector('[data-testid="state"]')?.textContent ?? "";
  }

  it("stays idle and does not init MicVAD when disabled", () => {
    const root = createRoot(container);
    act(() => {
      root.render(<Harness enabled={false} onSpeechEnd={() => {}} />);
    });
    expect(getStateText()).toBe("idle");
    expect(micVadNewSpy).not.toHaveBeenCalled();
    act(() => {
      root.unmount();
    });
  });

  it("transitions loading -> listening when MicVAD initializes", async () => {
    const root = createRoot(container);
    const onSpeechEnd = vi.fn();
    await act(async () => {
      root.render(<Harness enabled={true} onSpeechEnd={onSpeechEnd} />);
    });
    // Flush the pending promise resolution from MicVAD.new
    await act(async () => {
      await Promise.resolve();
    });
    expect(micVadNewSpy).toHaveBeenCalledOnce();
    expect(fakeVadInstance.start).toHaveBeenCalled();
    expect(getStateText()).toBe("listening");
    act(() => {
      root.unmount();
    });
  });

  it("transitions to speaking when onSpeechStart fires", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(<Harness enabled={true} onSpeechEnd={() => {}} />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(getStateText()).toBe("listening");
    act(() => {
      capturedHandlers.onSpeechStart?.();
    });
    expect(getStateText()).toBe("speaking");
    act(() => {
      root.unmount();
    });
  });

  it("calls onSpeechEnd callback with audio buffer and returns to listening", async () => {
    const root = createRoot(container);
    const onSpeechEnd = vi.fn();
    await act(async () => {
      root.render(<Harness enabled={true} onSpeechEnd={onSpeechEnd} />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      capturedHandlers.onSpeechStart?.();
    });
    expect(getStateText()).toBe("speaking");
    const buffer = new Float32Array([0.1, 0.2, 0.3]);
    act(() => {
      capturedHandlers.onSpeechEnd?.(buffer);
    });
    expect(getStateText()).toBe("listening");
    expect(onSpeechEnd).toHaveBeenCalledWith(buffer);
    act(() => {
      root.unmount();
    });
  });

  it("destroys MicVAD on unmount", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(<Harness enabled={true} onSpeechEnd={() => {}} />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      root.unmount();
    });
    expect(fakeVadInstance.destroy).toHaveBeenCalled();
  });

  it("does not setState after unmount when MicVAD.new resolves late", async () => {
    let resolveLate: ((v: typeof fakeVadInstance) => void) | null = null;
    micVadNewImpl = (_opts) =>
      new Promise((resolve) => {
        resolveLate = resolve;
      });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const root = createRoot(container);
    await act(async () => {
      root.render(<Harness enabled={true} onSpeechEnd={() => {}} />);
    });
    expect(getStateText()).toBe("loading");
    act(() => {
      root.unmount();
    });
    // Resolve after unmount; the hook should destroy the late-arriving instance and not throw.
    await act(async () => {
      resolveLate?.(fakeVadInstance);
      await Promise.resolve();
    });
    expect(fakeVadInstance.destroy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("transitions to error when MicVAD.new rejects", async () => {
    micVadNewImpl = () => Promise.reject(new Error("boom"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = createRoot(container);
    await act(async () => {
      root.render(<Harness enabled={true} onSpeechEnd={() => {}} />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getStateText()).toBe("error");
    errorSpy.mockRestore();
    act(() => {
      root.unmount();
    });
  });
});
