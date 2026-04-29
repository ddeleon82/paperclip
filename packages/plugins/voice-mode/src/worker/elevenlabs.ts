type FetchFn = typeof fetch;

export interface ElevenLabsClient {
  transcribe(audio: Uint8Array, mime: string): Promise<string>;
  speak(text: string, voiceId: string): Promise<Uint8Array>;
}

export function createElevenLabsClient(opts: {
  apiKey: string;
  fetch?: FetchFn;
  baseUrl?: string;
}): ElevenLabsClient {
  const fetchFn = opts.fetch ?? fetch;
  const baseUrl = opts.baseUrl ?? "https://api.elevenlabs.io";
  return {
    async transcribe(audio, mime) {
      const form = new FormData();
      form.append("file", new Blob([audio], { type: mime }), "audio.webm");
      form.append("model_id", "scribe_v1");
      const res = await fetchFn(`${baseUrl}/v1/speech-to-text`, {
        method: "POST",
        headers: { "xi-api-key": opts.apiKey } as Record<string, string>,
        body: form as unknown as BodyInit,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`elevenlabs STT failed: ${res.status} ${body}`);
      }
      const json = await res.json();
      return String(json.text ?? "");
    },
    async speak(text, voiceId) {
      const res = await fetchFn(
        `${baseUrl}/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
        {
          method: "POST",
          headers: {
            "xi-api-key": opts.apiKey,
            "content-type": "application/json",
            accept: "audio/mpeg",
          } as Record<string, string>,
          body: JSON.stringify({ text, model_id: "eleven_turbo_v2_5" }),
        },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`elevenlabs TTS failed: ${res.status} ${body}`);
      }
      const buf = await res.arrayBuffer();
      return new Uint8Array(buf);
    },
  };
}
