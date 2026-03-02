ALTER TABLE "playbooks" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "deleted_at" timestamp;