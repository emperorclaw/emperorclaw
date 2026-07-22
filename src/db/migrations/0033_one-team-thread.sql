-- Migration 0033: one team thread per company
-- ensureTeamThread did select-then-insert with no unique constraint, so
-- concurrent calls could create multiple team channels for one company, which
-- splits the shared conversation across threads. Consolidate into the oldest,
-- then enforce uniqueness so it can't happen again.

-- 1. Move messages from duplicate team threads onto the survivor (oldest per company).
WITH survivor AS (
  SELECT DISTINCT ON (company_id) id AS keep_id, company_id
  FROM "message_threads"
  WHERE type = 'team' AND archived_at IS NULL
  ORDER BY company_id, created_at ASC, id ASC
)
UPDATE "thread_messages" tm
SET thread_id = s.keep_id
FROM "message_threads" mt
JOIN survivor s ON s.company_id = mt.company_id
WHERE tm.thread_id = mt.id
  AND mt.type = 'team' AND mt.archived_at IS NULL
  AND mt.id <> s.keep_id;
--> statement-breakpoint
-- 2. Delete the duplicate team threads (participants cascade; the survivor is
--    reseeded with per-user participant rows by ensureThreadHumanParticipants).
WITH survivor AS (
  SELECT DISTINCT ON (company_id) id AS keep_id, company_id
  FROM "message_threads"
  WHERE type = 'team' AND archived_at IS NULL
  ORDER BY company_id, created_at ASC, id ASC
)
DELETE FROM "message_threads" mt
USING survivor s
WHERE mt.company_id = s.company_id
  AND mt.type = 'team' AND mt.archived_at IS NULL
  AND mt.id <> s.keep_id;
--> statement-breakpoint
-- 3. Enforce one live team thread per company.
CREATE UNIQUE INDEX IF NOT EXISTS "message_threads_one_team_per_company" ON "message_threads" ("company_id") WHERE type = 'team' AND archived_at IS NULL;
