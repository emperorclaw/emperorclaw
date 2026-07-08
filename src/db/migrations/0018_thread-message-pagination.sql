CREATE INDEX IF NOT EXISTS "thread_messages_thread_created_idx"
ON "thread_messages" ("company_id", "thread_id", "created_at");
