ALTER TABLE "pipelines" ADD COLUMN "operator_fields" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "pipelines" ADD COLUMN "operator_edited_at" timestamp;--> statement-breakpoint
ALTER TABLE "pipelines" ADD COLUMN "operator_edited_by" uuid;