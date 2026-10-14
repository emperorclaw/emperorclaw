ALTER TABLE "scoped_resources" ADD COLUMN "inject" text DEFAULT 'on_request' NOT NULL;--> statement-breakpoint
ALTER TABLE "scoped_resources" ADD COLUMN "summary" text;--> statement-breakpoint
-- Data migration: map the old isShared boolean onto the new injection modes.
-- Shared notes (auto-injected today) become index notes; everything else is
-- on_request. isShared stays in the row and the app keeps it in step with
-- inject (is_shared = inject <> 'on_request') so older readers still work.
-- The column default is on_request (not index) so a pre-lean writer that omits
-- the column during a rolling deploy inserts is_shared=false and keeps that
-- invariant instead of silently sharing every new note.
UPDATE "scoped_resources" SET "inject" = CASE WHEN "is_shared" THEN 'index' ELSE 'on_request' END;