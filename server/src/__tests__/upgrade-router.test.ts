import { describe, expect, it, vi } from "vitest";
import { createUpgradeRouter } from "../realtime/upgrade-router.js";

function fakeSocket() {
  return { write: vi.fn(), destroy: vi.fn() };
}

describe("upgrade router", () => {
  it("dispatches to the first handler whose matcher returns a match", () => {
    const router = createUpgradeRouter();
    const handler = vi.fn();
    router.register((pathname) => (pathname === "/api/voice/live" ? {} : null), handler);
    const socket = fakeSocket();
    router.handleUpgrade({ url: "/api/voice/live?x=1" } as never, socket as never, Buffer.alloc(0));
    expect(handler).toHaveBeenCalledOnce();
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  it("destroys sockets for unmatched paths", () => {
    const router = createUpgradeRouter();
    const socket = fakeSocket();
    router.handleUpgrade({ url: "/nope" } as never, socket as never, Buffer.alloc(0));
    expect(socket.destroy).toHaveBeenCalledOnce();
  });

  it("destroys sockets with missing url", () => {
    const router = createUpgradeRouter();
    const socket = fakeSocket();
    router.handleUpgrade({ url: undefined } as never, socket as never, Buffer.alloc(0));
    expect(socket.destroy).toHaveBeenCalledOnce();
  });

  it("passes match object and url to handler", () => {
    const router = createUpgradeRouter();
    const handler = vi.fn();
    router.register(
      (pathname) => {
        const m = pathname.match(/^\/api\/companies\/([^/]+)\/events\/ws$/);
        return m ? { companyId: m[1]! } : null;
      },
      handler,
    );
    const socket = fakeSocket();
    router.handleUpgrade(
      { url: "/api/companies/abc-123/events/ws?token=xyz" } as never,
      socket as never,
      Buffer.alloc(0),
    );
    expect(handler).toHaveBeenCalledOnce();
    const [, , , match, url] = handler.mock.calls[0]!;
    expect(match).toEqual({ companyId: "abc-123" });
    expect((url as URL).searchParams.get("token")).toBe("xyz");
  });

  it("dispatches to the first matching handler when multiple are registered", () => {
    const router = createUpgradeRouter();
    const h1 = vi.fn();
    const h2 = vi.fn();
    router.register((pathname) => (pathname === "/api/voice/live" ? { path: "voice" } : null), h1);
    router.register((pathname) => (pathname.startsWith("/api") ? { path: "api" } : null), h2);
    const socket = fakeSocket();
    router.handleUpgrade({ url: "/api/voice/live" } as never, socket as never, Buffer.alloc(0));
    expect(h1).toHaveBeenCalledOnce();
    expect(h2).not.toHaveBeenCalled();
  });

  it("falls through to second handler when first does not match", () => {
    const router = createUpgradeRouter();
    const h1 = vi.fn();
    const h2 = vi.fn();
    router.register((pathname) => (pathname === "/api/voice/live" ? {} : null), h1);
    router.register((pathname) => (pathname.startsWith("/api") ? {} : null), h2);
    const socket = fakeSocket();
    router.handleUpgrade(
      { url: "/api/companies/x/events/ws" } as never,
      socket as never,
      Buffer.alloc(0),
    );
    expect(h1).not.toHaveBeenCalled();
    expect(h2).toHaveBeenCalledOnce();
  });
});
