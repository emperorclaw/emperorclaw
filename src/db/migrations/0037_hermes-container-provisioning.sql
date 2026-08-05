-- Migration 0037: Hermes sibling-container provisioning + encrypted LLM key storage
-- Additive only: ADD COLUMN IF NOT EXISTS (NFR-10)

ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "container_id" text;
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "container_name" text;
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "llm_api_key_encrypted" text;
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "llm_api_key_version" text;
