ALTER TABLE "agents" ALTER COLUMN "monthly_budget_cents" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "monthly_budget_cents" DROP NOT NULL;