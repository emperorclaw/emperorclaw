CREATE TABLE "agent_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"token_id" uuid,
	"agent_id" uuid,
	"task_id" uuid,
	"thread_id" uuid,
	"message_id" uuid,
	"source" text NOT NULL,
	"requested_by" text,
	"external_ref" text,
	"idempotency_key" text,
	"prompt" text NOT NULL,
	"notified_status" text,
	"callback_attempts" integer DEFAULT 0 NOT NULL,
	"callback_last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_tokens" ADD COLUMN "callback_url_encrypted" text;--> statement-breakpoint
ALTER TABLE "company_tokens" ADD COLUMN "callback_url_hint" text;--> statement-breakpoint
ALTER TABLE "agent_requests" ADD CONSTRAINT "agent_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_requests" ADD CONSTRAINT "agent_requests_token_id_company_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."company_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_requests" ADD CONSTRAINT "agent_requests_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_requests" ADD CONSTRAINT "agent_requests_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_requests" ADD CONSTRAINT "agent_requests_thread_id_message_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."message_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_requests" ADD CONSTRAINT "agent_requests_message_id_thread_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."thread_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_requests_company_created_idx" ON "agent_requests" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_requests_idempotency_unique" ON "agent_requests" USING btree ("company_id","source","idempotency_key") WHERE "agent_requests"."idempotency_key" IS NOT NULL;