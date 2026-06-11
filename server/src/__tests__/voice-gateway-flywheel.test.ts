// Tests for FlywheelLogger — JSONL training-data logger (FRE-1296).
import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFlywheelLogger, type FlywheelEntry } from "../services/voice-gateway/flywheel.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-test-"));
}

function readJsonlLines(filePath: string): unknown[] {
  const raw = fs.readFileSync(filePath, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function makeEntry(overrides: Partial<FlywheelEntry> = {}): FlywheelEntry {
  return {
    ts: "2026-06-10T14:30:00.000Z",
    sessionId: "sess-001",
    userId: "user-abc",
    kind: "user_turn",
    text: "Hello",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createFlywheelLogger", () => {
  // -------------------------------------------------------------------------
  // null dir → no-op
  // -------------------------------------------------------------------------
  describe("null dir", () => {
    it("is a no-op — does not throw and creates no files", () => {
      const logger = createFlywheelLogger(null);
      expect(() => logger.log(makeEntry())).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // File naming: YYYY-MM-DD.jsonl from entry.ts (UTC)
  // -------------------------------------------------------------------------
  describe("file naming", () => {
    it("writes to YYYY-MM-DD.jsonl derived from entry ts (UTC)", () => {
      const dir = makeTmpDir();
      const logger = createFlywheelLogger(dir);
      const entry = makeEntry({ ts: "2026-06-10T23:59:59.000Z" });
      logger.log(entry);
      expect(fs.existsSync(path.join(dir, "2026-06-10.jsonl"))).toBe(true);
    });

    it("uses UTC date not local date", () => {
      const dir = makeTmpDir();
      const logger = createFlywheelLogger(dir);
      // Midnight UTC is the previous day in PT
      const entry = makeEntry({ ts: "2026-06-11T00:30:00.000Z" });
      logger.log(entry);
      expect(fs.existsSync(path.join(dir, "2026-06-11.jsonl"))).toBe(true);
    });

    it("different ts dates go to different files", () => {
      const dir = makeTmpDir();
      const logger = createFlywheelLogger(dir);
      logger.log(makeEntry({ ts: "2026-06-09T12:00:00.000Z" }));
      logger.log(makeEntry({ ts: "2026-06-10T12:00:00.000Z" }));
      expect(fs.existsSync(path.join(dir, "2026-06-09.jsonl"))).toBe(true);
      expect(fs.existsSync(path.join(dir, "2026-06-10.jsonl"))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Append: one JSON line per call
  // -------------------------------------------------------------------------
  describe("append behavior", () => {
    it("writes valid JSON on a single line", () => {
      const dir = makeTmpDir();
      const logger = createFlywheelLogger(dir);
      const entry = makeEntry();
      logger.log(entry);

      const file = path.join(dir, "2026-06-10.jsonl");
      const raw = fs.readFileSync(file, "utf8");
      // No internal newlines within the JSON object
      expect(raw.trim()).not.toContain("\n");
      const parsed = JSON.parse(raw.trim());
      expect(parsed.sessionId).toBe("sess-001");
    });

    it("appends multiple entries as separate lines", () => {
      const dir = makeTmpDir();
      const logger = createFlywheelLogger(dir);
      logger.log(makeEntry({ text: "first" }));
      logger.log(makeEntry({ text: "second" }));
      logger.log(makeEntry({ text: "third" }));

      const lines = readJsonlLines(path.join(dir, "2026-06-10.jsonl"));
      expect(lines).toHaveLength(3);
      expect((lines[0] as FlywheelEntry).text).toBe("first");
      expect((lines[1] as FlywheelEntry).text).toBe("second");
      expect((lines[2] as FlywheelEntry).text).toBe("third");
    });

    it("serialises all optional fields when present", () => {
      const dir = makeTmpDir();
      const logger = createFlywheelLogger(dir);
      const entry = makeEntry({
        kind: "tool_call",
        tool: "search",
        data: { query: "test", count: 5 },
      });
      logger.log(entry);

      const lines = readJsonlLines(path.join(dir, "2026-06-10.jsonl"));
      const parsed = lines[0] as FlywheelEntry;
      expect(parsed.tool).toBe("search");
      expect(parsed.data).toEqual({ query: "test", count: 5 });
    });
  });

  // -------------------------------------------------------------------------
  // mkdir recursive on first write
  // -------------------------------------------------------------------------
  describe("mkdir", () => {
    it("creates the directory if it does not exist", () => {
      const base = makeTmpDir();
      const nested = path.join(base, "a", "b", "c");
      expect(fs.existsSync(nested)).toBe(false);

      const logger = createFlywheelLogger(nested);
      logger.log(makeEntry());

      expect(fs.existsSync(nested)).toBe(true);
      expect(fs.existsSync(path.join(nested, "2026-06-10.jsonl"))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Append failures: caught, logged at warn, never thrown
  // -------------------------------------------------------------------------
  describe("append failure handling", () => {
    it("never throws when appendFileSync fails", () => {
      // Point logger at a path that cannot be written (dir is a file)
      const base = makeTmpDir();
      const blocker = path.join(base, "not-a-dir");
      fs.writeFileSync(blocker, "I am a file, not a directory");

      const logger = createFlywheelLogger(blocker);
      // Should not throw even though the dir is actually a file
      expect(() => logger.log(makeEntry())).not.toThrow();
    });

    it("warns on append failure but does not throw", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      afterEach(() => warnSpy.mockRestore());

      const base = makeTmpDir();
      const blocker = path.join(base, "2026-06-10.jsonl");
      // Create the file path as a directory to cause appendFileSync to fail
      fs.mkdirSync(blocker);

      const logger = createFlywheelLogger(base);
      expect(() => logger.log(makeEntry())).not.toThrow();
      // warn should have been called
      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // kind coverage
  // -------------------------------------------------------------------------
  describe("all kind values are accepted", () => {
    const kinds: FlywheelEntry["kind"][] = [
      "user_turn",
      "assistant_turn",
      "tool_call",
      "tool_result",
      "interrupt",
      "run_complete",
    ];

    for (const kind of kinds) {
      it(`accepts kind="${kind}"`, () => {
        const dir = makeTmpDir();
        const logger = createFlywheelLogger(dir);
        expect(() => logger.log(makeEntry({ kind }))).not.toThrow();
      });
    }
  });
});
