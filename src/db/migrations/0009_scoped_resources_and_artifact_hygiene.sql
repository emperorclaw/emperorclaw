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
ALTER TABLE "project_agent_profiles" ADD CONSTRAINT "project_agent_profiles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_agent_profiles" ADD CONSTRAINT "project_agent_profiles_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_agent_profiles" ADD CONSTRAINT "project_agent_profiles_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
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
	"ownership" text DEFAULT 'managed' NOT NULL,
	"last_used_at" timestamp,
	"last_failure_at" timestamp,
	"last_failure_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "scoped_resources" ADD CONSTRAINT "scoped_resources_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
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
ALTER TABLE "resource_access_logs" ADD CONSTRAINT "resource_access_logs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "resource_access_logs" ADD CONSTRAINT "resource_access_logs_resource_id_scoped_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."scoped_resources"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "resource_access_logs" ADD CONSTRAINT "resource_access_logs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "resource_access_logs" ADD CONSTRAINT "resource_access_logs_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "resource_access_logs" ADD CONSTRAINT "resource_access_logs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "title" text;
--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "artifact_class" text DEFAULT 'working_file' NOT NULL;
--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "importance" text DEFAULT 'operational' NOT NULL;
--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "storage_provider" text;
--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "storage_key" text;
--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "original_filename" text;
--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "source_kind" text;
--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "source_ref" text;
--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "is_canonical" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "promoted_at" timestamp;
--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "metadata_json" jsonb DEFAULT '{}' NOT NULL;
--> statement-breakpoint

UPDATE "artifacts"
SET
	"title" = COALESCE("title", "kind"),
	"artifact_class" = CASE
		WHEN "kind" IN ('proof', 'evidence') THEN 'proof'
		WHEN "kind" IN ('report', 'invoice', 'bundle', 'export') THEN 'deliverable'
		WHEN "kind" IN ('template', 'prompt_template') THEN 'template'
		ELSE 'working_file'
	END,
	"importance" = CASE
		WHEN "kind" IN ('proof', 'evidence') THEN 'record'
		WHEN "kind" IN ('report', 'invoice', 'bundle', 'export') THEN 'canonical'
		WHEN "kind" IN ('template', 'prompt_template') THEN 'record'
		ELSE 'operational'
	END,
	"is_canonical" = CASE
		WHEN "kind" IN ('report', 'invoice', 'bundle', 'export') THEN true
		ELSE false
	END
WHERE "title" IS NULL OR "artifact_class" = 'working_file' OR "importance" = 'operational';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "scoped_resources_scope_idx" ON "scoped_resources" ("company_id", "scope_type", "scope_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "resource_access_logs_resource_idx" ON "resource_access_logs" ("company_id", "resource_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_agent_profiles_project_idx" ON "project_agent_profiles" ("company_id", "project_id", "agent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifacts_class_idx" ON "artifacts" ("company_id", "project_id", "artifact_class", "importance", "created_at");
