-- Cost brake (0.30.0) query indexes: a task's events and a2a runs over the
-- brake window, and the shadow decisions in ops_events (dedupe + chatter report).
--
-- The drizzle migrator runs every pending migration in one transaction, so
-- these cannot be built CONCURRENTLY. Each build holds a SHARE lock (writes to
-- the table wait for the build); lock_timeout makes the migration fail fast
-- instead of queueing every writer behind a long-running transaction. A
-- failed migration rolls back whole and is retried on the next start.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runs_company_task_started_idx" ON "agent_runs" USING btree ("company_id","task_id","started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ops_events_cost_brake_dedupe_idx" ON "ops_events" USING btree ("company_id",("metadata_json" ->> 'dedupeKey')) WHERE "ops_events"."category" = 'cost_brake';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ops_events_cost_brake_created_idx" ON "ops_events" USING btree ("company_id","created_at") WHERE "ops_events"."category" = 'cost_brake';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_events_company_task_created_idx" ON "task_events" USING btree ("company_id","task_id","created_at");--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
