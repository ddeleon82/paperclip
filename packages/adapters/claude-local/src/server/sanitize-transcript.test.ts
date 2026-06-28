import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stripThinkingFromSessionTranscript } from "./sanitize-transcript.js";

let homeDir: string;
let projectDir: string;
const sessionId = "11111111-2222-3333-4444-555555555555";

async function writeTranscript(lines: object[]): Promise<string> {
  const file = path.join(projectDir, `${sessionId}.jsonl`);
  await fs.writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  return file;
}

async function readTranscript(file: string): Promise<Record<string, unknown>[]> {
  const raw = await fs.readFile(file, "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

beforeEach(async () => {
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "hf-sanitize-"));
  projectDir = path.join(homeDir, ".claude", "projects", "-home-deploy-work");
  await fs.mkdir(projectDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(homeDir, { recursive: true, force: true });
});

describe("stripThinkingFromSessionTranscript", () => {
  it("removes thinking blocks but keeps text/tool_use in mixed assistant turns", async () => {
    const file = await writeTranscript([
      { type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "secret reasoning", signature: "kimi-sig-abc" },
            { type: "text", text: "Hello!" },
            { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
          ],
        },
      },
    ]);

    const changed = await stripThinkingFromSessionTranscript(sessionId, { homeDir });
    expect(changed).toBe(true);

    const events = await readTranscript(file);
    expect(events).toHaveLength(2);
    const assistant = events[1].message as { content: { type: string }[] };
    expect(assistant.content.map((b) => b.type)).toEqual(["text", "tool_use"]);
  });

  it("drops a thinking-only assistant turn rather than leaving empty content", async () => {
    const file = await writeTranscript([
      { type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "lone", signature: "sig" }],
        },
      },
      { type: "user", message: { role: "user", content: [{ type: "text", text: "again" }] } },
    ]);

    const changed = await stripThinkingFromSessionTranscript(sessionId, { homeDir });
    expect(changed).toBe(true);

    const events = await readTranscript(file);
    expect(events).toHaveLength(2);
    expect(events.every((e) => (e.message as { role: string }).role === "user")).toBe(true);
  });

  it("also strips redacted_thinking blocks", async () => {
    const file = await writeTranscript([
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "redacted_thinking", data: "xxxx" },
            { type: "text", text: "ok" },
          ],
        },
      },
    ]);

    expect(await stripThinkingFromSessionTranscript(sessionId, { homeDir })).toBe(true);
    const events = await readTranscript(file);
    const assistant = events[0].message as { content: { type: string }[] };
    expect(assistant.content.map((b) => b.type)).toEqual(["text"]);
  });

  it("returns false (no rewrite) when there are no thinking blocks", async () => {
    await writeTranscript([
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "no thinking here" }] },
      },
    ]);
    expect(await stripThinkingFromSessionTranscript(sessionId, { homeDir })).toBe(false);
  });

  it("returns false when the session transcript does not exist", async () => {
    expect(await stripThinkingFromSessionTranscript("does-not-exist", { homeDir })).toBe(false);
  });

  it("leaves malformed JSON lines untouched", async () => {
    const file = path.join(projectDir, `${sessionId}.jsonl`);
    await fs.writeFile(
      file,
      "not json\n" +
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "thinking", thinking: "x", signature: "s" }, { type: "text", text: "y" }] },
        }) +
        "\n",
      "utf8",
    );
    expect(await stripThinkingFromSessionTranscript(sessionId, { homeDir })).toBe(true);
    const raw = await fs.readFile(file, "utf8");
    expect(raw.startsWith("not json\n")).toBe(true);
    expect(raw).not.toContain("thinking");
  });
});
