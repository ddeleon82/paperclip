// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useVoiceMode } from "./useVoiceMode";

describe("useVoiceMode", () => {
  beforeEach(() => localStorage.clear());

  it("starts disabled by default", () => {
    const { result } = renderHook(() => useVoiceMode());
    expect(result.current.enabled).toBe(false);
  });

  it("toggle persists to localStorage", () => {
    const { result } = renderHook(() => useVoiceMode());
    act(() => result.current.toggle());
    expect(localStorage.getItem("paperclip:voiceMode:enabled")).toBe("true");
    expect(result.current.enabled).toBe(true);
  });

  it("starts/stops recording flips isRecording", async () => {
    // Mock MediaRecorder + getUserMedia in test setup or globalThis
    const fakeStream = { getTracks: () => [{ stop: vi.fn() }] };
    (globalThis.navigator as any).mediaDevices = {
      getUserMedia: vi.fn().mockResolvedValue(fakeStream),
    };
    class FakeRecorder {
      static instances: FakeRecorder[] = [];
      stream = fakeStream;
      ondataavailable: ((e: any) => void) | null = null;
      onstop: (() => void) | null = null;
      constructor() { FakeRecorder.instances.push(this); }
      start() {}
      stop() { setTimeout(() => this.onstop?.(), 0); }
    }
    (globalThis as any).MediaRecorder = FakeRecorder;
    const { result } = renderHook(() => useVoiceMode());
    await act(async () => { await result.current.startRecording(); });
    expect(result.current.isRecording).toBe(true);
    await act(async () => { await result.current.stopRecording(); });
    expect(result.current.isRecording).toBe(false);
  });
});
