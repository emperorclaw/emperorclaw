-- Migration 0034: let one task be assigned to either an agent or a human.
--
-- Existing installations keep every assigned_agent_id unchanged. The new
-- member column starts nullable, so this migration requires no data rewrite
-- and older MCP clients can continue using assignedAgentId.

ALTER TABLE "tasks" ADD COLUMN "assigned_member_id" uuid;
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assigned_member_id_company_members_id_fk"
  FOREIGN KEY ("assigned_member_id") REFERENCES "public"."company_members"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_single_assignee"
  CHECK ("assigned_agent_id" IS NULL OR "assigned_member_id" IS NULL);
--> statement-breakpoint
CREATE INDEX "tasks_assigned_member_idx" ON "tasks" USING btree ("company_id", "assigned_member_id");
