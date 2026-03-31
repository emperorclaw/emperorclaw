ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "customer_id" uuid;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "agent_id" uuid;--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'artifacts_customer_id_customers_id_fk'
    ) THEN
        ALTER TABLE "artifacts"
            ADD CONSTRAINT "artifacts_customer_id_customers_id_fk"
            FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
    END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'artifacts_agent_id_agents_id_fk'
    ) THEN
        ALTER TABLE "artifacts"
            ADD CONSTRAINT "artifacts_agent_id_agents_id_fk"
            FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
    END IF;
END $$;--> statement-breakpoint
