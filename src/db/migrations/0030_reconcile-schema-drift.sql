-- Migration 0030: Reconcile migration chain with schema.ts
-- These columns exist in schema.ts and in databases built via `drizzle-kit push`,
-- but no prior migration added them — so a fresh `db:migrate` (e.g. the Docker
-- image on first boot) produced a database missing them, breaking registration
-- (users.display_name / role_title) and agent config (agents.llm_provider,
-- company_members.scope_json). Additive and idempotent (IF NOT EXISTS): safe on
-- both fresh databases and existing ones already built via push.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "display_name" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "role_title" text;
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "llm_provider" text;
--> statement-breakpoint
ALTER TABLE "company_members" ADD COLUMN IF NOT EXISTS "scope_json" jsonb DEFAULT '{}';
