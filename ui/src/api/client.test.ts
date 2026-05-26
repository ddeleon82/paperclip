// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "./client";

describe("api client request headers", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as unknown as Response));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Regression for FRE-968: voice-tagged POSTs were silently dropping
  // Content-Type because the request() function spread `init` AFTER the
  // merged Headers, letting init.headers (a plain object containing only
  // `x-paperclip-origin: voice`) replace the merged Headers instance.
  // Server then failed to parse the JSON body → comment never persisted →
  // auto-send appeared "broken within issues" to the user.
  // ---------------------------------------------------------------------------
  it("preserves Content-Type when callers pass extra headers on POST", async () => {
    await api.post("/issues/abc/comments", { body: "hi" }, { "x-paperclip-origin": "voice" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers;
    expect(headers).toBeInstanceOf(Headers);
    const h = headers as Headers;
    expect(h.get("Content-Type")).toBe("application/json");
    expect(h.get("x-paperclip-origin")).toBe("voice");
  });

  it("still sets Content-Type for POSTs without extra headers", async () => {
    await api.post("/issues/abc/comments", { body: "hi" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Headers;
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("preserves Content-Type when callers pass extra headers on PATCH", async () => {
    await api.patch("/issues/abc", { reopen: true }, { "x-paperclip-origin": "voice" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Headers;
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("x-paperclip-origin")).toBe("voice");
  });
});
