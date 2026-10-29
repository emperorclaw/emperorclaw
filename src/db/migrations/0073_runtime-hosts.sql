CREATE TABLE "runtime_host_job_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"at" timestamp DEFAULT now() NOT NULL,
	"step" text,
	"line" text
);
--> statement-breakpoint
CREATE TABLE "runtime_host_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"host_id" uuid NOT NULL,
	"agent_id" uuid,
	"batch_id" uuid,
	"command" text NOT NULL,
	"args_json" jsonb DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text,
	"minted_token_hash" text,
	"requested_by_user_id" uuid,
	"result_json" jsonb,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"sent_at" timestamp,
	"started_at" timestamp,
	"finished_at" timestamp,
	"deadline_at" timestamp,
	"progress_truncated" boolean DEFAULT false NOT NULL,
	CONSTRAINT "runtime_host_jobs_command_check" CHECK ("runtime_host_jobs"."command" IN ('provision_agent', 'update_runtime', 'restart_agent', 'remove_agent', 'rotate_agent_token', 'refresh_inventory', 'disconnect')),
	CONSTRAINT "runtime_host_jobs_status_check" CHECK ("runtime_host_jobs"."status" IN ('queued', 'sent', 'running', 'succeeded', 'failed', 'timed_out', 'canceled', 'lost'))
);
--> statement-breakpoint
CREATE TABLE "runtime_host_pairings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"created_by_user_id" uuid,
	"expires_at" timestamp NOT NULL,
	"used_at" timestamp,
	"host_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runtime_hosts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"hostname" text,
	"host_fingerprint" text NOT NULL,
	"os" text,
	"arch" text,
	"token_hash" text NOT NULL,
	"status" text DEFAULT 'offline' NOT NULL,
	"protocol" integer,
	"hostd_version" text,
	"installer_version" text,
	"bridge_version" text,
	"hermes_version" text,
	"inventory_json" jsonb DEFAULT '{}' NOT NULL,
	"last_seen_at" timestamp,
	"connected_at" timestamp,
	"offline_reason" text,
	"duplicate_daemon_at" timestamp,
	"created_by_user_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"revoked_at" timestamp,
	CONSTRAINT "runtime_hosts_status_check" CHECK ("runtime_hosts"."status" IN ('online', 'offline', 'revoked'))
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "runtime_host_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "runtime_profile" text;--> statement-breakpoint
ALTER TABLE "runtime_host_job_events" ADD CONSTRAINT "runtime_host_job_events_job_id_runtime_host_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."runtime_host_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_host_jobs" ADD CONSTRAINT "runtime_host_jobs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_host_jobs" ADD CONSTRAINT "runtime_host_jobs_host_id_runtime_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."runtime_hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_host_jobs" ADD CONSTRAINT "runtime_host_jobs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_host_jobs" ADD CONSTRAINT "runtime_host_jobs_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_host_pairings" ADD CONSTRAINT "runtime_host_pairings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_host_pairings" ADD CONSTRAINT "runtime_host_pairings_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_host_pairings" ADD CONSTRAINT "runtime_host_pairings_host_id_runtime_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."runtime_hosts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_hosts" ADD CONSTRAINT "runtime_hosts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_hosts" ADD CONSTRAINT "runtime_hosts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_host_job_events_job_seq_unique" ON "runtime_host_job_events" USING btree ("job_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_host_jobs_idempotency_unique" ON "runtime_host_jobs" USING btree ("company_id","idempotency_key") WHERE "runtime_host_jobs"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "runtime_host_jobs_host_status_idx" ON "runtime_host_jobs" USING btree ("host_id","status","created_at");--> statement-breakpoint
CREATE INDEX "runtime_host_jobs_agent_idx" ON "runtime_host_jobs" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_host_pairings_code_hash_unique" ON "runtime_host_pairings" USING btree ("code_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_hosts_token_hash_unique" ON "runtime_hosts" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_hosts_company_fingerprint_unique" ON "runtime_hosts" USING btree ("company_id","host_fingerprint") WHERE "runtime_hosts"."revoked_at" IS NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_runtime_host_id_runtime_hosts_id_fk" FOREIGN KEY ("runtime_host_id") REFERENCES "public"."runtime_hosts"("id") ON DELETE set null ON UPDATE no action;