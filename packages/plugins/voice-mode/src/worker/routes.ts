import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { ElevenLabsClient } from "./elevenlabs";
import type { AudioStore } from "./audio-store";

/**
 * Register voice plugin actions with the plugin worker context.
 *
 * Actions are called by the UI via usePluginAction():
 *   - "voice.transcribe": { audioBase64, mime } -> { transcript, audioId }
 *   - "voice.speak":      { text, voiceId }     -> { audioBase64, mime }
 *   - "voice.audio.get":  { audioId }           -> { audioBase64 } | null
 */
export function registerRoutes(
  ctx: Pick<PluginContext, "actions" | "logger">,
  deps: { client: ElevenLabsClient; store: AudioStore },
): void {
  ctx.actions.register("voice.transcribe", async (params) => {
    const audioBase64 = typeof params.audioBase64 === "string" ? params.audioBase64 : "";
    const mime = typeof params.mime === "string" ? params.mime : "audio/webm";
    if (!audioBase64) {
      throw new Error("audioBase64 is required");
    }
    const bytes = Uint8Array.from(Buffer.from(audioBase64, "base64"));
    const transcript = await deps.client.transcribe(bytes, mime);
    const audioId = await deps.store.put(bytes);
    ctx.logger.info("voice.transcribe: ok", { chars: transcript.length, audioId });
    return { transcript, audioId };
  });

  ctx.actions.register("voice.speak", async (params) => {
    const text = typeof params.text === "string" ? params.text : "";
    const voiceId = typeof params.voiceId === "string" ? params.voiceId : "";
    if (!text || !voiceId) {
      throw new Error("text and voiceId are required");
    }
    const audio = await deps.client.speak(text, voiceId);
    ctx.logger.info("voice.speak: ok", { voiceId, bytes: audio.byteLength });
    return {
      audioBase64: Buffer.from(audio).toString("base64"),
      mime: "audio/mpeg",
    };
  });

  ctx.actions.register("voice.audio.get", async (params) => {
    const audioId = typeof params.audioId === "string" ? params.audioId : "";
    if (!audioId) throw new Error("audioId is required");
    const bytes = await deps.store.get(audioId);
    if (!bytes) return null;
    return { audioBase64: Buffer.from(bytes).toString("base64"), mime: "audio/webm" };
  });
}
