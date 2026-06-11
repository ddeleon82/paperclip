/**
 * Server-side port of the UI's fetchFinalAssistantText (FRE-1296).
 *
 * Extracts the last assistant text block from a stream-json run log so the
 * gateway can speak the outcome aloud via TTS. The result envelope
 * (type === "result") is intentionally skipped -- it must never be spoken
 * directly (regression: c904ad24).
 */

// ---------------------------------------------------------------------------
// Pure log parsing
// ---------------------------------------------------------------------------

/** Light markdown strip identical to the UI version. */
function stripMarkdownForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]*)\*\*/g, "$1")
    .replace(/\*([^*]*)\*/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract speakable assistant text from a single stream-json subline.
 * Returns null for result envelopes, tool-use-only blocks, and non-text lines.
 */
function extractAssistantText(subline: string): string | null {
  let evt: unknown;
  try {
    evt = JSON.parse(subline);
  } catch {
    return null;
  }
  if (!evt || typeof evt !== "object") return null;
  const e = evt as Record<string, unknown>;

  // Skip result envelope - never speak it aloud (c904ad24 regression)
  if (e.type === "result") return null;

  if (e.type === "assistant") {
    const msg = e.message as Record<string, unknown> | undefined;
    const content = Array.isArray(msg?.content) ? (msg.content as unknown[]) : [];
    const text = content
      .filter(
        (b): b is { type: "text"; text: string } =>
          typeof b === "object" &&
          b !== null &&
          (b as Record<string, unknown>).type === "text" &&
          typeof (b as Record<string, unknown>).text === "string",
      )
      .map((b) => b.text)
      .join(" ")
      .trim();
    return text || null;
  }

  return null;
}

/**
 * Walks a complete run log (NDJSON content string) backward to find the last
 * spoken assistant text. Returns null when no speakable text is found.
 */
export function extractFinalAssistantText(logContent: string): string | null {
  if (!logContent.trim()) return null;

  const lines = logContent.split("\n");

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;

    let outer: unknown;
    try {
      outer = JSON.parse(line);
    } catch {
      continue;
    }

    if (
      !outer ||
      typeof outer !== "object" ||
      (outer as Record<string, unknown>).stream !== "stdout"
    ) {
      continue;
    }

    const chunk = (outer as Record<string, unknown>).chunk;
    if (typeof chunk !== "string") continue;

    // Walk sublines of this chunk backward
    const sublines = chunk.split("\n");
    for (let j = sublines.length - 1; j >= 0; j--) {
      const sub = sublines[j].trim();
      if (!sub) continue;
      const text = extractAssistantText(sub);
      if (text) return stripMarkdownForSpeech(text);
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Factory for injection into GatewaySession
// ---------------------------------------------------------------------------

const FALLBACK_OUTCOME = "Run finished but no spoken summary was found.";

/**
 * Creates an `extractRunOutcome` dep backed by the heartbeat service's readLog.
 * Falls back to FALLBACK_OUTCOME when no text is found or on errors.
 */
export function makeExtractRunOutcome(heartbeat: {
  readLog(
    runId: string,
    opts?: { offset?: number; limitBytes?: number },
  ): Promise<{ content: string | null }>;
}): (runId: string) => Promise<string> {
  return async (runId: string): Promise<string> => {
    try {
      const result = await heartbeat.readLog(runId, { offset: 0, limitBytes: 256_000 });
      if (!result.content) return FALLBACK_OUTCOME;
      return extractFinalAssistantText(result.content) ?? FALLBACK_OUTCOME;
    } catch {
      return FALLBACK_OUTCOME;
    }
  };
}
