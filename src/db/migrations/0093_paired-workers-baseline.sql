-- paired_workers exists in production but has no migration: it was created by 0055_lowly_cloak.sql and
-- 0056_paired_worker_agent_unique.sql, both since deleted from the repository (journal ids 56 and 57 still
-- reference them). No application code reads the table. This baseline makes a fresh install match production
-- and is a no-op there: the table, both unique indexes and both foreign keys already exist.
CREATE TABLE IF NOT EXISTS "paired_workers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker_id" text NOT NULL,
	"company_id" uuid,
	"agent_id" uuid,
	"pending_token_encrypted" text,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
-- The unique constraints are indexes in production (created with CREATE UNIQUE INDEX), not constraints;
-- keep them that way or the structure fingerprint diverges.
CREATE UNIQUE INDEX IF NOT EXISTS "paired_workers_worker_id_unique" ON "paired_workers" USING btree ("worker_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "paired_workers_agent_id_unique" ON "paired_workers" USING btree ("agent_id");--> statement-breakpoint
-- PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS; swallow the duplicate so production is a no-op.
DO $$
BEGIN
	ALTER TABLE "paired_workers" ADD CONSTRAINT "paired_workers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$
BEGIN
	ALTER TABLE "paired_workers" ADD CONSTRAINT "paired_workers_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
