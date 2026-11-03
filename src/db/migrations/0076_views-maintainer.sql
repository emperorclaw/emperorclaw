ALTER TABLE "views" ADD COLUMN "maintainer_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "views" ADD CONSTRAINT "views_maintainer_agent_id_agents_id_fk" FOREIGN KEY ("maintainer_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Backfill: until now the building agent was the maintainer (created_by_type = 'agent').
-- Only agents that still exist in the view's company (created_by_id has no foreign key).
UPDATE "views" AS v SET "maintainer_agent_id" = v."created_by_id"
FROM "agents" AS a
WHERE v."created_by_type" = 'agent' AND v."created_by_id" IS NOT NULL
  AND a."id" = v."created_by_id" AND a."company_id" = v."company_id";
