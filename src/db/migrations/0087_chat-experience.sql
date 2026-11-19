CREATE TABLE "chat_response_previews" (
	"response_id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"segment_index" integer NOT NULL,
	"revision" integer NOT NULL,
	"text" text NOT NULL,
	"state" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "thread_messages" ADD COLUMN "client_message_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_response_previews" ADD CONSTRAINT "chat_response_previews_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_response_previews" ADD CONSTRAINT "chat_response_previews_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_response_previews" ADD CONSTRAINT "chat_response_previews_thread_id_message_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."message_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_response_previews" ADD CONSTRAINT "chat_response_previews_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_response_previews_run_segment_idx" ON "chat_response_previews" USING btree ("run_id","segment_index");--> statement-breakpoint
CREATE INDEX "chat_response_previews_thread_idx" ON "chat_response_previews" USING btree ("company_id","thread_id","updated_at");--> statement-breakpoint
CREATE INDEX "chat_response_previews_expiry_idx" ON "chat_response_previews" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "thread_messages_client_message_idx" ON "thread_messages" USING btree ("company_id","sender_id","client_message_id");