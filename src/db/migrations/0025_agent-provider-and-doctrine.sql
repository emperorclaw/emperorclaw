-- Migration 0025: Agent provider and doctrine support
-- Additive only: ADD COLUMN IF NOT EXISTS (NFR-10)

ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "provider" text DEFAULT 'mcp' NOT NULL;
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "doctrine_json" jsonb DEFAULT '{}'::jsonb NOT NULL;
