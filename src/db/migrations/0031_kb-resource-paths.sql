-- Migration 0031: Obsidian-style folder paths for Knowledge & Rules
-- scoped_resources was flat: notes could only be organised by scope
-- (company/customer/project/agent) and [[wikilinks]]. This adds a path column
-- so notes can live in nested folders such as 'Company/Fundraising' or
-- 'Ferrari/Audits'. Folders are implicit — the tree is derived from the
-- distinct paths at read time, so there is no folder table to keep in sync
-- and no orphan-folder state to repair.
--
-- '' (empty string) is the vault root, which is where every pre-existing note
-- lands. Additive and idempotent (IF NOT EXISTS): safe on fresh databases and
-- on ones already built via drizzle-kit push.
ALTER TABLE "scoped_resources" ADD COLUMN IF NOT EXISTS "path" text DEFAULT '' NOT NULL;
--> statement-breakpoint
-- Listing a folder's contents filters by company + path prefix; this index
-- keeps that a range scan instead of a sequential scan as the KB grows.
CREATE INDEX IF NOT EXISTS "scoped_resources_company_path_idx" ON "scoped_resources" ("company_id", "path");
