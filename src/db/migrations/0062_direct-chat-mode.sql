ALTER TABLE "companies" ADD COLUMN "direct_chat_mode" text DEFAULT 'private' NOT NULL;--> statement-breakpoint
-- Companies that existed before the setting keep today's behaviour: one shared
-- direct thread per agent. Only companies created from now on start private.
UPDATE "companies" SET "direct_chat_mode" = 'shared';--> statement-breakpoint
ALTER TABLE "message_threads" ADD COLUMN "direct_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "message_threads" ADD COLUMN "owner_user_id" uuid;--> statement-breakpoint
ALTER TABLE "message_threads" ADD CONSTRAINT "message_threads_direct_agent_id_agents_id_fk" FOREIGN KEY ("direct_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_threads" ADD CONSTRAINT "message_threads_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Existing direct threads are all shared (owner NULL); record their agent from
-- the agent participant row so the lookup no longer needs the participants join.
UPDATE "message_threads" AS mt SET "direct_agent_id" = (
	SELECT tp."participant_id" FROM "thread_participants" tp
	INNER JOIN "agents" a ON a."id" = tp."participant_id"
	WHERE tp."thread_id" = mt."id" AND tp."participant_type" = 'agent'
	ORDER BY tp."created_at" LIMIT 1
) WHERE mt."type" = 'direct';--> statement-breakpoint
CREATE UNIQUE INDEX "message_threads_private_direct_unique" ON "message_threads" USING btree ("company_id","owner_user_id","direct_agent_id") WHERE "message_threads"."type" = 'direct' AND "message_threads"."owner_user_id" IS NOT NULL AND "message_threads"."archived_at" IS NULL;