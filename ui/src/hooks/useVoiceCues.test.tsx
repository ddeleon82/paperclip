// @vitest-environment jsdom

// React 19.2 dropped `act` from the top-level `react` export under production
// builds; pull it from react-dom/test-utils so this harness keeps working
// regardless of NODE_ENV.
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";

import { useVoiceCues } from "./useVoiceCues";

// ---------------------------------------------------------------------------
// AudioContext stub. We never produce real audio in jsdom; we just want to
// verify that the cue hook (a) does not throw, (b) creates one oscillator per
// cue, and (c) connects + starts + stops the node so cleanup is correct.
// ---------------------------------------------------------------------------

interface OscRecord {
  type: string;
  frequency: { value: number };
  connect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  onended: (() => void) | null;
}
interface GainRecord {
  gain: {
    value: number;
    setValueAtTime: ReturnType<typeof vi.fn>;
    exponentialRampToValueAtTime: ReturnType<typeof vi.fn>;
    linearRampToValueAtTime: ReturnType<typeof vi.fn>;
  };
  connect: ReturnType<typeof vi.fn>;
}

const oscillators: OscRecord[] = [];
const gains: GainRecord[] = [];

class FakeAudioContext {
  currentTime = 0;
  destination = {};
  state: "running" | "suspended" = "running";
  createOscillator(): OscRecord {
    const osc: OscRecord = {
      type: "sine",
      frequency: { value: 440 },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null,
    };
    oscillators.push(osc);
    return osc;
  }
  createGain(): GainRecord {
    const gain: GainRecord = {
      gain: {
        value: 0,
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
    };
    gains.push(gain);
    return gain;
  }
  resume() {
    this.state = "running";
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("useVoiceCues", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    oscillators.length = 0;
    gains.length = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).AudioContext = FakeAudioContext;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).AudioContext;
  });

  function Harness({ onReady }: { onReady: (api: ReturnType<typeof useVoiceCues>) => void }) {
    const cues = useVoiceCues();
    useEffect(() => {
      onReady(cues);
    }, [cues, onReady]);
    return null;
  }

  it("emits one tone per playMicOpen call", () => {
    let api: ReturnType<typeof useVoiceCues> | null = null;
    act(() => {
      root.render(<Harness onReady={(a) => (api = a)} />);
    });
    expect(api).not.toBeNull();

    act(() => {
      api!.playMicOpen();
    });

    expect(oscillators.length).toBe(1);
    expect(oscillators[0].start).toHaveBeenCalledTimes(1);
    expect(oscillators[0].stop).toHaveBeenCalledTimes(1);
    // Mic open should be a brighter (higher pitched) tone.
    expect(oscillators[0].frequency.value).toBeGreaterThan(500);
  });

  it("emits a distinct tone for playSpeechReceived", () => {
    let api: ReturnType<typeof useVoiceCues> | null = null;
    act(() => {
      root.render(<Harness onReady={(a) => (api = a)} />);
    });

    act(() => {
      api!.playSpeechReceived();
    });

    expect(oscillators.length).toBe(1);
    // The "received" cue should be a different pitch than the open cue.
    expect(oscillators[0].frequency.value).toBeLessThan(500);
  });

  it("returns no-op stubs when AudioContext is unavailable", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).AudioContext;

    let api: ReturnType<typeof useVoiceCues> | null = null;
    act(() => {
      root.render(<Harness onReady={(a) => (api = a)} />);
    });

    expect(() => {
      api!.playMicOpen();
      api!.playSpeechReceived();
    }).not.toThrow();
    expect(oscillators.length).toBe(0);
  });
});
