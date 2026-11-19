ALTER TABLE "tasks" ADD COLUMN "lease_session" text;
--> statement-breakpoint
-- lease_owner used to hold the session id; it now holds the agent id, so a live
-- lease from before this change names something that is not an agent. Release
-- them: a session that still wants the task claims or renews it again.
UPDATE "tasks" SET "lease_owner" = NULL, "lease_until" = NULL WHERE "lease_owner" IS NOT NULL;
