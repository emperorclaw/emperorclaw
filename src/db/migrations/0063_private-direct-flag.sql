ALTER TABLE "message_threads" ADD COLUMN IF NOT EXISTS "is_private" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Mark every private direct thread, including ones whose owner was already
-- deleted (owner_user_id NULL, but created by a person).
UPDATE "message_threads" SET "is_private" = true WHERE "type" = 'direct' AND ("owner_user_id" IS NOT NULL OR "created_by_type" = 'human');
