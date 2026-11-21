CREATE TABLE IF NOT EXISTS "mobile_sessions" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "session_id" uuid NOT NULL UNIQUE REFERENCES "sessions"("id") ON DELETE CASCADE,
    "device_name" text NOT NULL,
    "device_kind" text NOT NULL,
    "access_hash" text NOT NULL UNIQUE,
    "refresh_hash" text NOT NULL UNIQUE,
    "access_expires_at" timestamp NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mobile_authorization_codes" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "code_hash" text NOT NULL UNIQUE,
    "browser_session_id" uuid NOT NULL REFERENCES "sessions"("id") ON DELETE CASCADE,
    "challenge" text NOT NULL,
    "device_name" text NOT NULL,
    "expires_at" timestamp NOT NULL,
    "consumed_at" timestamp
);
