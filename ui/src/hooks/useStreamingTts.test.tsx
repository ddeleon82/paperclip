// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { useStreamingTts, type StreamingTtsControls } from "./useStreamingTts";

interface FakeAudio {
  src: string;
  currentTime: number;
  paused: boolean;
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  addEventListener: (type: string, listener: () => void) => void;
  dispatch: (type: string) => void;
}

const fakeAudios: FakeAudio[] = [];

function createFakeAudio(): FakeAudio {
  const listeners: Record<string, Array<() => void>> = {};
  const audio: FakeAudio = {
    src: "",
    currentTime: 0,
    paused: true,
    play: vi.fn(function (this: FakeAudio) {
      audio.paused = false;
      (listeners["play"] ?? []).forEach((l) => l());
      (listeners["playing"] ?? []).forEach((l) => l());
      return Promise.resolve();
    }),
    pause: vi.fn(function (this: FakeAudio) {
      audio.paused = true;
      (listeners["pause"] ?? []).forEach((l) => l());
    }),
    addEventListener: (type: string, listener: () => void) => {
      listeners[type] = listeners[type] ?? [];
      listeners[type].push(listener);
    },
    dispatch: (type: string) => {
      (listeners[type] ?? []).forEach((l) => l());
    },
  };
  return audio;
}

const revokeSpy = vi.fn();
const createUrlSpy = vi.fn(() => `blob:fake-${Math.random()}`);

beforeEach(() => {
  fakeAudios.length = 0;
  // Patch Audio constructor.
  (globalThis as unknown as { Audio: unknown }).Audio = function () {
    const a = createFakeAudio();
    fakeAudios.push(a);
    return a;
  };
  // Patch URL helpers.
  (globalThis as unknown as { URL: typeof URL }).URL = {
    ...URL,
    createObjectURL: createUrlSpy as unknown as typeof URL.createObjectURL,
    revokeObjectURL: revokeSpy as unknown as typeof URL.revokeObjectURL,
  } as unknown as typeof URL;
  revokeSpy.mockClear();
  createUrlSpy.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface HarnessHandle {
  controls: StreamingTtsControls | null;
  isPlaying: boolean;
}

function Harness({ handle }: { handle: HarnessHandle }) {
  const controls = useStreamingTts();
  handle.controls = controls;
  handle.isPlaying = controls.isPlaying;
  return <div data-testid="state">{controls.isPlaying ? "playing" : "stopped"}</div>;
}

function render(): {
  root: ReturnType<typeof createRoot>;
  container: HTMLDivElement;
  handle: HarnessHandle;
} {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const handle: HarnessHandle = { controls: null, isPlaying: false };
  act(() => {
    root.render(<Harness handle={handle} />);
  });
  return { root, container, handle };
}

describe("useStreamingTts (Uint8Array path)", () => {
  it("transitions isPlaying false -> true when play() called", async () => {
    const { root, container, handle } = render();
    expect(handle.controls).not.toBeNull();
    expect(container.querySelector('[data-testid="state"]')?.textContent).toBe("stopped");

    await act(async () => {
      await handle.controls!.play(new Uint8Array([1, 2, 3]));
    });

    const audio = fakeAudios[0];
    expect(audio.play).toHaveBeenCalled();
    expect(audio.src).toMatch(/^blob:/);
    expect(container.querySelector('[data-testid="state"]')?.textContent).toBe("playing");

    act(() => {
      root.unmount();
    });
  });

  it("stop() pauses audio and clears isPlaying", async () => {
    const { root, container, handle } = render();
    await act(async () => {
      await handle.controls!.play(new Uint8Array([1, 2, 3]));
    });
    const audio = fakeAudios[0];
    expect(audio.paused).toBe(false);

    act(() => {
      handle.controls!.stop();
    });
    expect(audio.pause).toHaveBeenCalled();
    expect(audio.currentTime).toBe(0);
    expect(revokeSpy).toHaveBeenCalled();
    expect(container.querySelector('[data-testid="state"]')?.textContent).toBe("stopped");

    act(() => {
      root.unmount();
    });
  });

  it("play() while already playing stops previous and starts new", async () => {
    const { root, handle } = render();
    await act(async () => {
      await handle.controls!.play(new Uint8Array([1, 2, 3]));
    });
    const audio = fakeAudios[0];
    const firstSrc = audio.src;

    await act(async () => {
      await handle.controls!.play(new Uint8Array([4, 5, 6]));
    });

    // Same audio element is reused; pause must have been called before new src.
    expect(audio.pause).toHaveBeenCalled();
    expect(audio.src).not.toBe(firstSrc);
    expect(revokeSpy).toHaveBeenCalled();
    expect(audio.play).toHaveBeenCalledTimes(2);

    act(() => {
      root.unmount();
    });
  });

  it("isPlaying becomes false when audio finishes (ended)", async () => {
    const { root, container, handle } = render();
    await act(async () => {
      await handle.controls!.play(new Uint8Array([1, 2, 3]));
    });
    expect(container.querySelector('[data-testid="state"]')?.textContent).toBe("playing");

    const audio = fakeAudios[0];
    act(() => {
      audio.dispatch("ended");
    });
    expect(container.querySelector('[data-testid="state"]')?.textContent).toBe("stopped");

    act(() => {
      root.unmount();
    });
  });

  it("unmount pauses audio and revokes object URLs", async () => {
    const { root, handle } = render();
    await act(async () => {
      await handle.controls!.play(new Uint8Array([1, 2, 3]));
    });
    const audio = fakeAudios[0];
    revokeSpy.mockClear();

    act(() => {
      root.unmount();
    });
    expect(audio.pause).toHaveBeenCalled();
    expect(revokeSpy).toHaveBeenCalled();
  });
});
