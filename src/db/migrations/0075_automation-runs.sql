ALTER TABLE "pipeline_runs" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD COLUMN "triggered_by_type" text;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD COLUMN "triggered_by_id" uuid;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD COLUMN "task_id" uuid;--> statement-breakpoint
ALTER TABLE "pipelines" ADD COLUMN "scheduled_by" text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "pipelines" ADD COLUMN "paused_reason" text;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pipeline_runs_pipeline_status_idx" ON "pipeline_runs" USING btree ("pipeline_id","status");--> statement-breakpoint
CREATE INDEX "pipeline_runs_task_idx" ON "pipeline_runs" USING btree ("task_id");