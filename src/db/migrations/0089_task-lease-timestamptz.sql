-- The stored values were written as UTC wall clock by sessions pinned to UTC,
-- so 'UTC' is the correct zone here, not the session zone.
ALTER TABLE "tasks" ALTER COLUMN "lease_until" SET DATA TYPE timestamp with time zone
  USING "lease_until" AT TIME ZONE 'UTC';
