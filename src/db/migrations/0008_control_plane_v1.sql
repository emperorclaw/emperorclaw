ALTER TABLE "projects" ADD COLUMN "lead_agent_id" uuid;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "require_approval_for_done" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "require_review_before_done" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "comment_required_for_review" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "block_status_changes_with_pending_approval" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "only_lead_can_change_status" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "max_active_agents" integer DEFAULT 3 NOT NULL;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_lead_agent_id_agents_id_fk" FOREIGN KEY ("lead_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "last_heartbeat_at" timestamp;
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "checkin_deadline_at" timestamp;
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "last_wake_at" timestamp;
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "wake_attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "max_wake_attempts" integer DEFAULT 3 NOT NULL;
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "lifecycle_generation" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "last_provision_error" text;
--> statement-breakpoint
CREATE TABLE "recurring_task_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_by_agent_id" uuid,
	"name" text NOT NULL,
	"task_type" text NOT NULL,
	"cron_expression" text,
	"payload_json" jsonb DEFAULT '{}' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"proof_required" boolean DEFAULT false NOT NULL,
	"human_approval_required" boolean DEFAULT false NOT NULL,
	"proof_types_json" jsonb DEFAULT '[]' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_spawned_task_id" uuid,
	"last_run_at" timestamp,
	"next_run_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "recurring_task_definitions" ADD CONSTRAINT "recurring_task_definitions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "recurring_task_definitions" ADD CONSTRAINT "recurring_task_definitions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "recurring_task_definitions" ADD CONSTRAINT "recurring_task_definitions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "recurring_task_definition_id" uuid;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "task_kind" text DEFAULT 'standard' NOT NULL;
--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "state" SET DEFAULT 'inbox';
--> statement-breakpoint
UPDATE "tasks" SET "state" = 'inbox' WHERE "state" = 'queued';
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_recurring_task_definition_id_recurring_task_definitions_id_fk" FOREIGN KEY ("recurring_task_definition_id") REFERENCES "public"."recurring_task_definitions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"requester_agent_id" uuid,
	"resolver_user_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"action_type" text DEFAULT 'task_done' NOT NULL,
	"rationale" text,
	"resolution_note" text,
	"confidence" integer DEFAULT 0 NOT NULL,
	"metadata_json" jsonb DEFAULT '{}' NOT NULL,
	"requested_at" timestamp DEFAULT now() NOT NULL,
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_task_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"approval_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_requester_agent_id_agents_id_fk" FOREIGN KEY ("requester_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_resolver_user_id_users_id_fk" FOREIGN KEY ("resolver_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "approval_task_links" ADD CONSTRAINT "approval_task_links_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "approval_task_links" ADD CONSTRAINT "approval_task_links_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "approval_task_links" ADD CONSTRAINT "approval_task_links_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
