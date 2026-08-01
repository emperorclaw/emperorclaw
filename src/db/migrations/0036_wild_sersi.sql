ALTER TABLE "agents" ALTER COLUMN "monthly_cost_cents" TYPE double precision;
--> statement-breakpoint
ALTER TABLE "token_usage_log" ALTER COLUMN "cost_cents" TYPE double precision;
