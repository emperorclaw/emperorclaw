-- ops_cleanup_backups exists in production and appears in no commit (`git log --all -S ops_cleanup_backups`
-- is empty): it was created by hand. It holds one undo snapshot from the June 2026 project/task naming
-- cleanup, so it is not dead weight. This baseline makes a fresh install match production and is a no-op there.
-- No foreign key on company_id in production; do not add one.
CREATE TABLE IF NOT EXISTS "ops_cleanup_backups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"cleanup_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
