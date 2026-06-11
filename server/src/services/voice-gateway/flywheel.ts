// JSONL training-data flywheel logger (FRE-1296).
// Appends one JSON line per entry to <dir>/YYYY-MM-DD.jsonl (UTC date from
// entry.ts).  dir === null makes log() a no-op.  mkdir is done recursively on
// first write.  Append failures are caught and logged at warn level — the
// flywheel must never break a live call.

import fs from "node:fs";
import path from "node:path";

export interface FlywheelEntry {
  ts: string; // ISO 8601
  sessionId: string;
  userId: string;
  kind:
    | "user_turn"
    | "assistant_turn"
    | "tool_call"
    | "tool_result"
    | "interrupt"
    | "run_complete";
  text?: string;
  tool?: string;
  data?: Record<string, unknown>;
}

export function createFlywheelLogger(
  dir: string | null,
): { log(entry: FlywheelEntry): void } {
  if (dir === null) {
    return { log() { /* no-op */ } };
  }

  let dirEnsured = false;

  function ensureDir(): void {
    if (dirEnsured) return;
    fs.mkdirSync(dir!, { recursive: true });
    dirEnsured = true;
  }

  function utcDateStr(ts: string): string {
    const d = new Date(ts);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  return {
    log(entry: FlywheelEntry): void {
      try {
        ensureDir();
        const dateStr = utcDateStr(entry.ts);
        const filePath = path.join(dir!, `${dateStr}.jsonl`);
        const line = JSON.stringify(entry) + "\n";
        fs.appendFileSync(filePath, line, "utf8");
      } catch (err) {
        console.warn("[flywheel] failed to append log entry", { err, entry });
      }
    },
  };
}
