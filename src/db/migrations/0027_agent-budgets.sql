ALTER TABLE agents ADD COLUMN IF NOT EXISTS monthly_budget_cents integer NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS monthly_token_usage integer NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS budget_status text NOT NULL DEFAULT 'active';
