ALTER TABLE "pipelines" ADD COLUMN IF NOT EXISTS "context_query" text;
ALTER TABLE "pipelines" ADD COLUMN IF NOT EXISTS "context_resource_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;
ALTER TABLE "pipelines" ADD COLUMN IF NOT EXISTS "context_tag_filters" jsonb DEFAULT '[]'::jsonb NOT NULL;
ALTER TABLE "pipelines" ADD COLUMN IF NOT EXISTS "context_max_chars" integer DEFAULT 8000 NOT NULL;

ALTER TABLE "pipeline_runs" ADD COLUMN IF NOT EXISTS "context_source_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;
ALTER TABLE "pipeline_runs" ADD COLUMN IF NOT EXISTS "context_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL;
