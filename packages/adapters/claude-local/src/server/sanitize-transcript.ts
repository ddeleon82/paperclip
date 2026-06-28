import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * FRE-1681: When a Claude Code session is resumed under a different model
 * provider than the one that wrote it (e.g. switching Anthropic <-> Kimi
 * (Moonshot) <-> GLM (Z.ai) mid-conversation), the replayed assistant
 * `thinking` blocks carry a provider-specific cryptographic `signature` that
 * the new provider rejects with HTTP 400
 * `messages.N.content.0: Invalid \`signature\` in \`thinking\` block`.
 *
 * Thinking blocks are not required on completed prior turns, so the safe fix is
 * to strip `thinking` / `redacted_thinking` blocks from the session transcript
 * before retrying the resume. This keeps all conversation text and tool history
 * intact while removing the un-validatable signatures, so the conversation can
 * continue across a provider switch instead of hard-failing.
 *
 * The session id is a UUID and unique across project dirs, so we locate the
 * transcript by globbing rather than reconstructing Claude Code's cwd encoding
 * (which is an internal detail that could change).
 *
 * Returns true when a transcript was found and at least one thinking block was
 * removed (i.e. a retry is worth attempting).
 */
export async function stripThinkingFromSessionTranscript(
  sessionId: string,
  options: { homeDir?: string } = {},
): Promise<boolean> {
  if (!sessionId.trim()) return false;

  const home = options.homeDir ?? os.homedir();
  const projectsDir = path.join(home, ".claude", "projects");

  const transcriptPath = await findTranscriptPath(projectsDir, sessionId);
  if (!transcriptPath) return false;

  let raw: string;
  try {
    raw = await fs.readFile(transcriptPath, "utf8");
  } catch {
    return false;
  }

  // Preserve a trailing newline if the original had one.
  const hadTrailingNewline = raw.endsWith("\n");
  const lines = raw.split("\n");
  let removedBlocks = 0;

  const rewritten: string[] = [];
  for (const line of lines) {
    if (!line.trim()) {
      rewritten.push(line);
      continue;
    }

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Leave malformed / non-JSON lines exactly as-is.
      rewritten.push(line);
      continue;
    }

    const message = event.message as { content?: unknown } | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) {
      rewritten.push(line);
      continue;
    }

    const filtered = content.filter((block) => {
      const type = (block as { type?: unknown } | null)?.type;
      return type !== "thinking" && type !== "redacted_thinking";
    });

    if (filtered.length === content.length) {
      rewritten.push(line);
      continue;
    }

    removedBlocks += content.length - filtered.length;

    if (filtered.length === 0) {
      // The assistant turn was thinking-only; drop the whole event so we don't
      // emit an empty `content` array (which the API also rejects). A
      // thinking-only turn has no tool_use, so this leaves no orphaned
      // tool_result behind.
      continue;
    }

    (message as { content: unknown[] }).content = filtered;
    rewritten.push(JSON.stringify(event));
  }

  if (removedBlocks === 0) return false;

  let output = rewritten.join("\n");
  if (hadTrailingNewline && !output.endsWith("\n")) output += "\n";

  // Atomic write: temp file + rename so a crash mid-write can't truncate the
  // transcript.
  const tmpPath = `${transcriptPath}.sanitize-${process.pid}.tmp`;
  await fs.writeFile(tmpPath, output, "utf8");
  await fs.rename(tmpPath, transcriptPath);

  return true;
}

async function findTranscriptPath(
  projectsDir: string,
  sessionId: string,
): Promise<string | undefined> {
  let entries: { name: string; isDirectory: () => boolean }[];
  try {
    entries = await fs.readdir(projectsDir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  const fileName = `${sessionId}.jsonl`;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(projectsDir, entry.name, fileName);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // not in this project dir; keep looking
    }
  }
  return undefined;
}
