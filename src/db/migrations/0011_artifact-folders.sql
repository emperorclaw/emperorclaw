CREATE TABLE IF NOT EXISTS "artifact_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"customer_id" uuid,
	"project_id" uuid,
	"agent_id" uuid,
	"parent_folder_id" uuid,
	"name" text NOT NULL,
	"path" text NOT NULL,
	"kind" text DEFAULT 'folder' NOT NULL,
	"metadata_json" jsonb DEFAULT '{}' NOT NULL,
	"created_by_type" text NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "folder_id" uuid;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "path" text;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "preview_text" text;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "search_text" text;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'artifact_folders_company_id_companies_id_fk'
	) THEN
		ALTER TABLE "artifact_folders" ADD CONSTRAINT "artifact_folders_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'artifact_folders_customer_id_customers_id_fk'
	) THEN
		ALTER TABLE "artifact_folders" ADD CONSTRAINT "artifact_folders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'artifact_folders_project_id_projects_id_fk'
	) THEN
		ALTER TABLE "artifact_folders" ADD CONSTRAINT "artifact_folders_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'artifact_folders_agent_id_agents_id_fk'
	) THEN
		ALTER TABLE "artifact_folders" ADD CONSTRAINT "artifact_folders_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'artifact_folders_created_by_id_users_id_fk'
	) THEN
		ALTER TABLE "artifact_folders" ADD CONSTRAINT "artifact_folders_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'artifact_folders_parent_folder_id_fkey'
	) THEN
		ALTER TABLE "artifact_folders" ADD CONSTRAINT "artifact_folders_parent_folder_id_fkey" FOREIGN KEY ("parent_folder_id") REFERENCES "public"."artifact_folders"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'artifacts_folder_id_artifact_folders_id_fk'
	) THEN
		ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_folder_id_artifact_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."artifact_folders"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifact_folders_company_path_idx" ON "artifact_folders" ("company_id", "path");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifacts_company_path_idx" ON "artifacts" ("company_id", "path");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifacts_company_folder_created_at_idx" ON "artifacts" ("company_id", "folder_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifacts_company_project_idx" ON "artifacts" ("company_id", "project_id");--> statement-breakpoint
