-- 0089: `tasks.lease_until` must hold an instant, not a wall clock.
--
-- 0088 made `lease_owner` the agent and `lease_session` the holder, but the expiry
-- stayed `timestamp without time zone`. Every writer pins its session to UTC
-- (`src/db/pg-utc.ts`, `options=-c timezone=UTC`), so the naive values already in
-- the column are UTC instants. `AT TIME ZONE 'UTC'` maps each one to the instant it
-- already meant; letting Postgres fall back to the session timezone would shift
-- every lease by the server offset, and a lease one minute in the future would read
-- as expired for a full hour on a CET host (measured on a disposable cluster: same
-- row, `lease_until < now()` false under UTC, true under Europe/Bratislava).
--
-- The guard below refuses to convert a data set it cannot prove is UTC. A writer
-- that skipped the pin stamps its local clock, which sits in the future by the
-- offset, so either check failing aborts the migration (and the deploy) instead of
-- moving timestamps the wrong way. Re-running is a no-op: on an already converted
-- column the block returns without touching anything.

DO $$
DECLARE
    needs_conversion boolean;
    future_updated  bigint;
    absurd_lease    bigint;
    live_leases     bigint;
    leased_rows     bigint;
BEGIN
    SELECT (data_type = 'timestamp without time zone')
      INTO needs_conversion
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'tasks'
       AND column_name = 'lease_until';

    IF needs_conversion IS NULL THEN
        RAISE EXCEPTION '0089 expects tasks.lease_until from 0088; column not found in schema %', current_schema();
    END IF;

    IF NOT needs_conversion THEN
        RAISE NOTICE '0089: tasks.lease_until is already timestamp with time zone; nothing to do';
        RETURN;
    END IF;

    -- A row written without the UTC pin carries local time, i.e. the future for any
    -- server east of Greenwich.
    SELECT count(*) INTO future_updated
      FROM tasks
     WHERE updated_at > (now() AT TIME ZONE 'UTC') + interval '5 minutes';

    -- No healthy path puts a lease more than a day ahead; a badly shifted one can.
    SELECT count(*) INTO absurd_lease
      FROM tasks
     WHERE lease_until > (now() AT TIME ZONE 'UTC') + interval '1 day';

    IF future_updated > 0 THEN
        RAISE EXCEPTION '0089 aborted: % task row(s) have updated_at ahead of UTC now(), so some writer did not pin its session to UTC; reconcile those rows before converting', future_updated;
    END IF;

    IF absurd_lease > 0 THEN
        RAISE EXCEPTION '0089 aborted: % task row(s) have lease_until more than a day ahead; reconcile those rows before converting', absurd_lease;
    END IF;

    SELECT count(*) INTO leased_rows FROM tasks WHERE lease_until IS NOT NULL;
    SELECT count(*) INTO live_leases
      FROM tasks
     WHERE lease_until IS NOT NULL AND lease_until > (now() AT TIME ZONE 'UTC');

    ALTER TABLE "tasks" ALTER COLUMN "lease_until" TYPE timestamp with time zone
        USING "lease_until" AT TIME ZONE 'UTC';

    RAISE NOTICE '0089: converted tasks.lease_until (% leased row(s), % live at conversion)', leased_rows, live_leases;
END $$;
