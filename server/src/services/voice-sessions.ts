import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { voiceSessions, type VoiceTranscriptTurn } from "@paperclipai/db";
import { notFound } from "../errors.js";

export interface VoiceSessionsService {
  createSession(input: { companyId: string; userId: string }): Promise<{ id: string }>;
  appendTurn(sessionId: string, turn: VoiceTranscriptTurn): Promise<void>;
  endSession(sessionId: string): Promise<void>;
  getSession(sessionId: string): Promise<{
    id: string;
    companyId: string;
    userId: string;
    startedAt: Date;
    endedAt: Date | null;
    transcript: VoiceTranscriptTurn[];
  } | null>;
}

export function voiceSessionsService(db: Db): VoiceSessionsService {
  return {
    async createSession({ companyId, userId }) {
      const [row] = await db
        .insert(voiceSessions)
        .values({ companyId, userId })
        .returning({ id: voiceSessions.id });
      if (!row) throw new Error("voiceSessions: insert returned no row");
      return { id: row.id };
    },

    async appendTurn(sessionId, turn) {
      // Append to the JSONB array atomically with `transcript || jsonb_build_array(...)`.
      // This avoids a read-modify-write race when multiple turn handlers race for the
      // same session (rare in a single-user voice tab but worth doing correctly).
      const turnJson = JSON.stringify(turn);
      const result = await db
        .update(voiceSessions)
        .set({
          transcript: sql`${voiceSessions.transcript} || ${turnJson}::jsonb`,
        })
        .where(eq(voiceSessions.id, sessionId))
        .returning({ id: voiceSessions.id });
      if (result.length === 0) {
        throw notFound(`voice_session not found: ${sessionId}`);
      }
    },

    async endSession(sessionId) {
      const result = await db
        .update(voiceSessions)
        .set({ endedAt: new Date() })
        .where(and(eq(voiceSessions.id, sessionId), sql`${voiceSessions.endedAt} IS NULL`))
        .returning({ id: voiceSessions.id });
      // Idempotent: if already ended, no-op (no row returned, no throw).
      void result;
    },

    async getSession(sessionId) {
      const rows = await db
        .select()
        .from(voiceSessions)
        .where(eq(voiceSessions.id, sessionId))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id,
        companyId: row.companyId,
        userId: row.userId,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        transcript: (row.transcript ?? []) as VoiceTranscriptTurn[],
      };
    },
  };
}
