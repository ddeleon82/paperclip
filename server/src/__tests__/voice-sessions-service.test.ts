import { beforeEach, describe, expect, it, vi } from "vitest";
import { voiceSessionsService } from "../services/voice-sessions.js";

function makeDb(overrides: Record<string, unknown> = {}) {
  return {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "session-uuid-1" }]),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: "session-uuid-1" }]),
        }),
      }),
    }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
    ...overrides,
  };
}

describe("voiceSessionsService", () => {
  it("createSession inserts and returns id", async () => {
    const db = makeDb();
    const svc = voiceSessionsService(db as never);
    const res = await svc.createSession({ companyId: "co-1", userId: "u-1" });
    expect(res).toEqual({ id: "session-uuid-1" });
    expect(db.insert).toHaveBeenCalledOnce();
  });

  it("appendTurn updates with jsonb concat and throws notFound when row missing", async () => {
    const db = makeDb({
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    });
    const svc = voiceSessionsService(db as never);
    await expect(
      svc.appendTurn("missing-id", { role: "user", text: "hi", ts: new Date().toISOString() }),
    ).rejects.toThrow();
  });

  it("appendTurn succeeds when session exists", async () => {
    const db = makeDb();
    const svc = voiceSessionsService(db as never);
    await expect(
      svc.appendTurn("session-uuid-1", {
        role: "assistant",
        text: "hello",
        ts: new Date().toISOString(),
      }),
    ).resolves.toBeUndefined();
  });

  it("endSession is idempotent - empty returning array does not throw", async () => {
    const db = makeDb({
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    });
    const svc = voiceSessionsService(db as never);
    await expect(svc.endSession("already-ended")).resolves.toBeUndefined();
  });

  it("getSession returns null when no row found", async () => {
    const db = makeDb();
    const svc = voiceSessionsService(db as never);
    const res = await svc.getSession("missing");
    expect(res).toBeNull();
  });

  it("getSession returns the mapped row when found", async () => {
    const startedAt = new Date();
    const db = makeDb({
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                id: "s-1",
                companyId: "co-1",
                userId: "u-1",
                startedAt,
                endedAt: null,
                transcript: [{ role: "user", text: "hi", ts: "2026-05-24T00:00:00Z" }],
              },
            ]),
          }),
        }),
      }),
    });
    const svc = voiceSessionsService(db as never);
    const res = await svc.getSession("s-1");
    expect(res).toEqual({
      id: "s-1",
      companyId: "co-1",
      userId: "u-1",
      startedAt,
      endedAt: null,
      transcript: [{ role: "user", text: "hi", ts: "2026-05-24T00:00:00Z" }],
    });
  });
});
