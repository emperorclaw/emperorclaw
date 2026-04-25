CREATE TABLE IF NOT EXISTS "ops_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"level" text NOT NULL,
	"category" text NOT NULL,
	"source" text NOT NULL,
	"message" text NOT NULL,
	"route" text,
	"method" text,
	"company_id" uuid,
	"user_id" uuid,
	"metadata_json" jsonb DEFAULT '{}' NOT NULL,
	"stack" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ops_events_created_at_idx" ON "ops_events" ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ops_events_level_created_at_idx" ON "ops_events" ("level", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ops_events_source_created_at_idx" ON "ops_events" ("source", "created_at");--> statement-breakpoint
