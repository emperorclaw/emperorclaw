CREATE TABLE "inbox_item_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"item_key" text NOT NULL,
	"read_at" timestamp,
	"read_fingerprint" text,
	"archived_at" timestamp,
	"archived_fingerprint" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inbox_item_state" ADD CONSTRAINT "inbox_item_state_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_item_state" ADD CONSTRAINT "inbox_item_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_item_state_company_user_item_unique" ON "inbox_item_state" USING btree ("company_id","user_id","item_key");