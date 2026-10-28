ALTER TABLE "approvals" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "action_policies_json" jsonb DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "consumed_at" timestamp;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "action_policies_json" jsonb DEFAULT '{}' NOT NULL;--> statement-breakpoint
CREATE INDEX "approvals_requester_action_idx" ON "approvals" USING btree ("company_id","requester_agent_id","action_type");