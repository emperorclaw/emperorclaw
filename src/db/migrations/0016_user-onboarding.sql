ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "onboarding_completed_at" timestamp;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "onboarding_dismissed_at" timestamp;
