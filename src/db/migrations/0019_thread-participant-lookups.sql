CREATE INDEX IF NOT EXISTS "thread_participants_agent_lookup_idx"
ON "thread_participants" ("company_id", "participant_type", "participant_id", "thread_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "thread_participants_human_lookup_idx"
ON "thread_participants" ("company_id", "participant_type", "participant_ref", "thread_id");
