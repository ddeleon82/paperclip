import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { voiceSessionsRoutes } from "../routes/voice-sessions.js";
import { VOICE_SYSTEM_PROMPT } from "../services/voice-prompt.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const COMPANY_A = "company-a";
const COMPANY_B = "company-b";
const USER_ID = "user-1";

const mockVoiceSessionsService = vi.hoisted(() => ({
  createSession: vi.fn(),
  appendTurn: vi.fn(),
  endSession: vi.fn(),
  getSession: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  voiceSessionsService: () => mockVoiceSessionsService,
  heartbeatService: () => mockHeartbeatService,
  logActivity: vi.fn(async () => undefined),
}));

type ActorOverride = Partial<{
  type: "board" | "agent" | "none";
  userId: string;
  agentId: string;
  companyIds: string[];
  companyId: string;
  source: string;
  isInstanceAdmin: boolean;
}>;

function createApp(actor: ActorOverride = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: USER_ID,
      companyIds: [COMPANY_A],
      source: "local_implicit",
      isInstanceAdmin: false,
      ...actor,
    };
    next();
  });
  app.use("/api", voiceSessionsRoutes({} as any));
  app.use(errorHandler);
  return app;
}

function makeSession(overrides: Partial<{ companyId: string; endedAt: Date | null }> = {}) {
  return {
    id: SESSION_ID,
    companyId: COMPANY_A,
    userId: USER_ID,
    startedAt: new Date(),
    endedAt: null,
    transcript: [],
    ...overrides,
  };
}

describe("voice sessions routes (FRE-968)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("POST /api/voice/session", () => {
    it("creates a session and returns sessionId + agentId", async () => {
      mockVoiceSessionsService.createSession.mockResolvedValue({ id: SESSION_ID });

      const res = await request(createApp())
        .post("/api/voice/session")
        .send({ companyId: COMPANY_A, agentId: AGENT_ID });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ sessionId: SESSION_ID, agentId: AGENT_ID });
      expect(mockVoiceSessionsService.createSession).toHaveBeenCalledWith({
        companyId: COMPANY_A,
        userId: USER_ID,
      });
    });

    it("400s when agentId is missing", async () => {
      const res = await request(createApp())
        .post("/api/voice/session")
        .send({ companyId: COMPANY_A });
      // zod validation failure → errorHandler turns ZodError into 400.
      expect(res.status).toBe(400);
      expect(mockVoiceSessionsService.createSession).not.toHaveBeenCalled();
    });

    it("403s on cross-company creation", async () => {
      const res = await request(
        createApp({ companyIds: [COMPANY_B], isInstanceAdmin: false, source: "session" }),
      )
        .post("/api/voice/session")
        .send({ companyId: COMPANY_A, agentId: AGENT_ID });

      expect(res.status).toBe(403);
      expect(mockVoiceSessionsService.createSession).not.toHaveBeenCalled();
    });
  });

  describe("POST /api/voice/session/:id/turn", () => {
    it("persists the user turn and spawns a wakeup with voice context", async () => {
      mockVoiceSessionsService.getSession.mockResolvedValue(makeSession());
      mockVoiceSessionsService.appendTurn.mockResolvedValue(undefined);
      mockHeartbeatService.wakeup.mockResolvedValue({ id: "run-1" });

      const res = await request(createApp())
        .post(`/api/voice/session/${SESSION_ID}/turn`)
        .send({ transcript: "hello world", agentId: AGENT_ID });

      expect(res.status).toBe(202);
      expect(res.body).toEqual({ runId: "run-1" });

      expect(mockVoiceSessionsService.appendTurn).toHaveBeenCalledWith(
        SESSION_ID,
        expect.objectContaining({ role: "user", text: "hello world" }),
      );

      expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
      expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
        AGENT_ID,
        expect.objectContaining({
          source: "voice_session",
          reason: "voice_turn",
          payload: expect.objectContaining({
            transcript: "hello world",
            voiceSessionId: SESSION_ID,
          }),
          contextSnapshot: expect.objectContaining({
            voiceSessionId: SESSION_ID,
            voiceSystemPromptOverride: VOICE_SYSTEM_PROMPT,
          }),
          requestedByActorType: "user",
          requestedByActorId: USER_ID,
        }),
      );
    });

    it("404s when the session does not exist", async () => {
      mockVoiceSessionsService.getSession.mockResolvedValue(null);

      const res = await request(createApp())
        .post(`/api/voice/session/${SESSION_ID}/turn`)
        .send({ transcript: "hi", agentId: AGENT_ID });

      expect(res.status).toBe(404);
      expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    });

    it("returns 202 { status: skipped } when wakeup returns null", async () => {
      mockVoiceSessionsService.getSession.mockResolvedValue(makeSession());
      mockVoiceSessionsService.appendTurn.mockResolvedValue(undefined);
      mockHeartbeatService.wakeup.mockResolvedValue(null);

      const res = await request(createApp())
        .post(`/api/voice/session/${SESSION_ID}/turn`)
        .send({ transcript: "hi", agentId: AGENT_ID });

      expect(res.status).toBe(202);
      expect(res.body).toEqual({ status: "skipped" });
    });

    it("403s when the session belongs to a different company than the actor", async () => {
      mockVoiceSessionsService.getSession.mockResolvedValue(makeSession({ companyId: COMPANY_A }));

      const res = await request(
        createApp({ companyIds: [COMPANY_B], isInstanceAdmin: false, source: "session" }),
      )
        .post(`/api/voice/session/${SESSION_ID}/turn`)
        .send({ transcript: "hi", agentId: AGENT_ID });

      expect(res.status).toBe(403);
      expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    });
  });

  describe("DELETE /api/voice/session/:id", () => {
    it("ends the session and returns 204", async () => {
      mockVoiceSessionsService.getSession.mockResolvedValue(makeSession());
      mockVoiceSessionsService.endSession.mockResolvedValue(undefined);

      const res = await request(createApp())
        .delete(`/api/voice/session/${SESSION_ID}`);

      expect(res.status).toBe(204);
      expect(mockVoiceSessionsService.endSession).toHaveBeenCalledWith(SESSION_ID);
    });

    it("is idempotent — a second DELETE still returns 204", async () => {
      mockVoiceSessionsService.getSession.mockResolvedValue(
        makeSession({ endedAt: new Date() }),
      );
      mockVoiceSessionsService.endSession.mockResolvedValue(undefined);

      const res = await request(createApp())
        .delete(`/api/voice/session/${SESSION_ID}`);

      expect(res.status).toBe(204);
      expect(mockVoiceSessionsService.endSession).toHaveBeenCalledWith(SESSION_ID);
    });

    it("404s when the session does not exist", async () => {
      mockVoiceSessionsService.getSession.mockResolvedValue(null);

      const res = await request(createApp())
        .delete(`/api/voice/session/${SESSION_ID}`);

      expect(res.status).toBe(404);
      expect(mockVoiceSessionsService.endSession).not.toHaveBeenCalled();
    });
  });
});
