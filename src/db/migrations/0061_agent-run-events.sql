CREATE TABLE "agent_run_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"agent_id" uuid,
	"thread_id" uuid,
	"seq" integer NOT NULL,
	"ts" timestamp NOT NULL,
	"kind" text NOT NULL,
	"tool_name" text,
	"tool_call_id" text,
	"status" text,
	"duration_ms" integer,
	"summary" text,
	"data" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "cache_read_tokens" integer;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "cache_write_tokens" integer;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "reasoning_tokens" integer;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "api_calls" integer;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "exit_reason" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "queue_ms" integer;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "first_token_ms" integer;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "compactions" integer;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "events_dropped" integer;--> statement-breakpoint
ALTER TABLE "runtime_nodes" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "runtime_nodes" ADD COLUMN "bridge_version" text;--> statement-breakpoint
ALTER TABLE "runtime_nodes" ADD COLUMN "bridge_protocol" integer;--> statement-breakpoint
ALTER TABLE "runtime_nodes" ADD COLUMN "hermes_version" text;--> statement-breakpoint
ALTER TABLE "runtime_nodes" ADD COLUMN "transport" text;--> statement-breakpoint
ALTER TABLE "runtime_nodes" ADD COLUMN "deploy_mode" text;--> statement-breakpoint
ALTER TABLE "runtime_nodes" ADD COLUMN "gateway_topology" text;--> statement-breakpoint
ALTER TABLE "runtime_nodes" ADD COLUMN "host_fingerprint" text;--> statement-breakpoint
ALTER TABLE "agent_run_events" ADD CONSTRAINT "agent_run_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_events" ADD CONSTRAINT "agent_run_events_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_events" ADD CONSTRAINT "agent_run_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_run_events_run_seq_uq" ON "agent_run_events" USING btree ("run_id","seq");--> statement-breakpoint
CREATE INDEX "agent_run_events_company_created_idx" ON "agent_run_events" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_run_events_created_idx" ON "agent_run_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "agent_run_events_agent_idx" ON "agent_run_events" USING btree ("agent_id");--> statement-breakpoint
ALTER TABLE "runtime_nodes" ADD CONSTRAINT "runtime_nodes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_thread_started_idx" ON "agent_runs" USING btree ("thread_id","started_at" DESC NULLS LAST);