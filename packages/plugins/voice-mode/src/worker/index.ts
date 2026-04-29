import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { createElevenLabsClient } from "./elevenlabs.js";
import { createAudioStore } from "./audio-store.js";
import { registerRoutes } from "./routes.js";

const ELEVENLABS_SECRET_REF = "ELEVENLABS_API_KEY";
const SWEEP_MS = 60 * 60 * 1000; // hourly

let sweepTimer: ReturnType<typeof setInterval> | undefined;

const plugin = definePlugin({
  async setup(ctx) {
    // Resolve ElevenLabs API key from instance secrets
    const apiKey = await ctx.secrets.resolve(ELEVENLABS_SECRET_REF);

    // Construct vendor client and audio store
    const client = createElevenLabsClient({ apiKey });
    const store = createAudioStore({ ttlMs: 24 * 60 * 60 * 1000 });

    // Register voice actions (voice.transcribe, voice.speak, voice.audio.get)
    registerRoutes(ctx, { client, store });

    // Health data endpoint
    ctx.data.register("health", async () => {
      return { status: "ok", checkedAt: new Date().toISOString() };
    });

    // Hourly TTL sweeper — cleans up expired audio from in-memory store
    sweepTimer = setInterval(() => {
      store.sweep().catch((err) => ctx.logger.error("voice-mode sweep failed", err));
    }, SWEEP_MS);

    ctx.logger.info("voice-mode plugin setup complete");
  },

  async onHealth() {
    return { status: "ok", message: "Voice mode plugin is running" };
  },

  async onShutdown() {
    if (sweepTimer !== undefined) {
      clearInterval(sweepTimer);
      sweepTimer = undefined;
    }
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
