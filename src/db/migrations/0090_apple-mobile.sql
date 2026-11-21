CREATE TABLE "mobile_authorization_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code_hash" text NOT NULL,
	"browser_session_id" uuid NOT NULL,
	"challenge" text NOT NULL,
	"device_name" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp,
	CONSTRAINT "mobile_authorization_codes_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "mobile_commands" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"status" integer,
	"response" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mobile_push_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"token_encrypted" text NOT NULL,
	"environment" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"kinds" jsonb DEFAULT '["approval","agent_failed","agent_down","mention"]'::jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mobile_push_devices_device_id_unique" UNIQUE("device_id")
);
--> statement-breakpoint
CREATE TABLE "mobile_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"device_name" text NOT NULL,
	"device_kind" text NOT NULL,
	"access_hash" text NOT NULL,
	"refresh_hash" text NOT NULL,
	"access_expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mobile_sessions_session_id_unique" UNIQUE("session_id"),
	CONSTRAINT "mobile_sessions_access_hash_unique" UNIQUE("access_hash"),
	CONSTRAINT "mobile_sessions_refresh_hash_unique" UNIQUE("refresh_hash")
);
--> statement-breakpoint
ALTER TABLE "mobile_authorization_codes" ADD CONSTRAINT "mobile_authorization_codes_browser_session_id_sessions_id_fk" FOREIGN KEY ("browser_session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mobile_commands" ADD CONSTRAINT "mobile_commands_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mobile_commands" ADD CONSTRAINT "mobile_commands_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mobile_push_devices" ADD CONSTRAINT "mobile_push_devices_device_id_mobile_sessions_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."mobile_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mobile_sessions" ADD CONSTRAINT "mobile_sessions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;