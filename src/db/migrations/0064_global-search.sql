-- Global search (roadmap 11.5): full-text search over tasks, task notes,
-- messages, Knowledge & Rules notes, files, projects, customers and agents.
--
-- The search_vector columns live only in SQL, never in src/db/schema.ts: a
-- schema column would ride along on every `db.select().from(table)` and every
-- `.returning()`, shipping the vector to the UI and to agents over MCP.
-- src/lib/search.ts is the only reader.
--
-- Text is multilingual (Spanish / English / Slovak), so no stemming: the
-- `emperor_search` configuration is `simple` (lower-casing only) plus
-- `unaccent` when the extension can be installed, so "cafe" finds "café".
-- Without the extension (no privilege to create it) search still works and
-- just does not fold accents.
--
-- Nothing here may abort boot for lack of a privilege: every step that needs
-- one (the extension, the configuration, its unaccent mapping) is guarded.
-- If the configuration itself cannot be created, the search columns and
-- indexes are skipped (each statement checks first) and global search is
-- unavailable on this database; everything else migrates as usual.
--
-- The drizzle migrator runs every migration in one transaction, so the GIN
-- indexes cannot be built CONCURRENTLY here; the tables are small enough for
-- a plain build. Each text is capped (left(...)) so a huge note or file can
-- never hit the 1 MB tsvector limit and fail the write.
DO $$
BEGIN
    BEGIN
        CREATE EXTENSION IF NOT EXISTS unaccent;
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'unaccent is not available (%); global search will not fold accents', SQLERRM;
    END;
    IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'emperor_search') THEN
        BEGIN
            CREATE TEXT SEARCH CONFIGURATION emperor_search (COPY = pg_catalog.simple);
        EXCEPTION WHEN OTHERS THEN
            RAISE NOTICE 'emperor_search could not be created (%); global search is unavailable', SQLERRM;
        END;
        IF EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'emperor_search')
            AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'unaccent') THEN
            BEGIN
                ALTER TEXT SEARCH CONFIGURATION emperor_search
                    ALTER MAPPING FOR hword, hword_part, word, numword, numhword, hword_numpart WITH unaccent, simple;
            EXCEPTION WHEN OTHERS THEN
                RAISE NOTICE 'unaccent could not be mapped (%); global search will not fold accents', SQLERRM;
            END;
        END IF;
    END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'emperor_search') THEN
        ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "search_vector" tsvector GENERATED ALWAYS AS (
            setweight(to_tsvector('emperor_search'::regconfig, left(coalesce("input_json"->>'title', ''), 2000)), 'A')
            || setweight(to_tsvector('emperor_search'::regconfig, left(coalesce("input_json"->>'description', '') || ' ' || coalesce("input_json"->>'goal', '') || ' ' || coalesce("input_json"->>'brief', ''), 100000)), 'B')
            || setweight(to_tsvector('emperor_search'::regconfig, coalesce("task_type", '')), 'C')
        ) STORED;
    END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'emperor_search') THEN
        ALTER TABLE "task_events" ADD COLUMN IF NOT EXISTS "search_vector" tsvector GENERATED ALWAYS AS (
            CASE WHEN "event_type" IN ('task_note', 'task_handoff')
                THEN to_tsvector('emperor_search'::regconfig, left(coalesce("payload_json"->>'note', ''), 100000))
            END
        ) STORED;
    END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'emperor_search') THEN
        ALTER TABLE "thread_messages" ADD COLUMN IF NOT EXISTS "search_vector" tsvector GENERATED ALWAYS AS (
            to_tsvector('emperor_search'::regconfig, left(coalesce("text", ''), 100000))
        ) STORED;
    END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'emperor_search') THEN
        ALTER TABLE "scoped_resources" ADD COLUMN IF NOT EXISTS "search_vector" tsvector GENERATED ALWAYS AS (
            setweight(to_tsvector('emperor_search'::regconfig, coalesce("display_name", '') || ' ' || coalesce("name", '')), 'A')
            || setweight(to_tsvector('emperor_search'::regconfig, coalesce("summary", '')), 'B')
            || setweight(to_tsvector('emperor_search'::regconfig, coalesce("path", '')), 'C')
            || setweight(to_tsvector('emperor_search'::regconfig, left(coalesce("config_text", ''), 100000)), 'D')
        ) STORED;
    END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'emperor_search') THEN
        ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "search_vector" tsvector GENERATED ALWAYS AS (
            setweight(to_tsvector('emperor_search'::regconfig, coalesce("title", '') || ' ' || coalesce("original_filename", '')), 'A')
            || setweight(to_tsvector('emperor_search'::regconfig, coalesce("path", '')), 'B')
            || setweight(to_tsvector('emperor_search'::regconfig, left(coalesce("search_text", '') || ' ' || coalesce("content_text", "preview_text", ''), 100000)), 'D')
        ) STORED;
    END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'emperor_search') THEN
        ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "search_vector" tsvector GENERATED ALWAYS AS (
            setweight(to_tsvector('emperor_search'::regconfig, left(coalesce("goal", ''), 20000)), 'A')
        ) STORED;
    END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'emperor_search') THEN
        ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "search_vector" tsvector GENERATED ALWAYS AS (
            setweight(to_tsvector('emperor_search'::regconfig, coalesce("name", '')), 'A')
            || setweight(to_tsvector('emperor_search'::regconfig, left(coalesce("notes", ''), 20000)), 'C')
        ) STORED;
    END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'emperor_search') THEN
        ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "search_vector" tsvector GENERATED ALWAYS AS (
            setweight(to_tsvector('emperor_search'::regconfig, coalesce("name", '')), 'A')
            || setweight(to_tsvector('emperor_search'::regconfig, left(coalesce("role", ''), 2000)), 'B')
        ) STORED;
    END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'tasks' AND column_name = 'search_vector') THEN
        CREATE INDEX IF NOT EXISTS "tasks_search_idx" ON "tasks" USING gin ("search_vector");
    END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'task_events' AND column_name = 'search_vector') THEN
        CREATE INDEX IF NOT EXISTS "task_events_search_idx" ON "task_events" USING gin ("search_vector");
    END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'thread_messages' AND column_name = 'search_vector') THEN
        CREATE INDEX IF NOT EXISTS "thread_messages_search_idx" ON "thread_messages" USING gin ("search_vector");
    END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'scoped_resources' AND column_name = 'search_vector') THEN
        CREATE INDEX IF NOT EXISTS "scoped_resources_search_idx" ON "scoped_resources" USING gin ("search_vector");
    END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'artifacts' AND column_name = 'search_vector') THEN
        CREATE INDEX IF NOT EXISTS "artifacts_search_idx" ON "artifacts" USING gin ("search_vector");
    END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'projects' AND column_name = 'search_vector') THEN
        CREATE INDEX IF NOT EXISTS "projects_search_idx" ON "projects" USING gin ("search_vector");
    END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'customers' AND column_name = 'search_vector') THEN
        CREATE INDEX IF NOT EXISTS "customers_search_idx" ON "customers" USING gin ("search_vector");
    END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'agents' AND column_name = 'search_vector') THEN
        CREATE INDEX IF NOT EXISTS "agents_search_idx" ON "agents" USING gin ("search_vector");
    END IF;
END $$;
--> statement-breakpoint
-- The Costs page reads a company's runs over a date range, across agents.
CREATE INDEX IF NOT EXISTS "agent_runs_company_started_idx" ON "agent_runs" USING btree ("company_id","started_at");
