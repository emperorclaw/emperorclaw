-- Migration 0032: one participant row per (thread, participant)
-- Shared channels need exactly one participant row per human/agent per thread —
-- otherwise unread counts double-count (the thread_messages ⋈ participants join
-- multiplies) and read state only clears one of the duplicate rows. Historically
-- there was no unique constraint, so duplicates accumulated. Dedup, then enforce.
DELETE FROM "thread_participants" WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY thread_id, participant_ref
      ORDER BY last_read_at DESC NULLS LAST, created_at DESC, id DESC
    ) AS rn
    FROM "thread_participants"
    WHERE participant_type = 'human' AND participant_ref IS NOT NULL
  ) d WHERE d.rn > 1
);
--> statement-breakpoint
DELETE FROM "thread_participants" WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY thread_id, participant_id
      ORDER BY last_read_at DESC NULLS LAST, created_at DESC, id DESC
    ) AS rn
    FROM "thread_participants"
    WHERE participant_type = 'agent' AND participant_id IS NOT NULL
  ) d WHERE d.rn > 1
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "thread_participants_human_uniq" ON "thread_participants" ("thread_id", "participant_ref") WHERE participant_type = 'human';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "thread_participants_agent_uniq" ON "thread_participants" ("thread_id", "participant_id") WHERE participant_type = 'agent';
