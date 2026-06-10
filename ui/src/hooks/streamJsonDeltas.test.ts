import { describe, expect, it } from "vitest";
import { createDeltaExtractor } from "./streamJsonDeltas";

const line = (o: unknown) => JSON.stringify(o) + "\n";

describe("stream-json delta extractor", () => {
  it("extracts assistant text from content_block_delta events across chunk boundaries", () => {
    const ex = createDeltaExtractor();
    const full = line({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello " } },
    });
    // Split mid-line to simulate WS chunking.
    const a = ex.push(full.slice(0, 25));
    const b = ex.push(full.slice(25));
    expect(a.join("") + b.join("")).toBe("Hello ");
  });

  it("ignores non-text events and unparseable lines", () => {
    const ex = createDeltaExtractor();
    const out = ex.push(
      line({ type: "stream_event", event: { type: "content_block_start" } }) +
        "not json at all\n" +
        line({ type: "result", result: "final envelope, not a delta" }),
    );
    expect(out).toEqual([]);
  });

  it("also accepts assistant message text blocks (non-streaming runs)", () => {
    const ex = createDeltaExtractor();
    const out = ex.push(
      line({
        type: "assistant",
        message: { content: [{ type: "text", text: "Full block." }] },
      }),
    );
    expect(out).toEqual(["Full block."]);
  });
});
