-- Per-agent environment variables (lib/agent-secrets.ts). Values are encrypted
-- with the existing AES-256-GCM helpers; the runtime bridge (a later slice)
-- writes the decrypted values into the agent's Hermes profile `.env`.
-- One live name per agent: the partial unique index ignores soft-deleted rows,
-- so a deleted name can be created again.
--
-- lock_timeout makes the migration fail fast instead of queueing writers; it is
-- retried on the next start.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"name" text NOT NULL,
	"value_encrypted" text NOT NULL,
	"key_version" text DEFAULT 'v1' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"expose_to_tools" boolean DEFAULT false NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_secrets_company_id_companies_id_fk') THEN
    ALTER TABLE "agent_secrets" ADD CONSTRAINT "agent_secrets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_secrets_agent_id_agents_id_fk') THEN
    ALTER TABLE "agent_secrets" ADD CONSTRAINT "agent_secrets_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_secrets_created_by_user_id_users_id_fk') THEN
    ALTER TABLE "agent_secrets" ADD CONSTRAINT "agent_secrets_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_secrets_agent_name_live_idx" ON "agent_secrets" USING btree ("agent_id","name") WHERE "agent_secrets"."deleted_at" IS NULL;--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
