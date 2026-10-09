CREATE TABLE IF NOT EXISTS "agent_objectives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"created_by_user_id" uuid,
	"thread_id" uuid,
	"objective" text NOT NULL,
	"cadence_minutes" integer DEFAULT 60 NOT NULL,
	"max_followups" integer DEFAULT 20 NOT NULL,
	"followup_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"blocker_reason" text,
	"completion_summary" text,
	"last_prompt_at" timestamp,
	"last_reported_at" timestamp,
	"next_run_at" timestamp,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "agent_objectives" ADD CONSTRAINT "agent_objectives_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_objectives" ADD CONSTRAINT "agent_objectives_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_objectives" ADD CONSTRAINT "agent_objectives_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_objectives" ADD CONSTRAINT "agent_objectives_thread_id_message_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."message_threads"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_objectives_due_idx" ON "agent_objectives" ("company_id","status","next_run_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_objectives_agent_idx" ON "agent_objectives" ("agent_id","status");
