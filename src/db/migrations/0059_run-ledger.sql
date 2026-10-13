CREATE TABLE "agent_run_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"day" date NOT NULL,
	"runs" integer DEFAULT 0 NOT NULL,
	"succeeded" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"timeout" integer DEFAULT 0 NOT NULL,
	"lost" integer DEFAULT 0 NOT NULL,
	"p50_ms" integer,
	"p95_ms" integer,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"tool_calls" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid,
	"runtime_id" text,
	"runtime_kind" text,
	"bridge_version" text,
	"trigger_kind" text DEFAULT 'other' NOT NULL,
	"trigger_message_id" uuid,
	"thread_id" uuid,
	"task_id" uuid,
	"reply_message_id" uuid,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"ended_at" timestamp,
	"duration_ms" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_cents" integer,
	"tool_calls" integer,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "message_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"addressed" boolean NOT NULL,
	"route_reason" text NOT NULL,
	"agent_streak" integer DEFAULT 0 NOT NULL,
	"max_turns" integer DEFAULT 0 NOT NULL,
	"decided_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_run_daily" ADD CONSTRAINT "agent_run_daily_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_daily" ADD CONSTRAINT "agent_run_daily_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_routes" ADD CONSTRAINT "message_routes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_run_daily_company_agent_day_unique" ON "agent_run_daily" USING btree ("company_id","agent_id","day");--> statement-breakpoint
CREATE INDEX "agent_run_daily_day_idx" ON "agent_run_daily" USING btree ("day");--> statement-breakpoint
CREATE INDEX "agent_runs_company_agent_started_idx" ON "agent_runs" USING btree ("company_id","agent_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "agent_runs_trigger_message_idx" ON "agent_runs" USING btree ("trigger_message_id");--> statement-breakpoint
CREATE INDEX "agent_runs_running_idx" ON "agent_runs" USING btree ("status") WHERE "agent_runs"."status" = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "message_routes_message_agent_unique" ON "message_routes" USING btree ("message_id","agent_id");--> statement-breakpoint
CREATE INDEX "message_routes_decided_at_idx" ON "message_routes" USING btree ("decided_at");