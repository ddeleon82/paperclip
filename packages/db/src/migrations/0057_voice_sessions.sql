CREATE TABLE IF NOT EXISTS "voice_sessions" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id"   uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "user_id"      uuid NOT NULL,
  "started_at"   timestamptz NOT NULL DEFAULT now(),
  "ended_at"     timestamptz,
  "transcript"   jsonb NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS "voice_sessions_company_started_idx"
  ON "voice_sessions" ("company_id", "started_at");
