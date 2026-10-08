CREATE TABLE "paired_workers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker_id" text NOT NULL,
	"company_id" uuid,
	"agent_id" uuid,
	"pending_token_encrypted" text,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "paired_workers" ADD CONSTRAINT "paired_workers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paired_workers" ADD CONSTRAINT "paired_workers_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "paired_workers_worker_id_unique" ON "paired_workers" USING btree ("worker_id");