CREATE TABLE "thread_message_reasoning" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"reasoning" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "thread_message_reasoning_message_id_unique" UNIQUE("message_id")
);
--> statement-breakpoint
ALTER TABLE "thread_message_reasoning" ADD CONSTRAINT "thread_message_reasoning_message_id_thread_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."thread_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_message_reasoning" ADD CONSTRAINT "thread_message_reasoning_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "thread_message_reasoning_company_created_idx" ON "thread_message_reasoning" USING btree ("company_id","created_at");