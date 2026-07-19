ALTER TABLE agents ADD COLUMN IF NOT EXISTS deployment_mode text NOT NULL DEFAULT 'remote';
