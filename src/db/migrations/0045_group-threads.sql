-- Migration 0045: group threads.
-- A group is a message thread (type = 'group') whose agent participants are
-- the only agents that receive it. Additive only: team and direct threads are
-- untouched. Participant uniqueness (one row per member) is already enforced
-- by migration 0032's partial unique indexes, which group membership relies on.

-- The group's purpose, shown to members and handed to agents every turn.
ALTER TABLE "message_threads" ADD COLUMN IF NOT EXISTS "description" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_threads_company_type_idx"
  ON "message_threads" ("company_id", "type");
