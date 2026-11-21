CREATE TABLE IF NOT EXISTS "mobile_commands" (
  "id" uuid PRIMARY KEY NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "request_hash" text NOT NULL,
  "status" integer,
  "response" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mobile_push_devices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "device_id" uuid NOT NULL UNIQUE REFERENCES "mobile_sessions"("id") ON DELETE CASCADE,
  "token_encrypted" text NOT NULL,
  "environment" text NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "kinds" jsonb DEFAULT '["approval","agent_failed","agent_down","mention"]'::jsonb NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
