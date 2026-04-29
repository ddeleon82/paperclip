import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { createElevenLabsClient } from "./elevenlabs.js";
import { createAudioStore } from "./audio-store.js";
import { registerRoutes } from "./routes.js";

const ELEVENLABS_SECRET_REF = "ELEVENLABS_API_KEY";
const SWEEP_MS = 60 * 60 * 1000; // hourly

const plugin = definePlugin({
  async setup(ctx) {
    // Resolve ElevenLabs API key from instance secrets
    const apiKey = await ctx.secrets.resolve(ELEVENLABS_SECRET_REF);

    // Construct vendor client and audio store
    const client = createElevenLabsClient({ apiKey });
    const store = createAudioStore({ ttlMs: 24 * 60 * 60 * 1000 });

    // Register voice actions (transcribe, speak, audio.get)
    registerRoutes(ctx, { client, store });

    // Health data endpoint
    ctx.data.register("health", async () => {
      return { status: "ok", checkedAt: new Date().toISOString() };
    });

    // Hourly TTL sweeper
    const sweepTimer = setInterval(() => {
      store.sweep().catch((err) => ctx.logger.error("voice-mode sweep failed", err));
    }, SWEEP_MS);

    // Clear sweep interval on shutdown
    ctx.logger.info("voice-mode plugin setup complete");

    // Store sweepTimer ref on global for shutdown cleanup
    // onShutdown is defined at the definePlugin level below
    (globalThis as Record<string, unknown>).__voiceModeSweepTimer = sweepTimer;
  },

  async onHealth() {
    return { status: "ok", message: "Voice mode plugin is running" };
  },

  async onShutdown() {
    const timer = (globalThis as Record<string, unknown>).__voiceModeSweepTimer;
    if (timer) clearInterval(timer as ReturnType<typeof setInterval>);
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
