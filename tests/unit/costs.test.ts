import test from "node:test";
import assert from "node:assert/strict";
import {
    aggregateCosts,
    CHAT_KEY,
    CHAT_LABEL,
    costsCsv,
    costsSearch,
    COST_DIMENSIONS,
    csvCell,
    dailySeries,
    drillDown,
    estimatedShare,
    filterFacts,
    formatUsd,
    isoDay,
    modelKey,
    NO_CLIENT_KEY,
    parseCostsQuery,
    priceFact,
    resolvePrice,
    resolveRange,
    toCsv,
    UNKNOWN_TASK_KEY,
    type CostFact,
    type CostPrice,
} from "../../src/lib/costs";

const PRICES: CostPrice[] = [
    { provider: "deepseek", model: "deepseek-chat", inputCentsPer1M: 27, outputCentsPer1M: 110 },
    { provider: "openai", model: "gpt-5.4", inputCentsPer1M: 250, outputCentsPer1M: 1000 },
];

function fact(overrides: Partial<CostFact> = {}): CostFact {
    return {
        day: "2026-10-20", agentId: "agent-a", agentName: "Ada", taskId: "task-1", taskFound: true, taskTitle: "Write report",
        projectId: "project-1", projectName: "Launch", customerId: "customer-1", customerName: "Acme",
        model: "deepseek-chat", provider: "deepseek", hint: "reported", runs: 1, inputTokens: 1000, outputTokens: 500,
        cacheReadTokens: 0, reasoningTokens: 0, reportedCents: 10, ...overrides,
    };
}

/** A mixed month: two clients, an internal project, chat, a deleted task, three cost bases. */
const FACTS: CostFact[] = [
    fact(),
    fact({ day: "2026-10-21", hint: "none", reportedCents: 0, inputTokens: 2_000_000, outputTokens: 1_000_000 }),
    fact({ taskId: "task-2", taskTitle: "Fix bug", projectId: "project-2", projectName: "Ops", customerId: "customer-2", customerName: "Globex", agentId: "agent-b", agentName: "Bo", model: "gpt-5.4", provider: "openai", hint: "zero", reportedCents: 0, runs: 2, inputTokens: 400_000, outputTokens: 100_000 }),
    fact({ taskId: "task-3", projectId: "project-3", projectName: "Internal", customerId: null, customerName: null, hint: "none", model: "mystery-model", provider: "custom", reportedCents: 0, runs: 3 }),
    fact({ taskId: null, taskFound: false, taskTitle: null, projectId: null, projectName: null, customerId: null, customerName: null, reportedCents: 7, runs: 4 }),
    fact({ taskId: "task-gone", taskFound: false, taskTitle: null, projectId: null, projectName: null, customerId: null, customerName: null, reportedCents: 3 }),
    fact({ agentId: null, agentName: null, reportedCents: 5, day: "2026-10-22" }),
];

test("cost basis: reported from the runtime, estimated from the table, unpriced without a price", () => {
    assert.deepEqual(priceFact(fact(), PRICES), { basis: "reported", costCents: 10 });
    // 2M in * 27 + 1M out * 110 (cents per 1M) = 54 + 110
    assert.deepEqual(priceFact(fact({ hint: "none", reportedCents: 0, inputTokens: 2_000_000, outputTokens: 1_000_000 }), PRICES), { basis: "estimated", costCents: 164 });
    assert.deepEqual(priceFact(fact({ hint: "none", model: "unknown", reportedCents: 0 }), PRICES), { basis: "unpriced", costCents: 0 });
    // No usage reported (running, or failed before a model call): $0, not an unknown or an estimate.
    assert.deepEqual(priceFact(fact({ hint: "none", model: "unknown", inputTokens: 0, outputTokens: 0, reportedCents: 0 }), PRICES), { basis: "reported", costCents: 0 });
});

test("a runtime-reported $0 with tokens (subscription) is re-priced as estimated when the model has a price", () => {
    const sub = fact({ model: "gpt-5.4", provider: "openai", hint: "zero", reportedCents: 0, inputTokens: 1_000_000, outputTokens: 0 });
    assert.deepEqual(priceFact(sub, PRICES), { basis: "estimated", costCents: 250 });
    assert.deepEqual(priceFact({ ...sub, model: "no-price" }, PRICES), { basis: "reported", costCents: 0 });
});

test("pricing strips provider namespaces, prefers the run's provider and refuses conflicting tariffs", () => {
    assert.equal(resolvePrice(PRICES, "openrouter/openai/gpt-5.4", null)?.inputCentsPer1M, 250);
    assert.equal(resolvePrice(PRICES, null, "openai"), null);
    const conflicting: CostPrice[] = [
        { provider: "openrouter", model: "kimi", inputCentsPer1M: 10, outputCentsPer1M: 20 },
        { provider: "moonshot", model: "kimi", inputCentsPer1M: 12, outputCentsPer1M: 20 },
    ];
    assert.equal(resolvePrice(conflicting, "kimi", null), null);
    assert.equal(resolvePrice(conflicting, "kimi", "Moonshot")?.inputCentsPer1M, 12);
});

test("every dimension reconciles: the groups add up to the overall total", () => {
    const overall = aggregateCosts(FACTS, PRICES, "customer").total;
    for (const dimension of COST_DIMENSIONS) {
        const { total, groups } = aggregateCosts(FACTS, PRICES, dimension);
        const sum = (pick: (g: typeof groups[number]) => number) => groups.reduce((acc, g) => acc + pick(g), 0);
        assert.ok(Math.abs(sum((g) => g.costCents) - total.costCents) < 1e-9, `${dimension} cost`);
        assert.equal(sum((g) => g.runs), total.runs, `${dimension} runs`);
        assert.equal(sum((g) => g.tokens), total.tokens, `${dimension} tokens`);
        assert.ok(Math.abs(sum((g) => g.share) - 1) < 1e-9, `${dimension} share`);
        assert.ok(Math.abs(total.costCents - overall.costCents) < 1e-9);
        assert.equal(total.runs, FACTS.reduce((acc, f) => acc + f.runs, 0));
    }
});

test("chat runs get one Chat (no task) bucket; deleted tasks and internal projects get their own", () => {
    const { groups } = aggregateCosts(FACTS, PRICES, "customer");
    const byKey = new Map(groups.map((g) => [g.key, g]));
    assert.equal(byKey.get(CHAT_KEY)?.label, CHAT_LABEL);
    assert.equal(byKey.get(CHAT_KEY)?.runs, 4);
    assert.equal(byKey.get(CHAT_KEY)?.costCents, 7);
    assert.equal(byKey.get(UNKNOWN_TASK_KEY)?.costCents, 3);
    assert.equal(byKey.get(NO_CLIENT_KEY)?.basis.unpriced.runs, 3);
    // Acme: 10 reported + 164 estimated + 5 reported (deleted agent's run)
    assert.ok(Math.abs(byKey.get("customer-1")!.costCents - 179) < 1e-9);
    assert.equal(groups[0].key, "customer-2", "most expensive first (200 estimated)");
});

test("cost basis split and estimated share", () => {
    const { total } = aggregateCosts(FACTS, PRICES, "model");
    assert.equal(total.basis.reported.costCents, 10 + 7 + 3 + 5);
    // 164 (deepseek) + 400k*250/1M + 100k*1000/1M = 164 + 100 + 100
    assert.ok(Math.abs(total.basis.estimated.costCents - 364) < 1e-9);
    assert.equal(total.basis.unpriced.runs, 3);
    assert.equal(total.unpricedTokens, 1500);
    assert.ok(Math.abs(estimatedShare(total) - 364 / 389) < 1e-9);
    assert.equal(estimatedShare(aggregateCosts([], PRICES, "model").total), 0);
});

test("drill-down filters narrow facts by group key", () => {
    assert.equal(filterFacts(FACTS, { customer: "customer-2" }).length, 1);
    assert.equal(filterFacts(FACTS, { customer: CHAT_KEY }).length, 1);
    assert.equal(filterFacts(FACTS, { model: modelKey("deepseek", "deepseek-chat") }).length, 5);
    assert.equal(filterFacts(FACTS, { agent: "none" }).length, 1);
    const range = resolveRange("30d", new Date("2026-10-27T12:00:00Z"));
    assert.equal(drillDown({ key: CHAT_KEY, special: true }, "customer", range), null);
    assert.equal(drillDown({ key: "customer-1", special: false }, "customer", range), "/costs?tab=project&range=30d&customer=customer-1");
    assert.equal(drillDown({ key: "project-1", special: false }, "project", range), "/costs?tab=project&range=30d&project=project-1");
    assert.equal(drillDown({ key: "task-1", special: false }, "task", range), "/projects/tasks/task-1");
    assert.equal(drillDown({ key: "openai::gpt-5.4", special: false }, "model", range), "/costs?tab=agent&range=30d&model=openai%3A%3Agpt-5.4");
});

test("date presets resolve to whole UTC days with an exclusive end", () => {
    const now = new Date("2026-10-27T15:30:00Z");
    const seven = resolveRange("7d", now);
    assert.equal(isoDay(seven.from), "2026-10-21");
    assert.equal(seven.to.toISOString(), "2026-10-28T00:00:00.000Z");
    assert.equal(seven.days, 7);
    assert.equal(resolveRange("90d", now).days, 90);
    const thisMonth = resolveRange("this-month", now);
    assert.equal(isoDay(thisMonth.from), "2026-10-01");
    assert.equal(thisMonth.days, 27);
    const lastMonth = resolveRange("last-month", new Date("2026-01-05T00:00:00Z"));
    assert.equal(isoDay(lastMonth.from), "2025-12-01");
    assert.equal(isoDay(lastMonth.to), "2026-01-01");
    const custom = resolveRange("custom", now, { from: "2026-10-10", to: "2026-10-01" });
    assert.equal(isoDay(custom.from), "2026-10-01");
    assert.equal(isoDay(custom.to), "2026-10-11");
    assert.equal(custom.days, 10);
    assert.equal(resolveRange("custom", now, { from: "2020-01-01", to: "2026-10-01" }).days, 366);
    assert.equal(resolveRange("custom", now, { from: "2026-02-30", to: "2026-03-01" }).preset, "30d");
});

test("query parsing falls back to safe defaults and keeps drill-downs", () => {
    const now = new Date("2026-10-27T00:00:00Z");
    const q = parseCostsQuery({ tab: "evil", range: "nope" }, now);
    assert.equal(q.tab, "customer");
    assert.equal(q.range.preset, "30d");
    const drill = parseCostsQuery(new URLSearchParams("tab=project&project=p1&range=custom&from=2026-10-01&to=2026-10-05"), now);
    assert.equal(drill.dimension, "task");
    assert.deepEqual(drill.filter, { project: "p1" });
    assert.equal(costsSearch(drill), "tab=project&range=custom&from=2026-10-01&to=2026-10-05&project=p1");
    assert.equal(parseCostsQuery({ tab: "budgets" }, now).dimension, null);
});

test("daily series is zero-filled across the range", () => {
    const range = resolveRange("custom", new Date(), { from: "2026-10-19", to: "2026-10-23" });
    const series = dailySeries(FACTS, PRICES, range);
    assert.deepEqual(series.map((p) => p.day), ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"]);
    assert.equal(series[0].costCents, 0);
    assert.equal(series[2].costCents, 164);
    assert.ok(Math.abs(series.reduce((a, p) => a + p.costCents, 0) - aggregateCosts(FACTS, PRICES, "day").total.costCents) < 1e-9);
});

test("CSV escaping quotes separators, doubles quotes and defuses formulas", () => {
    assert.equal(csvCell("plain"), "plain");
    assert.equal(csvCell("Acme, Inc."), "\"Acme, Inc.\"");
    assert.equal(csvCell("say \"hi\""), "\"say \"\"hi\"\"\"");
    assert.equal(csvCell("line\nbreak"), "\"line\nbreak\"");
    assert.equal(csvCell("=HYPERLINK(\"x\")"), "\"'=HYPERLINK(\"\"x\"\")\"");
    assert.equal(csvCell("+1"), "'+1");
    assert.equal(csvCell("@cmd"), "'@cmd");
    assert.equal(csvCell(-3), "-3");
    assert.equal(csvCell(null), "");
    assert.equal(csvCell(Number.NaN), "");
    assert.equal(toCsv([["a", 1], ["b,c", 2]]), "a,1\r\n\"b,c\",2\r\n");
});

test("the CSV export has a header, one row per group and a reconciling Total", () => {
    const breakdown = aggregateCosts(FACTS, PRICES, "customer");
    const lines = costsCsv(breakdown, "customer").trim().split("\r\n");
    assert.equal(lines[0].split(",")[0], "Client");
    assert.equal(lines.length, breakdown.groups.length + 2);
    assert.match(lines[lines.length - 1], /^Total,,13,/);
    assert.ok(lines.some((line) => line.startsWith("Chat (no task),")));
});

test("money formatting never shows sub-cent spend as zero", () => {
    assert.equal(formatUsd(0), "$0.00");
    assert.equal(formatUsd(0.4), "<$0.01");
    assert.equal(formatUsd(123456), "$1,234.56");
});
