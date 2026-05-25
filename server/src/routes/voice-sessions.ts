import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import {
  heartbeatService,
  voiceSessionsService,
  logActivity,
} from "../services/index.js";
import { badRequest, notFound, unauthorized } from "../errors.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { VOICE_SYSTEM_PROMPT } from "../services/voice-prompt.js";

const createSessionSchema = z.object({
  companyId: z.string().min(1),
  agentId: z.string().min(1),
});

const turnSchema = z.object({
  transcript: z.string().min(1),
  agentId: z.string().min(1),
});

export function voiceSessionsRoutes(db: Db) {
  const router = Router();
  const sessions = voiceSessionsService(db);
  const heartbeat = heartbeatService(db);

  // POST /api/voice/session — create a new voice session.
  router.post("/voice/session", validate(createSessionSchema), async (req, res) => {
    const { companyId, agentId } = req.body as z.infer<typeof createSessionSchema>;
    assertCompanyAccess(req, companyId);

    if (req.actor.type === "none") {
      throw unauthorized();
    }
    const userId = req.actor.type === "agent" ? req.actor.agentId : req.actor.userId;
    if (!userId) {
      throw badRequest("Actor is missing a user id");
    }

    const { id } = await sessions.createSession({ companyId, userId });

    await logActivity(db, {
      companyId,
      actorType: req.actor.type === "agent" ? "agent" : "user",
      actorId: userId,
      action: "voice.session_created",
      entityType: "voice_session",
      entityId: id,
      details: { agentId },
    });

    res.status(200).json({ sessionId: id, agentId });
  });

  // POST /api/voice/session/:id/turn — append a user turn and spawn an agent run.
  router.post("/voice/session/:id/turn", validate(turnSchema), async (req, res) => {
    const sessionId = req.params.id as string;
    const { transcript, agentId } = req.body as z.infer<typeof turnSchema>;

    const session = await sessions.getSession(sessionId);
    if (!session) {
      throw notFound(`voice_session not found: ${sessionId}`);
    }
    assertCompanyAccess(req, session.companyId);

    await sessions.appendTurn(sessionId, {
      role: "user",
      text: transcript,
      ts: new Date().toISOString(),
    });

    if (req.actor.type === "none") {
      throw unauthorized();
    }

    const requestedByActorType = req.actor.type === "agent" ? "agent" : "user";
    const requestedByActorId =
      req.actor.type === "agent" ? req.actor.agentId ?? null : req.actor.userId ?? null;

    const run = await heartbeat.wakeup(agentId, {
      source: "voice_session",
      triggerDetail: "system",
      reason: "voice_turn",
      payload: { transcript, voiceSessionId: sessionId },
      requestedByActorType,
      requestedByActorId,
      contextSnapshot: {
        voiceSessionId: sessionId,
        voiceSystemPromptOverride: VOICE_SYSTEM_PROMPT,
      },
    });

    if (!run) {
      res.status(202).json({ status: "skipped" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: session.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "voice.turn_invoked",
      entityType: "heartbeat_run",
      entityId: run.id,
      details: { agentId, voiceSessionId: sessionId },
    });

    res.status(202).json({ runId: run.id });
  });

  // DELETE /api/voice/session/:id — end a voice session (idempotent).
  router.delete("/voice/session/:id", async (req, res) => {
    const sessionId = req.params.id as string;
    const session = await sessions.getSession(sessionId);
    if (!session) {
      throw notFound(`voice_session not found: ${sessionId}`);
    }
    assertCompanyAccess(req, session.companyId);

    await sessions.endSession(sessionId);
    res.status(204).send();
  });

  return router;
}
