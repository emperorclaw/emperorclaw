CREATE TABLE "view_pins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"view_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "view_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"view_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "views" ADD COLUMN "owner_user_id" uuid;--> statement-breakpoint
ALTER TABLE "views" ADD COLUMN "visibility" text DEFAULT 'scope' NOT NULL;--> statement-breakpoint
ALTER TABLE "views" ADD COLUMN "refresh_every_minutes" integer;--> statement-breakpoint
ALTER TABLE "view_pins" ADD CONSTRAINT "view_pins_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "view_pins" ADD CONSTRAINT "view_pins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "view_pins" ADD CONSTRAINT "view_pins_view_id_views_id_fk" FOREIGN KEY ("view_id") REFERENCES "public"."views"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "view_shares" ADD CONSTRAINT "view_shares_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "view_shares" ADD CONSTRAINT "view_shares_view_id_views_id_fk" FOREIGN KEY ("view_id") REFERENCES "public"."views"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "view_shares" ADD CONSTRAINT "view_shares_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "view_pins_user_view_unique" ON "view_pins" USING btree ("user_id","view_id");--> statement-breakpoint
CREATE INDEX "view_pins_company_user_idx" ON "view_pins" USING btree ("company_id","user_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "view_shares_view_user_unique" ON "view_shares" USING btree ("view_id","user_id");--> statement-breakpoint
CREATE INDEX "view_shares_company_user_idx" ON "view_shares" USING btree ("company_id","user_id");--> statement-breakpoint
ALTER TABLE "views" ADD CONSTRAINT "views_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "views" ADD CONSTRAINT "views_visibility_check" CHECK ("views"."visibility" IN ('private', 'shared', 'scope'));--> statement-breakpoint
-- Pins become per person. Every current member who could see a pinned view
-- keeps it on their Home (the same rule as lib/member-scope.ts: owners and
-- admins and unrestricted members see everything; a restricted member sees
-- company views and those of their customers and their customers' projects),
-- so nobody's Home changes. Existing views stay visibility 'scope' with no owner.
INSERT INTO "view_pins" ("company_id", "user_id", "view_id", "position")
SELECT v."company_id", cm."user_id", v."id",
       (row_number() OVER (PARTITION BY cm."company_id", cm."user_id" ORDER BY v."updated_at" DESC) - 1)::integer
FROM "views" v
JOIN "company_members" cm ON cm."company_id" = v."company_id"
JOIN "users" u ON u."id" = cm."user_id" AND u."deleted_at" IS NULL
LEFT JOIN "projects" p ON v."scope_type" = 'project' AND p."id" = v."scope_id"
WHERE v."pinned_to_home" AND v."archived_at" IS NULL AND (
    cm."role" IN ('owner', 'admin')
    OR u."instance_role" = 'instance_admin'
    OR coalesce(cm."scope_json"->>'mode', '') <> 'restricted'
    OR v."scope_type" = 'company'
    OR (v."scope_type" = 'customer' AND coalesce(cm."scope_json"->'customerIds', '[]'::jsonb) ? v."scope_id"::text)
    OR (v."scope_type" = 'project' AND p."customer_id" IS NOT NULL AND coalesce(cm."scope_json"->'customerIds', '[]'::jsonb) ? p."customer_id"::text)
)
ON CONFLICT ("user_id", "view_id") DO NOTHING;
