CREATE TABLE "agent_access" (
	"agent_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_access_agent_id_user_id_pk" PRIMARY KEY("agent_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "resource_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "resource_memberships_resource_type_check" CHECK ("resource_memberships"."resource_type" IN ('customer', 'project')),
	CONSTRAINT "resource_memberships_role_check" CHECK ("resource_memberships"."role" IN ('admin', 'editor', 'viewer'))
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "owner_user_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "access" text DEFAULT 'everyone' NOT NULL;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "resource_type" text;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "resource_id" uuid;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "resource_role" text;--> statement-breakpoint
ALTER TABLE "agent_access" ADD CONSTRAINT "agent_access_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_access" ADD CONSTRAINT "agent_access_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_access" ADD CONSTRAINT "agent_access_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_memberships" ADD CONSTRAINT "resource_memberships_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_memberships" ADD CONSTRAINT "resource_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_memberships" ADD CONSTRAINT "resource_memberships_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_access_company_user_idx" ON "agent_access" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "resource_memberships_member_resource_unique" ON "resource_memberships" USING btree ("company_id","user_id","resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "resource_memberships_resource_idx" ON "resource_memberships" USING btree ("company_id","resource_type","resource_id");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_access_check" CHECK ("agents"."access" IN ('everyone', 'people', 'owner'));--> statement-breakpoint
-- Data: a restricted member's customer list moves from company_members
-- .scope_json.customerIds to resource_memberships (one 'customer' row per id,
-- 'editor' for a company member, 'viewer' for a company viewer), so nobody
-- gains or loses access. Owners, admins and instance admins were never
-- restricted and get no rows. Ids that are not customers of the company never
-- granted anything and are dropped. agentIds and mode stay in scope_json.
-- tests/integration/access-roles.test.ts replays this block.
INSERT INTO "resource_memberships" ("company_id", "user_id", "resource_type", "resource_id", "role")
SELECT DISTINCT cm."company_id", cm."user_id", 'customer', c."id",
       CASE WHEN cm."role" = 'viewer' THEN 'viewer' ELSE 'editor' END
FROM "company_members" cm
JOIN "users" u ON u."id" = cm."user_id"
CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(cm."scope_json"->'customerIds') = 'array' THEN cm."scope_json"->'customerIds' ELSE '[]'::jsonb END
) AS ids("customer_id")
JOIN "customers" c ON c."company_id" = cm."company_id" AND c."id"::text = lower(ids."customer_id")
WHERE cm."scope_json"->>'mode' = 'restricted'
  AND cm."role" IN ('member', 'viewer')
  AND u."instance_role" <> 'instance_admin'
ON CONFLICT ("company_id", "user_id", "resource_type", "resource_id") DO NOTHING;--> statement-breakpoint
UPDATE "company_members" SET "scope_json" = "scope_json" - 'customerIds'
WHERE jsonb_typeof("scope_json") = 'object' AND "scope_json" ? 'customerIds';
