import { describe, it, expect, vi } from "vitest";
import { createElevenLabsClient } from "./elevenlabs";

describe("elevenlabs client", () => {
  it("transcribe() POSTs audio to /v1/speech-to-text and returns transcript", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: "hello world" }),
    });
    const client = createElevenLabsClient({ apiKey: "k", fetch: fetchMock });
    const out = await client.transcribe(new Uint8Array([1, 2]), "audio/webm");
    expect(out).toBe("hello world");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("speech-to-text");
    expect(init.headers["xi-api-key"]).toBe("k");
  });

  it("speak() POSTs to /v1/text-to-speech/<voice> and returns mp3 bytes", async () => {
    const bytes = new Uint8Array([0xff, 0xfb]);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => bytes.buffer,
    });
    const client = createElevenLabsClient({ apiKey: "k", fetch: fetchMock });
    const out = await client.speak("hi", "voice123");
    expect(out).toEqual(bytes);
    expect(fetchMock.mock.calls[0][0]).toContain("text-to-speech/voice123");
  });

  it("transcribe() throws on 4xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false, status: 401, text: async () => "bad key",
    });
    const client = createElevenLabsClient({ apiKey: "k", fetch: fetchMock });
    await expect(client.transcribe(new Uint8Array([1]), "audio/webm"))
      .rejects.toThrow(/elevenlabs/i);
  });
});
