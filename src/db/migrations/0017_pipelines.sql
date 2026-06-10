CREATE TABLE IF NOT EXISTS "pipelines" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
    "project_id" uuid REFERENCES "projects"("id") ON DELETE set null,
    "customer_id" uuid REFERENCES "customers"("id") ON DELETE set null,
    "owner_agent_id" uuid REFERENCES "agents"("id") ON DELETE set null,
    "name" text NOT NULL,
    "purpose" text,
    "doc_markdown" text,
    "trigger" text DEFAULT 'manual' NOT NULL,
    "trigger_config" jsonb DEFAULT '{}' NOT NULL,
    "steps_json" jsonb DEFAULT '[]' NOT NULL,
    "diagram_mermaid" text,
    "runtime_ref" text,
    "status" text DEFAULT 'draft' NOT NULL,
    "run_count" integer DEFAULT 0 NOT NULL,
    "last_run_at" timestamp,
    "last_run_status" text,
    "next_run_at" timestamp,
    "created_by_type" text DEFAULT 'agent' NOT NULL,
    "created_by_id" uuid,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL,
    "deleted_at" timestamp
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pipeline_runs" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
    "pipeline_id" uuid NOT NULL REFERENCES "pipelines"("id") ON DELETE cascade,
    "agent_id" uuid REFERENCES "agents"("id") ON DELETE set null,
    "status" text DEFAULT 'running' NOT NULL,
    "summary" text,
    "stats_json" jsonb DEFAULT '{}' NOT NULL,
    "started_at" timestamp DEFAULT now() NOT NULL,
    "ended_at" timestamp,
    "created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "recurring_task_definitions" ADD COLUMN IF NOT EXISTS "pipeline_id" uuid REFERENCES "pipelines"("id") ON DELETE set null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pipelines_company_name_unique_idx" ON "pipelines" ("company_id", "name") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pipelines_company_status_idx" ON "pipelines" ("company_id", "status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pipeline_runs_pipeline_started_idx" ON "pipeline_runs" ("pipeline_id", "started_at");
