-- Migration: LLM pricing + usage tracking
-- Adds model-aware cost tracking to the budget system.

-- 1. Pricing table
CREATE TABLE IF NOT EXISTS llm_pricing (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider text NOT NULL,
    model text NOT NULL,
    label text NOT NULL,
    input_price_per_1k integer NOT NULL,   -- cents × 100 per 1000 input tokens
    output_price_per_1k integer NOT NULL,  -- cents × 100 per 1000 output tokens
    active boolean DEFAULT true NOT NULL,
    created_at timestamp DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS llm_pricing_provider_model_idx ON llm_pricing(provider, model);

-- 2. Token usage log
CREATE TABLE IF NOT EXISTS token_usage_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    model text NOT NULL,
    input_tokens integer DEFAULT 0 NOT NULL,
    output_tokens integer DEFAULT 0 NOT NULL,
    cost_cents integer DEFAULT 0 NOT NULL, -- cents × 100
    reported_at timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS token_usage_agent_date_idx ON token_usage_log(agent_id, reported_at);
CREATE INDEX IF NOT EXISTS token_usage_company_date_idx ON token_usage_log(company_id, reported_at);

-- 3. Add columns to agents
ALTER TABLE agents ADD COLUMN IF NOT EXISTS llm_model text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS monthly_cost_cents integer NOT NULL DEFAULT 0;

-- 4. Seed pricing data (cents × 100 per 1K tokens)
INSERT INTO llm_pricing (provider, model, label, input_price_per_1k, output_price_per_1k) VALUES
    -- DeepSeek
    ('deepseek', 'deepseek-chat', 'DeepSeek V3', 14, 28),
    ('deepseek', 'deepseek-reasoner', 'DeepSeek R1', 55, 219),
    -- OpenAI
    ('openai', 'gpt-4o', 'GPT-4o', 250, 1000),
    ('openai', 'gpt-4o-mini', 'GPT-4o Mini', 15, 60),
    ('openai', 'gpt-4.1', 'GPT-4.1', 200, 800),
    ('openai', 'gpt-4.1-mini', 'GPT-4.1 Mini', 40, 160),
    ('openai', 'gpt-4.1-nano', 'GPT-4.1 Nano', 10, 40),
    ('openai', 'o3', 'o3', 1000, 4000),
    ('openai', 'o4-mini', 'o4-mini', 110, 440),
    -- Anthropic
    ('anthropic', 'claude-sonnet-4-20250514', 'Claude Sonnet 4', 300, 1500),
    ('anthropic', 'claude-3.5-haiku-20241022', 'Claude 3.5 Haiku', 80, 400),
    ('anthropic', 'claude-opus-4-20250514', 'Claude Opus 4', 1500, 7500),
    -- Google
    ('google', 'gemini-2.5-flash', 'Gemini 2.5 Flash', 15, 60),
    ('google', 'gemini-2.5-pro', 'Gemini 2.5 Pro', 125, 500),
    -- OpenRouter (average prices)
    ('openrouter', 'openrouter-auto', 'OpenRouter (auto)', 50, 150),
    -- Grok
    ('grok', 'grok-3', 'Grok 3', 300, 1500),
    ('grok', 'grok-3-mini', 'Grok 3 Mini', 30, 150)
ON CONFLICT (provider, model) DO UPDATE SET
    label = EXCLUDED.label,
    input_price_per_1k = EXCLUDED.input_price_per_1k,
    output_price_per_1k = EXCLUDED.output_price_per_1k;
