import { pgTable, uuid, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export type VoiceTranscriptTurn = {
  role: "user" | "assistant" | "tool";
  text: string;
  ts: string; // ISO timestamp
  toolName?: string;
};

export const voiceSessions = pgTable(
  "voice_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    transcript: jsonb("transcript").$type<VoiceTranscriptTurn[]>().notNull().default([]),
  },
  (table) => ({
    companyStartedIdx: index("voice_sessions_company_started_idx").on(
      table.companyId,
      table.startedAt,
    ),
  }),
);
