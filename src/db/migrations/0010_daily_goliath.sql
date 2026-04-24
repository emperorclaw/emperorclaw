CREATE TABLE IF NOT EXISTS "approval_task_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"approval_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "approvals" (
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
CREATE TABLE IF NOT EXISTS "project_agent_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"role_type" text DEFAULT 'worker' NOT NULL,
	"display_name" text,
	"signature" text,
	"memory_seed" text,
	"resource_policy_json" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "recurring_task_definitions" (
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
CREATE TABLE IF NOT EXISTS "resource_access_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	"agent_id" uuid,
	"session_id" uuid,
	"task_id" uuid,
	"action" text DEFAULT 'lease' NOT NULL,
	"status" text DEFAULT 'success' NOT NULL,
	"reason" text,
	"metadata_json" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scoped_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" uuid,
	"provider" text NOT NULL,
	"resource_type" text NOT NULL,
	"name" text NOT NULL,
	"display_name" text,
	"config_text" text DEFAULT '' NOT NULL,
	"secret_text" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"is_shared" boolean DEFAULT false NOT NULL,
	"ownership" text DEFAULT 'managed' NOT NULL,
	"last_used_at" timestamp,
	"last_failure_at" timestamp,
	"last_failure_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "state" SET DEFAULT 'inbox';--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "last_heartbeat_at" timestamp;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "checkin_deadline_at" timestamp;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "last_wake_at" timestamp;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "wake_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "max_wake_attempts" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "lifecycle_generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "last_provision_error" text;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "title" text;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "artifact_class" text DEFAULT 'working_file' NOT NULL;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "importance" text DEFAULT 'operational' NOT NULL;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "storage_provider" text;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "storage_key" text;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "original_filename" text;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "source_kind" text;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "source_ref" text;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "is_canonical" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "promoted_at" timestamp;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "metadata_json" jsonb DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "lead_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "require_approval_for_done" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "require_review_before_done" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "comment_required_for_review" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "block_status_changes_with_pending_approval" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "only_lead_can_change_status" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "max_active_agents" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "recurring_task_definition_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "task_kind" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "thread_participants" ADD COLUMN IF NOT EXISTS "last_read_at" timestamp;--> statement-breakpoint
ALTER TABLE "thread_participants" ADD COLUMN IF NOT EXISTS "typing_until" timestamp;--> statement-breakpoint
ALTER TABLE "scoped_resources" ADD COLUMN IF NOT EXISTS "is_shared" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'approval_task_links_approval_id_approvals_id_fk'
	) THEN
		ALTER TABLE "approval_task_links" ADD CONSTRAINT "approval_task_links_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'approval_task_links_task_id_tasks_id_fk'
	) THEN
		ALTER TABLE "approval_task_links" ADD CONSTRAINT "approval_task_links_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'approval_task_links_company_id_companies_id_fk'
	) THEN
		ALTER TABLE "approval_task_links" ADD CONSTRAINT "approval_task_links_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'approvals_company_id_companies_id_fk'
	) THEN
		ALTER TABLE "approvals" ADD CONSTRAINT "approvals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'approvals_project_id_projects_id_fk'
	) THEN
		ALTER TABLE "approvals" ADD CONSTRAINT "approvals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'approvals_requester_agent_id_agents_id_fk'
	) THEN
		ALTER TABLE "approvals" ADD CONSTRAINT "approvals_requester_agent_id_agents_id_fk" FOREIGN KEY ("requester_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'approvals_resolver_user_id_users_id_fk'
	) THEN
		ALTER TABLE "approvals" ADD CONSTRAINT "approvals_resolver_user_id_users_id_fk" FOREIGN KEY ("resolver_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'project_agent_profiles_company_id_companies_id_fk'
	) THEN
		ALTER TABLE "project_agent_profiles" ADD CONSTRAINT "project_agent_profiles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'project_agent_profiles_project_id_projects_id_fk'
	) THEN
		ALTER TABLE "project_agent_profiles" ADD CONSTRAINT "project_agent_profiles_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'project_agent_profiles_agent_id_agents_id_fk'
	) THEN
		ALTER TABLE "project_agent_profiles" ADD CONSTRAINT "project_agent_profiles_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'recurring_task_definitions_company_id_companies_id_fk'
	) THEN
		ALTER TABLE "recurring_task_definitions" ADD CONSTRAINT "recurring_task_definitions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'recurring_task_definitions_project_id_projects_id_fk'
	) THEN
		ALTER TABLE "recurring_task_definitions" ADD CONSTRAINT "recurring_task_definitions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'recurring_task_definitions_created_by_agent_id_agents_id_fk'
	) THEN
		ALTER TABLE "recurring_task_definitions" ADD CONSTRAINT "recurring_task_definitions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'resource_access_logs_company_id_companies_id_fk'
	) THEN
		ALTER TABLE "resource_access_logs" ADD CONSTRAINT "resource_access_logs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'resource_access_logs_resource_id_scoped_resources_id_fk'
	) THEN
		ALTER TABLE "resource_access_logs" ADD CONSTRAINT "resource_access_logs_resource_id_scoped_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."scoped_resources"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'resource_access_logs_agent_id_agents_id_fk'
	) THEN
		ALTER TABLE "resource_access_logs" ADD CONSTRAINT "resource_access_logs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'resource_access_logs_session_id_agent_sessions_id_fk'
	) THEN
		ALTER TABLE "resource_access_logs" ADD CONSTRAINT "resource_access_logs_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'resource_access_logs_task_id_tasks_id_fk'
	) THEN
		ALTER TABLE "resource_access_logs" ADD CONSTRAINT "resource_access_logs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'scoped_resources_company_id_companies_id_fk'
	) THEN
		ALTER TABLE "scoped_resources" ADD CONSTRAINT "scoped_resources_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'projects_lead_agent_id_agents_id_fk'
	) THEN
		ALTER TABLE "projects" ADD CONSTRAINT "projects_lead_agent_id_agents_id_fk" FOREIGN KEY ("lead_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'tasks_recurring_task_definition_id_recurring_task_definitions_id_fk'
	) THEN
		ALTER TABLE "tasks" ADD CONSTRAINT "tasks_recurring_task_definition_id_recurring_task_definitions_id_fk" FOREIGN KEY ("recurring_task_definition_id") REFERENCES "public"."recurring_task_definitions"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
