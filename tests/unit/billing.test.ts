import test from "node:test";
import assert from "node:assert/strict";
import {
    splitLegacyTokens,
    priceUsageCents,
    nextBudgetStatus,
    type BudgetStatus,
} from "../../src/lib/billing";

test("splitLegacyTokens splits 80/20 and clamps negatives", () => {
    assert.deepEqual(splitLegacyTokens(1000), { inputTokens: 800, outputTokens: 200 });
    assert.deepEqual(splitLegacyTokens(0), { inputTokens: 0, outputTokens: 0 });
    assert.deepEqual(splitLegacyTokens(-50), { inputTokens: 0, outputTokens: 0 });
});

test("priceUsageCents matches cents-per-1M pricing (gpt-4o: 250/1000 → $2.50/$10 per 1M)", () => {
    // 1M input tokens at 250 cents/1M = 250 cents ($2.50)
    assert.equal(priceUsageCents({ inputTokens: 1_000_000, outputTokens: 0, inputCentsPer1M: 250, outputCentsPer1M: 1000 }), 250);
    // 1M output tokens at 1000 cents/1M = 1000 cents ($10.00)
    assert.equal(priceUsageCents({ inputTokens: 0, outputTokens: 1_000_000, inputCentsPer1M: 250, outputCentsPer1M: 1000 }), 1000);
    // Combined + rounding
    assert.equal(priceUsageCents({ inputTokens: 500_000, outputTokens: 250_000, inputCentsPer1M: 250, outputCentsPer1M: 1000 }), 375);
    // Sub-cent usage rounds to 0
    assert.equal(priceUsageCents({ inputTokens: 100, outputTokens: 100, inputCentsPer1M: 14, outputCentsPer1M: 28 }), 0);
    // Negative/garbage inputs are clamped, never NaN
    assert.equal(priceUsageCents({ inputTokens: -5, outputTokens: 0, inputCentsPer1M: 250, outputCentsPer1M: 1000 }), 0);
});

test("nextBudgetStatus: unlimited budget never enforces", () => {
    assert.equal(nextBudgetStatus({ spentCents: 999999, budgetCents: 0, current: "active" }), "active");
    assert.equal(nextBudgetStatus({ spentCents: 999999, budgetCents: -1, current: "active" }), "active");
});

test("nextBudgetStatus: escalates active → warning → paused at the right thresholds", () => {
    assert.equal(nextBudgetStatus({ spentCents: 500, budgetCents: 1000, current: "active" }), "active");   // 50%
    assert.equal(nextBudgetStatus({ spentCents: 800, budgetCents: 1000, current: "active" }), "warning");  // 80%
    assert.equal(nextBudgetStatus({ spentCents: 999, budgetCents: 1000, current: "warning" }), "warning"); // 99.9%
    assert.equal(nextBudgetStatus({ spentCents: 1000, budgetCents: 1000, current: "warning" }), "paused"); // 100%
    assert.equal(nextBudgetStatus({ spentCents: 2000, budgetCents: 1000, current: "active" }), "paused");  // over from active
});

test("nextBudgetStatus is monotonic — never de-escalates on its own", () => {
    // Already paused, spend drops below 100% (e.g. mid-month) → stays paused
    assert.equal(nextBudgetStatus({ spentCents: 500, budgetCents: 1000, current: "paused" }), "paused");
    // Warning stays warning at 85% even though warn-threshold only escalates from active
    const s: BudgetStatus = nextBudgetStatus({ spentCents: 850, budgetCents: 1000, current: "warning" });
    assert.equal(s, "warning");
});
