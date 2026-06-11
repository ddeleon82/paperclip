import path from "node:path";

export interface VoiceGatewayConfig {
  geminiApiKey: string | null;
  elevenlabsApiKey: string | null;
  voiceId: string;
  liveModel: string;
  output: "cascade" | "native";
  warmHoldMs: number;
  idleTimeoutMs: number;
  flywheelDir: string | null;
}

const DEFAULT_VOICE_ID = "VjSFSNiy9sK85Z9QRu3d";
const DEFAULT_LIVE_MODEL = "gemini-3.1-flash-live-preview";
const DEFAULT_WARM_HOLD_MS = 60_000;
const DEFAULT_IDLE_TIMEOUT_MS = 300_000;

function nullIfEmpty(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return trimmed;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Pure builder for voice gateway config. Takes an env map and an optional
 * data directory (used to derive the flywheel logging path). No process.env
 * access - callers pass what they need, making this fully testable.
 */
export function buildVoiceGatewayConfig(
  env: Record<string, string | undefined>,
  dataDir: string | null,
): VoiceGatewayConfig {
  const geminiApiKey =
    nullIfEmpty(env.VOICE_GATEWAY_GEMINI_API_KEY) ??
    nullIfEmpty(env.GEMINI_API_KEY);

  const elevenlabsApiKey =
    nullIfEmpty(env.VOICE_GATEWAY_ELEVENLABS_API_KEY) ??
    nullIfEmpty(env.ELEVENLABS_API_KEY);

  const voiceId = env.VOICE_GATEWAY_VOICE_ID?.trim() || DEFAULT_VOICE_ID;

  const liveModel = env.VOICE_GATEWAY_LIVE_MODEL?.trim() || DEFAULT_LIVE_MODEL;

  const outputRaw = env.VOICE_GATEWAY_OUTPUT?.trim();
  const output: "cascade" | "native" = outputRaw === "native" ? "native" : "cascade";

  const warmHoldMs = parsePositiveInt(env.VOICE_GATEWAY_WARM_HOLD_MS, DEFAULT_WARM_HOLD_MS);

  const idleTimeoutMs = parsePositiveInt(
    env.VOICE_GATEWAY_IDLE_TIMEOUT_MS,
    DEFAULT_IDLE_TIMEOUT_MS,
  );

  const flywheelDirFromEnv = nullIfEmpty(env.VOICE_GATEWAY_FLYWHEEL_DIR);
  const flywheelDir =
    flywheelDirFromEnv ??
    (dataDir !== null ? path.join(dataDir, "voice-flywheel") : null);

  return {
    geminiApiKey,
    elevenlabsApiKey,
    voiceId,
    liveModel,
    output,
    warmHoldMs,
    idleTimeoutMs,
    flywheelDir,
  };
}

/**
 * Gateway is enabled iff:
 *   - geminiApiKey is present (non-null), AND
 *   - when output === "cascade", elevenlabsApiKey is also present
 *
 * This is a pure function so it can be used both at startup (for logging) and
 * in route registration logic in later tasks.
 */
export function isVoiceGatewayEnabled(cfg: VoiceGatewayConfig): boolean {
  return voiceGatewayDisabledReason(cfg) === null;
}

/**
 * Returns a human-readable reason string when the gateway is disabled,
 * or null when it is enabled. Pure function - no side effects.
 *
 * Reasons:
 *   - no Gemini API key (VOICE_GATEWAY_GEMINI_API_KEY or GEMINI_API_KEY required)
 *   - cascade output requires ElevenLabs key (VOICE_GATEWAY_ELEVENLABS_API_KEY or ELEVENLABS_API_KEY)
 */
export function voiceGatewayDisabledReason(cfg: VoiceGatewayConfig): string | null {
  if (cfg.geminiApiKey === null) {
    return "no Gemini API key (set VOICE_GATEWAY_GEMINI_API_KEY or GEMINI_API_KEY)";
  }
  if (cfg.output === "cascade" && cfg.elevenlabsApiKey === null) {
    return "cascade output requires an ElevenLabs key (set VOICE_GATEWAY_ELEVENLABS_API_KEY or ELEVENLABS_API_KEY)";
  }
  return null;
}
