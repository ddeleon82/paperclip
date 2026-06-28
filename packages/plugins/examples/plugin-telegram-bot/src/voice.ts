/**
 * Voice / TTS — ElevenLabs integration for voice briefings.
 *
 * Generates OGG/Opus audio from text via the ElevenLabs API,
 * which is the native format for Telegram voice messages.
 */

import type { PluginLogger } from "@paperclipai/plugin-sdk";

const ELEVENLABS_API_BASE = "https://api.elevenlabs.io/v1";

/** Default voice: Kenn Akomea — Black British male, calm & friendly. */
export const DEFAULT_VOICE_ID = "VjSFSNiy9sK85Z9QRu3d";

export interface VoiceClient {
  /** Generate OGG/Opus audio from text. Returns raw audio bytes. */
  synthesize(text: string): Promise<Uint8Array>;
}

export function createVoiceClient(
  logger: PluginLogger,
  apiKey: string,
  voiceId: string,
): VoiceClient {
  return {
    async synthesize(text: string): Promise<Uint8Array> {
      const url = `${ELEVENLABS_API_BASE}/text-to-speech/${voiceId}`;

      logger.info("Requesting TTS from ElevenLabs", {
        voiceId,
        textLength: text.length,
      });

      // Global fetch, NOT ctx.http: the host RPC bridge serializes bodies as
      // UTF-8 strings, which corrupts the binary audio response (FRE-1318).
      // Same pattern as the voice-mode plugin's ElevenLabs client.
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "audio/ogg",
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_turbo_v2_5",
          output_format: "ogg_opus",
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0.3,
          },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "unknown");
        logger.error("ElevenLabs TTS failed", {
          status: response.status,
          error: errorText,
        });
        throw new Error(`ElevenLabs TTS failed (${response.status}): ${errorText}`);
      }

      const buffer = await response.arrayBuffer();
      logger.info("TTS audio generated", { bytes: buffer.byteLength });
      return new Uint8Array(buffer);
    },
  };
}

/**
 * Compose a natural-language briefing from system data.
 *
 * Designed to sound good when read aloud — short sentences,
 * no abbreviations, conversational tone.
 */
export function composeBriefingText(data: BriefingData): string {
  const parts: string[] = [];

  // Greeting
  const hour = new Date().getUTCHours();
  const timeOfDay = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  parts.push(`Good ${timeOfDay}. Here's your briefing.`);

  // Issue summary
  if (data.issues.total > 0) {
    parts.push(
      `You have ${data.issues.total} issue${data.issues.total === 1 ? "" : "s"} on the board.` +
        ` ${data.issues.inProgress} in progress, ${data.issues.todo} waiting, and ${data.issues.done} done.`,
    );

    if (data.issues.urgent > 0) {
      parts.push(
        `Heads up — ${data.issues.urgent} urgent item${data.issues.urgent === 1 ? "" : "s"} need${data.issues.urgent === 1 ? "s" : ""} attention.`,
      );
    }

    if (data.issues.topItems.length > 0) {
      parts.push("Top priority items:");
      for (const item of data.issues.topItems.slice(0, 3)) {
        parts.push(`${item.title}. Status: ${item.status}.`);
      }
    }
  } else {
    parts.push("No issues on the board right now. Clean slate.");
  }

  // Agent summary
  if (data.agents.total > 0) {
    parts.push(
      `${data.agents.total} agent${data.agents.total === 1 ? "" : "s"} registered.` +
        (data.agents.active > 0
          ? ` ${data.agents.active} currently active.`
          : " None actively running."),
    );
  }

  // Project summary
  if (data.projects > 0) {
    parts.push(`Across ${data.projects} project${data.projects === 1 ? "" : "s"}.`);
  }

  parts.push("That's the rundown.");

  return parts.join(" ");
}

export interface BriefingData {
  issues: {
    total: number;
    todo: number;
    inProgress: number;
    done: number;
    urgent: number;
    topItems: Array<{ title: string; status: string; priority: string }>;
  };
  agents: {
    total: number;
    active: number;
  };
  projects: number;
}
