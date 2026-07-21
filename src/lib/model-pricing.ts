/**
 * Model pricing — USD per 1M tokens (input / output).
 * Used to estimate cost from token usage.
 *
 * Prices as of July 2026. Update periodically.
 */
export const MODEL_PRICING: Record<string, { input: number; output: number; label: string }> = {
    // DeepSeek
    "deepseek-chat": { input: 0.27, output: 1.10, label: "DeepSeek V3" },
    "deepseek-reasoner": { input: 0.55, output: 2.19, label: "DeepSeek R1" },
    // OpenAI
    "gpt-4o": { input: 2.50, output: 10.00, label: "GPT-4o" },
    "gpt-4o-mini": { input: 0.15, output: 0.60, label: "GPT-4o Mini" },
    "gpt-5.6": { input: 1.25, output: 10.00, label: "GPT-5.6" },
    "gpt-5.4": { input: 2.50, output: 10.00, label: "GPT-5.4" },
    "gpt-5.3-codex-spark": { input: 0.075, output: 0.30, label: "Codex Spark" },
    "codex-mini-latest": { input: 0.075, output: 0.30, label: "Codex Mini" },
    // Anthropic
    "claude-sonnet-4-20250514": { input: 3.00, output: 15.00, label: "Claude Sonnet 4" },
    "claude-3-5-sonnet-latest": { input: 3.00, output: 15.00, label: "Claude 3.5 Sonnet" },
    "claude-haiku-3-5": { input: 0.80, output: 4.00, label: "Claude Haiku" },
    // Google
    "gemini-2.5-flash": { input: 0.15, output: 0.60, label: "Gemini Flash" },
    "gemini-2.5-pro": { input: 1.25, output: 5.00, label: "Gemini Pro" },
    // Grok
    "grok-4-latest": { input: 2.00, output: 8.00, label: "Grok 4" },
    // OpenRouter fallback
    "openrouter/auto": { input: 1.00, output: 4.00, label: "Auto (OpenRouter)" },
};

/** Estimate cost in USD cents for a given token count */
export function estimateCost(
    modelId: string,
    inputTokens: number,
    outputTokens: number
): number {
    const pricing = MODEL_PRICING[modelId] || MODEL_PRICING["openrouter/auto"];
    const inputCost = (inputTokens / 1_000_000) * pricing.input * 100; // cents
    const outputCost = (outputTokens / 1_000_000) * pricing.output * 100;
    return Math.round(inputCost + outputCost);
}

/** Rough token estimate from character count (~4 chars per token) */
export function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

// NOTE: Budget status is NOT computed here. The single source of truth for
// budget enforcement is POST /api/mcp/agents/report-usage, which prices the
// exact input/output split against the `llm_pricing` DB table and flips
// budget_status (active → warning at 80% → paused at 100%). An earlier
// computeBudgetStatus() helper duplicated that logic incorrectly (it costed
// output tokens at $0) and was unused — removed to avoid drift.
