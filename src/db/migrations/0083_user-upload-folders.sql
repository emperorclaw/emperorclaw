-- Per-person upload folders and private Storage files (lib/artifact-visibility.ts).
--
-- artifact_folders.owner_user_id names the person a `user_uploads` folder
-- (<uploads root>/<userId>) belongs to; chat files and voice messages land
-- there as private files.
-- The partial unique indexes keep one live uploads folder per person and one
-- live shared `uploads` root per company, which makes the get-or-create in
-- lib/artifact-folders.ts (ensureUserUploadsFolder) race-safe.
--
-- thread_messages_attachments_idx answers "was this file attached to a
-- message the agent can read?" (metadata_json->'attachments' @> [{"id": ...}]).
--
-- No data migration: existing chat-attachments/* rows keep visibility 'company'.
--
-- lock_timeout makes the migration fail fast instead of queueing writers; it is
-- retried on the next start.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "artifact_folders" ADD COLUMN IF NOT EXISTS "owner_user_id" uuid;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'artifact_folders_owner_user_id_users_id_fk') THEN
    ALTER TABLE "artifact_folders" ADD CONSTRAINT "artifact_folders_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "artifact_folders_user_uploads_unique" ON "artifact_folders" USING btree ("company_id","owner_user_id") WHERE "artifact_folders"."kind" = 'user_uploads' AND "artifact_folders"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "artifact_folders_uploads_root_unique" ON "artifact_folders" USING btree ("company_id") WHERE "artifact_folders"."kind" = 'uploads_root' AND "artifact_folders"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "thread_messages_attachments_idx" ON "thread_messages" USING gin (("metadata_json" -> 'attachments') jsonb_path_ops);--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
