-- Migration: seed OpenRouter's free default model into llm_pricing.
-- Easy Setup hires OpenRouter workers on nvidia/nemotron-3-ultra-550b-a55b:free.
-- A 0/0 pricing row keeps reported usage at $0 and lets budget-capped agents
-- on the free model stay executable (an unpriced model blocks capped agents).

INSERT INTO llm_pricing (provider, model, label, input_price_per_1k, output_price_per_1k) VALUES
    ('openrouter', 'nvidia/nemotron-3-ultra-550b-a55b:free', 'Nemotron 3 Ultra (free)', 0, 0)
ON CONFLICT (provider, model) DO UPDATE SET
    label = EXCLUDED.label,
    input_price_per_1k = EXCLUDED.input_price_per_1k,
    output_price_per_1k = EXCLUDED.output_price_per_1k,
    active = true;
