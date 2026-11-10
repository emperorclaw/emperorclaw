-- Approval routing (0.32): each agent ask stores its resolved approver chain and
-- the current step; agents and companies get approval settings. All additive:
-- existing approvals keep approver_kind NULL and behave as before (owners and
-- admins notified, any member with access may decide).
--
-- The foreign keys lock agents (SHARE ROW EXCLUSIVE) until commit; the new
-- columns are all NULL, so validation is instant. lock_timeout makes the
-- migration fail fast instead of queueing writers; it is retried on the next start.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "approval_settings_json" jsonb DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "approver_kind" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "approver_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "approver_user_ids" jsonb;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "approver_chain_json" jsonb;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "escalation_level" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "escalated_at" timestamp;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "resolver_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "approval_settings_json" jsonb DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_approver_agent_id_agents_id_fk" FOREIGN KEY ("approver_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_resolver_agent_id_agents_id_fk" FOREIGN KEY ("resolver_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approvals_approver_agent_idx" ON "approvals" USING btree ("company_id","approver_agent_id","status") WHERE "approvals"."approver_agent_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "approvals_pending_routed_idx" ON "approvals" USING btree ("requested_at") WHERE "approvals"."status" = 'pending' AND "approvals"."approver_kind" IS NOT NULL;--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
