-- Approval cards in chat (0.30.0): the thread an agent asked from and its card message.
-- Nullable, no backfill: older approvals keep delivering decisions to the direct thread.
ALTER TABLE "approvals" ADD COLUMN "thread_id" uuid;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "card_message_id" uuid;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_thread_id_message_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."message_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_card_message_id_thread_messages_id_fk" FOREIGN KEY ("card_message_id") REFERENCES "public"."thread_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approvals_thread_idx" ON "approvals" USING btree ("thread_id") WHERE "approvals"."thread_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "approvals_card_message_idx" ON "approvals" USING btree ("card_message_id") WHERE "approvals"."card_message_id" IS NOT NULL;