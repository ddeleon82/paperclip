import { describe, expect, it } from "vitest";
import {
  buildVoiceGatewayConfig,
  isVoiceGatewayEnabled,
  voiceGatewayDisabledReason,
  type VoiceGatewayConfig,
} from "../voice-gateway-config.js";

const KENN_VOICE_ID = "VjSFSNiy9sK85Z9QRu3d";
const DEFAULT_LIVE_MODEL = "gemini-3.1-flash-live-preview";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function build(
  env: Record<string, string | undefined> = {},
  dataDir: string | null = null,
): VoiceGatewayConfig {
  return buildVoiceGatewayConfig(env, dataDir);
}

// ---------------------------------------------------------------------------
// geminiApiKey fallback order
// ---------------------------------------------------------------------------

describe("geminiApiKey env fallback order", () => {
  it("returns null when neither key is set", () => {
    const cfg = build({});
    expect(cfg.geminiApiKey).toBeNull();
  });

  it("uses VOICE_GATEWAY_GEMINI_API_KEY when present", () => {
    const cfg = build({ VOICE_GATEWAY_GEMINI_API_KEY: "vg-key", GEMINI_API_KEY: "fallback" });
    expect(cfg.geminiApiKey).toBe("vg-key");
  });

  it("falls back to GEMINI_API_KEY when VOICE_GATEWAY_GEMINI_API_KEY is absent", () => {
    const cfg = build({ GEMINI_API_KEY: "fallback-key" });
    expect(cfg.geminiApiKey).toBe("fallback-key");
  });

  it("returns null when VOICE_GATEWAY_GEMINI_API_KEY is empty string", () => {
    const cfg = build({ VOICE_GATEWAY_GEMINI_API_KEY: "" });
    expect(cfg.geminiApiKey).toBeNull();
  });

  it("returns trimmed value when VOICE_GATEWAY_GEMINI_API_KEY has surrounding whitespace", () => {
    const cfg = build({ VOICE_GATEWAY_GEMINI_API_KEY: "  padded-key  " });
    expect(cfg.geminiApiKey).toBe("padded-key");
  });
});

// ---------------------------------------------------------------------------
// elevenlabsApiKey fallback order
// ---------------------------------------------------------------------------

describe("elevenlabsApiKey env fallback order", () => {
  it("returns null when neither key is set", () => {
    const cfg = build({});
    expect(cfg.elevenlabsApiKey).toBeNull();
  });

  it("uses VOICE_GATEWAY_ELEVENLABS_API_KEY when present", () => {
    const cfg = build({
      VOICE_GATEWAY_ELEVENLABS_API_KEY: "el-vg-key",
      ELEVENLABS_API_KEY: "el-fallback",
    });
    expect(cfg.elevenlabsApiKey).toBe("el-vg-key");
  });

  it("falls back to ELEVENLABS_API_KEY when specific key is absent", () => {
    const cfg = build({ ELEVENLABS_API_KEY: "el-fallback-key" });
    expect(cfg.elevenlabsApiKey).toBe("el-fallback-key");
  });
});

// ---------------------------------------------------------------------------
// voiceId default
// ---------------------------------------------------------------------------

describe("voiceId", () => {
  it("defaults to Kenn voice ID", () => {
    const cfg = build({});
    expect(cfg.voiceId).toBe(KENN_VOICE_ID);
  });

  it("is overridable via VOICE_GATEWAY_VOICE_ID", () => {
    const cfg = build({ VOICE_GATEWAY_VOICE_ID: "custom-voice-id" });
    expect(cfg.voiceId).toBe("custom-voice-id");
  });
});

// ---------------------------------------------------------------------------
// liveModel default
// ---------------------------------------------------------------------------

describe("liveModel", () => {
  it("defaults to gemini-3.1-flash-live-preview", () => {
    const cfg = build({});
    expect(cfg.liveModel).toBe(DEFAULT_LIVE_MODEL);
  });

  it("is overridable via VOICE_GATEWAY_LIVE_MODEL", () => {
    const cfg = build({ VOICE_GATEWAY_LIVE_MODEL: "gemini-2.0-flash-live-001" });
    expect(cfg.liveModel).toBe("gemini-2.0-flash-live-001");
  });
});

// ---------------------------------------------------------------------------
// output coercion
// ---------------------------------------------------------------------------

describe("output coercion", () => {
  it("defaults to cascade", () => {
    const cfg = build({});
    expect(cfg.output).toBe("cascade");
  });

  it("accepts native", () => {
    const cfg = build({ VOICE_GATEWAY_OUTPUT: "native" });
    expect(cfg.output).toBe("native");
  });

  it("coerces junk value to cascade", () => {
    const cfg = build({ VOICE_GATEWAY_OUTPUT: "invalid-value" });
    expect(cfg.output).toBe("cascade");
  });

  it("coerces empty string to cascade", () => {
    const cfg = build({ VOICE_GATEWAY_OUTPUT: "" });
    expect(cfg.output).toBe("cascade");
  });
});

// ---------------------------------------------------------------------------
// numeric defaults
// ---------------------------------------------------------------------------

describe("warmHoldMs", () => {
  it("defaults to 60000", () => {
    const cfg = build({});
    expect(cfg.warmHoldMs).toBe(60_000);
  });

  it("reads VOICE_GATEWAY_WARM_HOLD_MS", () => {
    const cfg = build({ VOICE_GATEWAY_WARM_HOLD_MS: "30000" });
    expect(cfg.warmHoldMs).toBe(30_000);
  });

  it("falls back to default on non-numeric value", () => {
    const cfg = build({ VOICE_GATEWAY_WARM_HOLD_MS: "nope" });
    expect(cfg.warmHoldMs).toBe(60_000);
  });

  it("falls back to default on float value", () => {
    const cfg = build({ VOICE_GATEWAY_WARM_HOLD_MS: "1.5" });
    expect(cfg.warmHoldMs).toBe(60_000);
  });
});

describe("idleTimeoutMs", () => {
  it("defaults to 300000", () => {
    const cfg = build({});
    expect(cfg.idleTimeoutMs).toBe(300_000);
  });

  it("reads VOICE_GATEWAY_IDLE_TIMEOUT_MS", () => {
    const cfg = build({ VOICE_GATEWAY_IDLE_TIMEOUT_MS: "120000" });
    expect(cfg.idleTimeoutMs).toBe(120_000);
  });

  it("falls back to default on non-numeric value", () => {
    const cfg = build({ VOICE_GATEWAY_IDLE_TIMEOUT_MS: "nope" });
    expect(cfg.idleTimeoutMs).toBe(300_000);
  });
});

// ---------------------------------------------------------------------------
// flywheelDir
// ---------------------------------------------------------------------------

describe("flywheelDir", () => {
  it("is null when no dataDir is provided", () => {
    const cfg = build({}, null);
    expect(cfg.flywheelDir).toBeNull();
  });

  it("defaults to <dataDir>/voice-flywheel when dataDir is provided", () => {
    const cfg = build({}, "/some/data/dir");
    expect(cfg.flywheelDir).toBe("/some/data/dir/voice-flywheel");
  });

  it("can be overridden via VOICE_GATEWAY_FLYWHEEL_DIR", () => {
    const cfg = build({ VOICE_GATEWAY_FLYWHEEL_DIR: "/custom/flywheel" }, "/some/data/dir");
    expect(cfg.flywheelDir).toBe("/custom/flywheel");
  });

  it("VOICE_GATEWAY_FLYWHEEL_DIR override works even without dataDir", () => {
    const cfg = build({ VOICE_GATEWAY_FLYWHEEL_DIR: "/explicit/flywheel" }, null);
    expect(cfg.flywheelDir).toBe("/explicit/flywheel");
  });
});

// ---------------------------------------------------------------------------
// isVoiceGatewayEnabled - enabled-iff rules
// ---------------------------------------------------------------------------

describe("isVoiceGatewayEnabled", () => {
  it("disabled when geminiApiKey is null", () => {
    const cfg = build({ ELEVENLABS_API_KEY: "el-key" });
    expect(cfg.geminiApiKey).toBeNull();
    expect(isVoiceGatewayEnabled(cfg)).toBe(false);
  });

  it("disabled when output is cascade and elevenlabsApiKey is null", () => {
    const cfg = build({ GEMINI_API_KEY: "gemini-key" });
    expect(cfg.output).toBe("cascade");
    expect(cfg.elevenlabsApiKey).toBeNull();
    expect(isVoiceGatewayEnabled(cfg)).toBe(false);
  });

  it("enabled when output is cascade and both keys are present", () => {
    const cfg = build({
      GEMINI_API_KEY: "gemini-key",
      ELEVENLABS_API_KEY: "el-key",
    });
    expect(isVoiceGatewayEnabled(cfg)).toBe(true);
  });

  it("enabled when output is native and only geminiApiKey is present", () => {
    const cfg = build({
      GEMINI_API_KEY: "gemini-key",
      VOICE_GATEWAY_OUTPUT: "native",
    });
    expect(cfg.elevenlabsApiKey).toBeNull();
    expect(isVoiceGatewayEnabled(cfg)).toBe(true);
  });

  it("disabled when output is native but geminiApiKey is null", () => {
    const cfg = build({ VOICE_GATEWAY_OUTPUT: "native" });
    expect(isVoiceGatewayEnabled(cfg)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// voiceGatewayDisabledReason
// ---------------------------------------------------------------------------

describe("voiceGatewayDisabledReason", () => {
  it("returns null when gateway is fully enabled (cascade + both keys)", () => {
    const cfg = build({
      GEMINI_API_KEY: "gemini-key",
      ELEVENLABS_API_KEY: "el-key",
    });
    expect(voiceGatewayDisabledReason(cfg)).toBeNull();
  });

  it("returns a reason when geminiApiKey is missing", () => {
    const cfg = build({ ELEVENLABS_API_KEY: "el-key" });
    const reason = voiceGatewayDisabledReason(cfg);
    expect(reason).not.toBeNull();
    expect(typeof reason).toBe("string");
    expect((reason as string).length).toBeGreaterThan(0);
  });

  it("returns a reason when cascade output but elevenlabsApiKey is missing", () => {
    const cfg = build({ GEMINI_API_KEY: "gemini-key" });
    expect(cfg.output).toBe("cascade");
    const reason = voiceGatewayDisabledReason(cfg);
    expect(reason).not.toBeNull();
    expect(typeof reason).toBe("string");
  });

  it("returns null when native output with only geminiApiKey present", () => {
    const cfg = build({
      GEMINI_API_KEY: "gemini-key",
      VOICE_GATEWAY_OUTPUT: "native",
    });
    expect(voiceGatewayDisabledReason(cfg)).toBeNull();
  });
});
