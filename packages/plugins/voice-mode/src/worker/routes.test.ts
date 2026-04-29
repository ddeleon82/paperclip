import { describe, it, expect, vi } from "vitest";
import { registerRoutes } from "./routes";

describe("voice routes", () => {
  it("transcribe action returns transcript and audioId", async () => {
    const fakeClient = {
      transcribe: vi.fn().mockResolvedValue("hello"),
      speak: vi.fn(),
    };
    const store = {
      put: vi.fn().mockResolvedValue("audio-1"),
      get: vi.fn(),
      sweep: vi.fn(),
    };
    const ctx = {
      secrets: { resolve: vi.fn().mockResolvedValue("test-key") },
      logger: { info: vi.fn(), error: vi.fn() },
      actions: { register: vi.fn() },
      data: { register: vi.fn() },
    };

    registerRoutes(ctx as any, { client: fakeClient, store });

    // Find the transcribe handler that was registered
    const transcribeCall = (ctx.actions.register as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === "voice.transcribe",
    );
    expect(transcribeCall).toBeDefined();
    const transcribeHandler = transcribeCall![1] as (params: Record<string, unknown>) => Promise<unknown>;

    const result = await transcribeHandler({ audioBase64: "AQID", mime: "audio/webm" });
    expect(fakeClient.transcribe).toHaveBeenCalled();
    expect(result).toEqual({ transcript: "hello", audioId: "audio-1" });
  });

  it("speak action returns mp3 bytes as base64", async () => {
    const bytes = new Uint8Array([0xff, 0xfb, 0x90]);
    const fakeClient = {
      transcribe: vi.fn(),
      speak: vi.fn().mockResolvedValue(bytes),
    };
    const store = { put: vi.fn(), get: vi.fn(), sweep: vi.fn() };
    const ctx = {
      secrets: { resolve: vi.fn().mockResolvedValue("test-key") },
      logger: { info: vi.fn(), error: vi.fn() },
      actions: { register: vi.fn() },
      data: { register: vi.fn() },
    };

    registerRoutes(ctx as any, { client: fakeClient, store });

    const speakCall = (ctx.actions.register as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === "voice.speak",
    );
    expect(speakCall).toBeDefined();
    const speakHandler = speakCall![1] as (params: Record<string, unknown>) => Promise<unknown>;

    const result = await speakHandler({ text: "hi", voiceId: "v" }) as { audioBase64: string; mime: string };
    expect(fakeClient.speak).toHaveBeenCalledWith("hi", "v");
    expect(result.mime).toBe("audio/mpeg");
    // Decode the base64 and check the first byte
    const decoded = Buffer.from(result.audioBase64, "base64");
    expect(decoded[0]).toBe(0xff);
  });
});
