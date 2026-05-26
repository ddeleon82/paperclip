-- FRE-968: voice_sessions.user_id was declared as uuid in 0057, but Paperclip
-- auth user ids are Clerk-style text identifiers (e.g. "9GaJkYEpdTOpfOiMCh6YywXAQRE2RxKs").
-- All other *_user_id columns in this schema are `text`. Insert attempts to
-- POST /api/voice/session failed with "invalid input syntax for type uuid".
-- Switch the column to text to match the rest of the schema.
ALTER TABLE "voice_sessions"
  ALTER COLUMN "user_id" TYPE text USING "user_id"::text;
