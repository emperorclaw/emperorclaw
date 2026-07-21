-- Migration 0024: Team RBAC — invitations, instance_settings, and instance_role
-- Idempotent: all DDL uses IF NOT EXISTS / IF EXISTS guards (NFR-9)
-- Additive only: no data deletion or column drops (NFR-10)

-- ── New tables ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "invitations" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
    "created_by_user_id" uuid NOT NULL REFERENCES "users"("id"),
    "email" text NOT NULL,
    "token_hash" text NOT NULL,
    "role" text NOT NULL,
    "max_uses" integer DEFAULT 1 NOT NULL,
    "use_count" integer DEFAULT 0 NOT NULL,
    "expires_at" timestamp NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "deleted_at" timestamp
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "invitations_token_hash_idx" ON "invitations"("token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invitations_email_company_idx" ON "invitations"("email", "company_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "instance_settings" (
    "key" text PRIMARY KEY,
    "value" jsonb NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- ── Modify existing tables ────────────────────────────────────────────────

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "instance_role" text DEFAULT 'member' NOT NULL;
--> statement-breakpoint
-- ── Auto-migrate existing sole-company creator to instance_admin (NFR-11) ──
-- Only fires when exactly one non-deleted company exists AND the user is its creator.
-- The subquery ensures we only update users who actually created a company.
UPDATE "users"
SET "instance_role" = 'instance_admin'
WHERE "id" IN (
    SELECT "created_by_user_id" FROM "companies" WHERE "deleted_at" IS NULL
)
AND (SELECT COUNT(*) FROM "companies" WHERE "deleted_at" IS NULL) = 1;
