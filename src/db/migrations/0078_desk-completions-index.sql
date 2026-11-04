-- A pre-release build of this migration indexed tasks instead; drop it where it was applied.
DROP INDEX IF EXISTS "tasks_agent_last_done_idx";--> statement-breakpoint
CREATE INDEX "task_events_completed_idx" ON "task_events" USING btree ("company_id","created_at") WHERE "task_events"."event_type" = 'task_done' OR ("task_events"."event_type" IN ('task_updated', 'task_reassigned') AND "task_events"."payload_json" ->> 'state' = 'done');
