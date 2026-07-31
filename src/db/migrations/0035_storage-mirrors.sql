-- Optional storage mirrors are additive. Existing artifacts, folders, and
-- storage paths are not rewritten by this migration.

CREATE TABLE IF NOT EXISTS "storage_mirrors" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "company_id" uuid NOT NULL,
    "provider" text DEFAULT 'rclone' NOT NULL,
    "remote_name" text NOT NULL,
    "remote_root" text NOT NULL,
    "enabled" boolean DEFAULT false NOT NULL,
    "mode" text DEFAULT 'bidirectional_content' NOT NULL,
    "poll_interval_seconds" integer DEFAULT 5 NOT NULL,
    "last_scan_at" timestamp,
    "last_success_at" timestamp,
    "last_error" text,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "storage_mirror_entries" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "mirror_id" uuid NOT NULL,
    "artifact_id" uuid,
    "remote_id" text,
    "remote_path" text NOT NULL,
    "entry_type" text DEFAULT 'file' NOT NULL,
    "state" text DEFAULT 'untracked' NOT NULL,
    "last_synced_sha256" text,
    "remote_size_bytes" integer,
    "remote_modified_at" timestamp,
    "discovered_at" timestamp DEFAULT now() NOT NULL,
    "ignored_at" timestamp,
    "last_error" text,
    "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "storage_mirrors" ADD CONSTRAINT "storage_mirrors_company_id_companies_id_fk"
 FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "storage_mirror_entries" ADD CONSTRAINT "storage_mirror_entries_mirror_id_storage_mirrors_id_fk"
 FOREIGN KEY ("mirror_id") REFERENCES "public"."storage_mirrors"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "storage_mirror_entries" ADD CONSTRAINT "storage_mirror_entries_artifact_id_artifacts_id_fk"
 FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "storage_mirrors_company_provider_idx"
 ON "storage_mirrors" USING btree ("company_id", "provider");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "storage_mirror_entries_mirror_path_idx"
 ON "storage_mirror_entries" USING btree ("mirror_id", "remote_path");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "storage_mirror_entries_artifact_idx"
 ON "storage_mirror_entries" USING btree ("artifact_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "storage_mirror_entries_state_idx"
 ON "storage_mirror_entries" USING btree ("mirror_id", "state");
