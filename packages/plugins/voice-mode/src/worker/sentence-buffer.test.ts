import { describe, it, expect } from "vitest";
import { splitIntoSentences } from "./sentence-buffer.js";

describe("splitIntoSentences", () => {
  it("emits a sentence once terminal punctuation arrives with trailing space", () => {
    const buf = splitIntoSentences();
    expect(buf.push("Hello")).toEqual([]);
    expect(buf.push(", Dom. ")).toEqual(["Hello, Dom."]);
  });

  it("emits multiple sentences in order", () => {
    const buf = splitIntoSentences();
    const out = buf.push("First. Second! Third? ");
    expect(out).toEqual(["First.", " Second!", " Third?"]);
  });

  it("keeps decimals intact", () => {
    const buf = splitIntoSentences();
    expect(buf.push("Pi is 3.14 roughly. ")).toEqual(["Pi is 3.14 roughly."]);
  });

  it("buffers an incomplete sentence until the terminator arrives", () => {
    const buf = splitIntoSentences();
    expect(buf.push("incomplete")).toEqual([]);
    expect(buf.push(" tail. ")).toEqual(["incomplete tail."]);
  });

  it("flushes any tail on close", () => {
    const buf = splitIntoSentences();
    buf.push("no terminator");
    expect(buf.flush()).toEqual(["no terminator"]);
  });

  it("returns empty array from flush when buffer is empty or whitespace-only", () => {
    const buf = splitIntoSentences();
    expect(buf.flush()).toEqual([]);
    buf.push("   ");
    expect(buf.flush()).toEqual([]);
  });
});
