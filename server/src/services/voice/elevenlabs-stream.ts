// Ported from packages/plugins/voice-mode/src/worker/elevenlabs-stream.ts (FRE-1296).
// The plugin worker copy remains for backward compatibility; the server needs
// its own copy because it cannot import plugin worker source directly.
//
// Change from the plugin copy: default modelId is "eleven_flash_v2_5" (was
// "eleven_turbo_v2_5"). Node 20 has global WebSocket via undici; the default
// wsFactory is evaluated lazily so tests that supply their own wsFactory never
// open real sockets.

export type StreamTtsOpts = {
  voiceId: string;
  text$: ReadableStream<string>;
  apiKey: string;
  modelId?: string; // default "eleven_flash_v2_5"
  wsFactory?: (url: string) => WebSocket;
};

export function streamTextToSpeech(opts: StreamTtsOpts): ReadableStream<Uint8Array> {
  const modelId = opts.modelId ?? "eleven_flash_v2_5";
  const url =
    `wss://api.elevenlabs.io/v1/text-to-speech/${opts.voiceId}/stream-input` +
    `?model_id=${modelId}&output_format=mp3_44100_128`;
  const ws = (opts.wsFactory ?? ((u) => new WebSocket(u)))(url);

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const closeOnce = () => {
        if (closed) return;
        closed = true;
        try { controller.close(); } catch { /* already closed */ }
      };

      ws.binaryType = "arraybuffer";

      ws.addEventListener("open", () => {
        // ElevenLabs WS protocol: first message primes the session with voice settings + auth.
        ws.send(JSON.stringify({
          text: " ",
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
          xi_api_key: opts.apiKey,
        }));
        const reader = opts.text$.getReader();
        const pump = (): Promise<void> =>
          reader.read().then(({ done, value }) => {
            if (done) {
              try { ws.send(JSON.stringify({ text: "" })); } catch { /* socket may be closing */ }
              return;
            }
            try {
              ws.send(JSON.stringify({ text: value, try_trigger_generation: true }));
            } catch { /* socket may be closing */ }
            return pump();
          });
        void pump();
      });

      ws.addEventListener("message", (ev) => {
        const raw = (ev as MessageEvent).data;
        if (typeof raw === "string") {
          let data: { audio?: string; isFinal?: boolean; error?: string; message?: string } | null = null;
          try { data = JSON.parse(raw); } catch { /* ignore parse errors */ }
          // Surface protocol errors (e.g. payment_issue, quota_exceeded) instead
          // of silently closing with no audio.
          if (data?.error) {
            closed = true;
            try {
              controller.error(new Error(`elevenlabs ${data.error}: ${data.message ?? "unknown error"}`));
            } catch { /* already closed */ }
            try { ws.close(); } catch { /* already closing */ }
            return;
          }
          if (data?.audio) {
            const bin = Uint8Array.from(atob(data.audio), (c) => c.charCodeAt(0));
            try { controller.enqueue(bin); } catch { /* stream closed */ }
          }
          if (data?.isFinal) closeOnce();
        } else if (raw instanceof ArrayBuffer) {
          try { controller.enqueue(new Uint8Array(raw)); } catch { /* stream closed */ }
        }
      });

      ws.addEventListener("close", () => closeOnce());
      ws.addEventListener("error", (e) => {
        try { controller.error(e); } catch { /* already closed */ }
      });
    },
    cancel() {
      try { ws.close(); } catch { /* already closed */ }
    },
  });
}
