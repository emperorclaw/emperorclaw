import { test } from "node:test";
import assert from "node:assert/strict";
import {
    buildWidgetDocument,
    formatChartValue,
    hasRichBlocks,
    niceTicks,
    parseChartSpec,
    parseStats,
    splitTabs,
    widgetTitle,
    WIDGET_CSP,
} from "../../src/lib/rich-blocks";

test("parseChartSpec reads the documented labels + series shape", () => {
    const spec = parseChartSpec(JSON.stringify({
        type: "bar",
        title: "Tasks closed",
        labels: ["Mon", "Tue", "Wed"],
        series: [{ name: "Ada", data: [3, 5, 2] }, { name: "Viktor", data: [1, 4] }],
        stacked: true,
    }));
    assert.ok(spec);
    assert.equal(spec.type, "bar");
    assert.equal(spec.title, "Tasks closed");
    assert.deepEqual(spec.labels, ["Mon", "Tue", "Wed"]);
    assert.equal(spec.series.length, 2);
    // Short series are padded so every series lines up with the labels.
    assert.deepEqual(spec.series[1].data, [1, 4, 0]);
    assert.equal(spec.stacked, true);
});

test("parseChartSpec accepts label/value records and row records", () => {
    const pie = parseChartSpec(JSON.stringify({ type: "doughnut", data: [{ label: "Done", value: 7 }, { label: "Open", value: "3" }] }));
    assert.ok(pie);
    assert.equal(pie.type, "donut");
    assert.deepEqual(pie.labels, ["Done", "Open"]);
    assert.deepEqual(pie.series[0].data, [7, 3]);

    const rows = parseChartSpec(JSON.stringify({ type: "line", x: "month", data: [{ month: "Jan", cost: 10, tokens: 4 }, { month: "Feb", cost: 12, tokens: 6 }] }));
    assert.ok(rows);
    assert.deepEqual(rows.labels, ["Jan", "Feb"]);
    assert.deepEqual(rows.series.map((s) => s.name), ["cost", "tokens"]);
});

test("parseChartSpec maps hbar aliases and rejects junk", () => {
    const spec = parseChartSpec(JSON.stringify({ type: "hbar", labels: ["a"], series: [[1]] }));
    assert.equal(spec?.type, "bar");
    assert.equal(spec?.horizontal, true);
    assert.equal(parseChartSpec("not json"), null);
    assert.equal(parseChartSpec("[1,2,3]"), null);
    assert.equal(parseChartSpec(JSON.stringify({ type: "bar", series: [] })), null);
});

test("parseChartSpec drops colors that could escape an SVG attribute", () => {
    const spec = parseChartSpec(JSON.stringify({ labels: ["a"], series: [{ name: "x", data: [1], color: "red\" onload=\"alert(1)" }, { name: "y", data: [2], color: "#22c55e" }] }));
    assert.equal(spec?.series[0].color, undefined);
    assert.equal(spec?.series[1].color, "#22c55e");
});

test("niceTicks produces round, covering ticks", () => {
    assert.deepEqual(niceTicks(0, 87, 4), [0, 20, 40, 60, 80, 100]);
    assert.deepEqual(niceTicks(0, 0), [0, 1]);
    const negative = niceTicks(-12, 30, 4);
    assert.ok(negative[0] <= -12 && negative[negative.length - 1] >= 30);
});

test("formatChartValue compacts large numbers and places units", () => {
    assert.equal(formatChartValue(1_250_000, "$", "", true), "$1.3M");
    assert.equal(formatChartValue(42, "", "%"), "42%");
    assert.equal(formatChartValue(3.14159, "", "ms"), "3.14 ms");
    assert.equal(formatChartValue(12_500, "", "", true), "12.5k");
});

test("parseStats infers trend and tone from the delta", () => {
    const items = parseStats(JSON.stringify([
        { label: "Tasks done", value: 42, delta: "+12%" },
        { label: "Error rate", value: "0.4%", delta: "-0.2 pts", good: "down" },
        { label: "Budget used", value: "$18", progress: 0.36 },
        { value: "missing label" },
    ]));
    assert.ok(items);
    assert.equal(items.length, 3);
    assert.equal(items[0].trend, "up");
    assert.equal(items[0].tone, "positive");
    assert.equal(items[1].trend, "down");
    assert.equal(items[1].tone, "positive");
    assert.equal(items[2].progress, 36);
    assert.equal(parseStats("{}"), null);
});

test("splitTabs splits on === markers but not inside nested fences", () => {
    const tabs = splitTabs([
        "Intro line",
        "=== Overview",
        "Hello",
        "=== Code",
        "```md",
        "=== not a tab",
        "```",
    ].join("\n"));
    assert.ok(tabs);
    assert.deepEqual(tabs.map((t) => t.label), ["Overview", "Overview", "Code"]);
    assert.equal(tabs[1].content, "Hello");
    assert.ok(tabs[2].content.includes("=== not a tab"));
    assert.equal(splitTabs("no markers here"), null);
});

test("hasRichBlocks detects rich fences only", () => {
    assert.equal(hasRichBlocks("```chart\n{}\n```"), true);
    assert.equal(hasRichBlocks("text\n````tabs\n=== A\n````"), true);
    assert.equal(hasRichBlocks("```ts\nconst chart = 1\n```"), false);
    assert.equal(hasRichBlocks("| a | b |\n|---|---|"), false);
});

test("buildWidgetDocument puts the CSP first and tags messages with the token", () => {
    const doc = buildWidgetDocument("<h1>Hi</h1>", {
        token: "tok-123",
        theme: { foreground: "oklch(0.9 0 0)", "bad;name": "x", primary: "red;}body{display:none" },
        colorScheme: "dark",
    });
    const cspIndex = doc.indexOf("Content-Security-Policy");
    assert.ok(cspIndex > 0 && cspIndex < doc.indexOf("<h1>Hi</h1>"));
    assert.ok(doc.includes(WIDGET_CSP.replace(/'/g, "'")));
    assert.ok(doc.includes("connect-src 'none'"));
    assert.ok(doc.includes("--foreground:oklch(0.9 0 0);"));
    // Token values that could break out of the style block are dropped.
    assert.ok(!doc.includes("display:none"));
    assert.ok(!doc.includes("bad;name"));
    assert.ok(doc.includes("\"tok-123\""));
});

test("widgetTitle prefers the title comment, then <title>, then a heading", () => {
    assert.equal(widgetTitle("<!-- title: Agent load --><div></div>"), "Agent load");
    assert.equal(widgetTitle("<title>Board</title><h1>Other</h1>"), "Board");
    assert.equal(widgetTitle("<h2>Pipeline <b>health</b></h2>"), "Pipeline health");
    assert.equal(widgetTitle("<div></div>"), "Interactive widget");
});

test("every example in the agent reply guide renders with the real parsers", async () => {
    const { RICH_REPLY_GUIDE } = await import("../../src/lib/rich-reply-guide");
    const fences = [...RICH_REPLY_GUIDE.matchAll(/^(`{3,})(\w+)\n([\s\S]*?)^\1$/gm)].map((m) => ({ lang: m[2], body: m[3] }));
    const langs = fences.map((f) => f.lang).sort();
    assert.deepEqual(langs, ["chart", "html", "stats", "tabs"]);
    for (const { lang, body } of fences) {
        if (lang === "chart") assert.ok(parseChartSpec(body), "chart example parses");
        if (lang === "stats") assert.equal(parseStats(body)?.length, 3);
        if (lang === "tabs") assert.deepEqual(splitTabs(body)?.map((t) => t.label), ["Summary", "Details"]);
        if (lang === "html") assert.equal(widgetTitle(body), "Agent load");
    }
});

test("repairMarkdownTables fixes a delimiter row with the wrong cell count", async () => {
    const { repairMarkdownTables } = await import("../../src/lib/rich-blocks");
    const input = "| Agent | Tokens | Cost |\n|---|---:|---:|---:|\n| Builder | 302,428 | $25.42 |";
    const out = repairMarkdownTables(input).split("\n");
    assert.equal(out[1], "| --- | ---: | ---: |");
    assert.equal(out[2], "| Builder | 302,428 | $25.42 |");
    // Too few delimiter cells are padded.
    assert.equal(repairMarkdownTables("| a | b | c |\n|---|---|\n| 1 | 2 | 3 |").split("\n")[1], "| --- | --- | --- |");
});

test("repairMarkdownTables unflattens a table emitted on one line", async () => {
    const { repairMarkdownTables } = await import("../../src/lib/rich-blocks");
    const input = "Per-agent stats:\n| Agent | Model | Load | |---|---|---:| | Builder | deepseek-v4-pro | 1 | | QA | deepseek-v4-flash | 0 |\nTotals: 2";
    const out = repairMarkdownTables(input).split("\n");
    assert.deepEqual(out, [
        "Per-agent stats:",
        "",
        "| Agent | Model | Load |",
        "| --- | --- | ---: |",
        "| Builder | deepseek-v4-pro | 1 |",
        "| QA | deepseek-v4-flash | 0 |",
        "Totals: 2",
    ]);
});

test("repairMarkdownTables leaves good tables and fenced code alone", async () => {
    const { repairMarkdownTables } = await import("../../src/lib/rich-blocks");
    const good = "| a | b |\n|---|---|\n| 1 | 2 |";
    assert.equal(repairMarkdownTables(good), good);
    const fenced = "```md\n| a | b |\n|---|---|---|\n```";
    assert.equal(repairMarkdownTables(fenced), fenced);
    assert.equal(repairMarkdownTables("a | b - c"), "a | b - c");
});

test("repairMarkdownTables recovers a real flattened table with a bad delimiter", async () => {
    const { repairMarkdownTables } = await import("../../src/lib/rich-blocks");
    const input = "Per-agent stats, September-to-date.\n| Agent | Model | Status | Load | Open tasks | Closed tasks | Tokens (mo) | Cost (mo) | |---|---|---|---|---|---|---:|---:|---:| | Builder | deepseek-v4-pro | online | 1 | 5 | 1 | 302,428 | $25.42 | | SEO (operator) | — | online | 0 | 0 | 0 | 0 | $0.00 |\nTotals: ~469,589 tokens, $29.84 this month.";
    const out = repairMarkdownTables(input).split("\n");
    assert.equal(out[1], "");
    assert.equal(out[2], "| Agent | Model | Status | Load | Open tasks | Closed tasks | Tokens (mo) | Cost (mo) |");
    assert.equal(out[3], "| --- | --- | --- | --- | --- | --- | ---: | ---: |");
    assert.equal(out[4], "| Builder | deepseek-v4-pro | online | 1 | 5 | 1 | 302,428 | $25.42 |");
    assert.equal(out[5], "| SEO (operator) | — | online | 0 | 0 | 0 | 0 | $0.00 |");
    assert.equal(out[6], "Totals: ~469,589 tokens, $29.84 this month.");
});
