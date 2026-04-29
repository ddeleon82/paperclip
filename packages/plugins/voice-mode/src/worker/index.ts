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

    // -----------------------------------------------------------------------
    // Per-agent voice KV actions
    //
    // Stored at scope: { scopeKind: "instance", stateKey: "agentVoices" }
    // Value shape: Record<agentId, voiceId>
    // -----------------------------------------------------------------------

    const AGENT_VOICES_SCOPE = {
      scopeKind: "instance" as const,
      stateKey: "agentVoices",
    };

    ctx.actions.register("voice.agentVoices.get", async () => {
      const map = (await ctx.state.get(AGENT_VOICES_SCOPE)) ?? {};
      return map as Record<string, string>;
    });

    ctx.actions.register("voice.agentVoices.set", async (params) => {
      const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
      const voiceId = typeof params.voiceId === "string" ? params.voiceId.trim() : "";
      if (!agentId || !voiceId) throw new Error("agentId and voiceId required");
      const existing = (await ctx.state.get(AGENT_VOICES_SCOPE)) ?? {};
      const map = existing as Record<string, string>;
      map[agentId] = voiceId;
      await ctx.state.set(AGENT_VOICES_SCOPE, map);
      return { ok: true };
    });

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
