-- Multiple private chats per (person, agent) (docs/design/multi-chat-per-agent.md §4).
-- Every person keeps exactly one live MAIN chat per agent; extra chats are
-- is_main = false. The one-live-private-thread unique index becomes one live
-- MAIN thread, so the existing get-or-create stays correct.
--
-- Backfill: every person's existing private direct thread becomes their main
-- chat. The old index allowed only one LIVE private thread per (company, owner,
-- agent); DISTINCT ON keeps the oldest one anyway, so the new unique index can
-- never fail even on a database with stray duplicates. Archived private threads
-- (e.g. a member who left) are marked main too: they are outside the partial
-- index, and a later restore while another main is live comes back as a normal
-- chat (lib/private-chats.ts).
--
-- restored_at: when an archived chat was last restored; the idle auto-archive
-- counts it as activity, so a restored idle chat is not archived again on the
-- next sweep.
--
-- lock_timeout makes the migration fail fast instead of queueing writers; it is
-- retried on the next start.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "multi_chat_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "multi_chat_max_open" integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "multi_chat_idle_archive_days" integer DEFAULT 30;--> statement-breakpoint
ALTER TABLE "message_threads" ADD COLUMN "is_main" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "message_threads" ADD COLUMN "archive_reason" text;--> statement-breakpoint
ALTER TABLE "message_threads" ADD COLUMN "restored_at" timestamp;--> statement-breakpoint
UPDATE "message_threads" SET "is_main" = true
 WHERE "type" = 'direct' AND "owner_user_id" IS NOT NULL AND "archived_at" IS NOT NULL;--> statement-breakpoint
UPDATE "message_threads" t SET "is_main" = true
  FROM (
    SELECT DISTINCT ON ("company_id", "owner_user_id", "direct_agent_id") "id"
      FROM "message_threads"
     WHERE "type" = 'direct' AND "owner_user_id" IS NOT NULL AND "archived_at" IS NULL
     ORDER BY "company_id", "owner_user_id", "direct_agent_id", "created_at", "id"
  ) m
 WHERE t."id" = m."id";--> statement-breakpoint
DROP INDEX IF EXISTS "message_threads_private_direct_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "message_threads_private_main_unique" ON "message_threads" USING btree ("company_id","owner_user_id","direct_agent_id") WHERE "message_threads"."type" = 'direct' AND "message_threads"."owner_user_id" IS NOT NULL AND "message_threads"."archived_at" IS NULL AND "message_threads"."is_main";--> statement-breakpoint
CREATE INDEX "message_threads_private_owner_agent_idx" ON "message_threads" USING btree ("company_id","owner_user_id","direct_agent_id") WHERE "message_threads"."type" = 'direct' AND "message_threads"."owner_user_id" IS NOT NULL AND "message_threads"."archived_at" IS NULL;--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
