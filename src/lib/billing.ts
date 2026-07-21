/**
 * Pure billing/budget helpers — the single source of truth for usage cost and
 * budget-status transitions. Kept free of DB/Next imports so it is trivially
 * unit-testable and cannot drift from the enforcement logic in the routes.
 */

export type BudgetStatus = "active" | "warning" | "paused";

/**
 * Split a legacy total token count into input/output using an 80/20 estimate.
 * Used when a caller reports only `tokensUsed` without an input/output split.
 */
export function splitLegacyTokens(total: number): { inputTokens: number; outputTokens: number } {
    const t = Math.max(0, total || 0);
    return {
        inputTokens: Math.round(t * 0.8),
        outputTokens: Math.round(t * 0.2),
    };
}

/**
 * Cost in whole cents for a usage sample.
 *
 * Prices are stored as **cents per 1,000,000 tokens** (e.g. 250 = $2.50 / 1M).
 * costCents = round((inputTokens * inputCentsPer1M + outputTokens * outputCentsPer1M) / 1e6)
 */
export function priceUsageCents(args: {
    inputTokens: number;
    outputTokens: number;
    inputCentsPer1M: number;
    outputCentsPer1M: number;
}): number {
    const inputTokens = Math.max(0, args.inputTokens || 0);
    const outputTokens = Math.max(0, args.outputTokens || 0);
    const inputCentsPer1M = Math.max(0, args.inputCentsPer1M || 0);
    const outputCentsPer1M = Math.max(0, args.outputCentsPer1M || 0);
    return Math.round((inputTokens * inputCentsPer1M + outputTokens * outputCentsPer1M) / 1_000_000);
}

/**
 * Next budget status given spend vs limit. Monotonic escalation:
 *   - budget <= 0  → unlimited, status unchanged
 *   - spend >= 100% → paused (from any non-paused state)
 *   - spend >= 80%  → warning (only escalates from active)
 *   - otherwise      → unchanged
 *
 * Mirrors the enforcement in POST /api/mcp/agents/report-usage exactly.
 */
export function nextBudgetStatus(args: {
    spentCents: number;
    budgetCents: number;
    current: BudgetStatus;
}): BudgetStatus {
    const { current } = args;
    const budgetCents = args.budgetCents || 0;
    const spentCents = args.spentCents || 0;
    if (budgetCents <= 0) return current; // unlimited — no enforcement
    const pct = spentCents / budgetCents;
    if (pct >= 1.0 && current !== "paused") return "paused";
    if (pct >= 0.8 && current === "active") return "warning";
    return current;
}
