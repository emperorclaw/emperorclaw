CREATE TABLE IF NOT EXISTS "platform_admins" (
    "user_id" uuid PRIMARY KEY REFERENCES "users"("id") ON DELETE cascade NOT NULL,
    "role" text DEFAULT 'admin' NOT NULL,
    "created_by" uuid REFERENCES "users"("id") ON DELETE set null,
    "created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "resellers" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "name" text NOT NULL,
    "email" text NOT NULL,
    "user_id" uuid REFERENCES "users"("id") ON DELETE set null,
    "company_id" uuid REFERENCES "companies"("id") ON DELETE set null,
    "commission_rate" numeric(5,2) DEFAULT 0 NOT NULL,
    "status" text DEFAULT 'active' NOT NULL,
    "notes" text,
    "brand_color" text DEFAULT '#6366f1',
    "created_by" uuid REFERENCES "users"("id") ON DELETE set null,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL,
    "deleted_at" timestamp
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reseller_orgs" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "reseller_id" uuid NOT NULL REFERENCES "resellers"("id") ON DELETE cascade,
    "organization_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
    "created_at" timestamp DEFAULT now() NOT NULL,
    UNIQUE("reseller_id", "organization_id")
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reseller_commissions" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "reseller_id" uuid NOT NULL REFERENCES "resellers"("id") ON DELETE cascade,
    "organization_id" uuid REFERENCES "companies"("id") ON DELETE set null,
    "amount" numeric(12,2) NOT NULL,
    "currency" text DEFAULT 'EUR' NOT NULL,
    "commission_amount" numeric(12,2) NOT NULL,
    "status" text DEFAULT 'pending' NOT NULL,
    "paid_at" timestamp,
    "notes" text,
    "created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "resellers_email_unique_idx" ON "resellers" ("email") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "resellers_status_idx" ON "resellers" ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reseller_commissions_reseller_status_idx" ON "reseller_commissions" ("reseller_id", "status");
