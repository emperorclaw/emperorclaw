/**
 * Costs by client / project / model / agent (roadmap 11.2).
 *
 * Pure aggregation over "cost facts": agent_runs rolled up by SQL into
 * (day, agent, task, model, provider, cost hint) rows (lib/costs-reads.ts).
 * Everything here is free of DB/Next imports so it runs in the browser, on the
 * server and in unit tests.
 *
 * Cost basis of a run:
 *  - "reported":  the runtime sent a cost (agent_runs.cost_cents);
 *  - "estimated": no usable runtime cost, priced from our llm_pricing table.
 *                 A runtime-reported $0 with tokens (subscription billing,
 *                 e.g. a ChatGPT/Codex plan) is re-priced from the table when
 *                 the model has a price, so it shows what the tokens would
 *                 have cost and is labelled "estimated";
 *  - "unpriced":  no runtime cost and no price for the model (cost 0).
 *
 * Runs without a task are one "Chat (no task)" bucket on every work axis, and
 * runs whose task no longer exists are one "Unknown task" bucket, so the sum
 * of the groups always equals the overall total.
 */
import { pricingModelRefs } from "@/lib/pricing-model-refs";

export type CostBasis = "reported" | "estimated" | "unpriced";
export const COST_BASES: CostBasis[] = ["reported", "estimated", "unpriced"];

/** How the runtime reported cost for the runs in a fact (set by SQL). */
export type CostHint = "reported" | "zero" | "none";

/** One SQL group of runs. Ids are null when the run has no such link. */
export type CostFact = {
    day: string; // YYYY-MM-DD (UTC)
    agentId: string | null;
    agentName: string | null;
    taskId: string | null;
    /** False when the run names a task that no longer exists (or is hidden). */
    taskFound: boolean;
    taskTitle: string | null;
    projectId: string | null;
    projectName: string | null;
    customerId: string | null;
    customerName: string | null;
    model: string | null;
    provider: string | null;
    hint: CostHint;
    runs: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    reasoningTokens: number;
    /** Sum of agent_runs.cost_cents (0 unless hint = "reported"). */
    reportedCents: number;
};

/** An llm_pricing row: cents per 1M tokens. */
export type CostPrice = {
    provider: string;
    model: string;
    inputCentsPer1M: number;
    outputCentsPer1M: number;
};

/**
 * The price for a run's model, or null. Provider namespaces are stripped the
 * same way usage reporting does (pricingModelRefs); a matching provider wins,
 * and conflicting tariffs for an ambiguous model stay unpriced.
 */
export function resolvePrice(prices: CostPrice[], model: string | null, provider: string | null): CostPrice | null {
    if (!model) return null;
    const wantedProvider = provider?.trim().toLowerCase() || null;
    for (const ref of pricingModelRefs(model)) {
        const matches = prices.filter((price) => price.model === ref);
        if (!matches.length) continue;
        const sameProvider = wantedProvider ? matches.filter((price) => price.provider.toLowerCase() === wantedProvider) : [];
        const pool = sameProvider.length ? sameProvider : matches;
        const first = pool[0];
        if (pool.some((price) => price.inputCentsPer1M !== first.inputCentsPer1M || price.outputCentsPer1M !== first.outputCentsPer1M)) return null;
        return first;
    }
    return null;
}

/** Cost and basis of one fact. Estimates keep fractional cents. */
export function priceFact(fact: CostFact, prices: CostPrice[]): { basis: CostBasis; costCents: number } {
    if (fact.hint === "reported") return { basis: "reported", costCents: fact.reportedCents };
    const price = resolvePrice(prices, fact.model, fact.provider);
    if (fact.hint === "zero") {
        if (!price) return { basis: "reported", costCents: 0 };
    } else if (!price) {
        // The runtime reported no usage (a run still going, or one that failed
        // before calling a model): nothing to price, so $0 as reported.
        if (fact.inputTokens + fact.outputTokens === 0) return { basis: "reported", costCents: 0 };
        return { basis: "unpriced", costCents: 0 };
    }
    const costCents = (fact.inputTokens * price.inputCentsPer1M + fact.outputTokens * price.outputCentsPer1M) / 1_000_000;
    return { basis: "estimated", costCents };
}

// ── Grouping ────────────────────────────────────────────────────────────────

export const COST_DIMENSIONS = ["customer", "project", "task", "model", "agent", "day"] as const;
export type CostDimension = (typeof COST_DIMENSIONS)[number];

export const CHAT_KEY = "chat";
export const CHAT_LABEL = "Chat (no task)";
export const UNKNOWN_TASK_KEY = "unknown-task";
export const UNKNOWN_TASK_LABEL = "Unknown task";
export const NO_CLIENT_KEY = "none";
export const NO_CLIENT_LABEL = "No client";
export const NO_AGENT_KEY = "none";
export const OTHER_AGENTS_KEY = "other";
export const OTHER_AGENTS_LABEL = "Other agents";

/** "provider::model" — the By model key (and its drill-down filter value). */
export function modelKey(provider: string | null, model: string | null): string {
    return `${provider ?? ""}::${model ?? ""}`;
}

type GroupIdentity = { key: string; label: string; detail: string | null; special: boolean };

export function groupIdentity(fact: CostFact, dimension: CostDimension): GroupIdentity {
    const work = (dimension === "customer" || dimension === "project" || dimension === "task");
    if (work && !fact.taskId) return { key: CHAT_KEY, label: CHAT_LABEL, detail: null, special: true };
    if (work && !fact.taskFound) return { key: UNKNOWN_TASK_KEY, label: UNKNOWN_TASK_LABEL, detail: null, special: true };
    switch (dimension) {
        case "customer":
            return fact.customerId
                ? { key: fact.customerId, label: fact.customerName || "Unnamed client", detail: null, special: false }
                : { key: NO_CLIENT_KEY, label: NO_CLIENT_LABEL, detail: "Internal projects", special: true };
        case "project":
            return { key: fact.projectId ?? UNKNOWN_TASK_KEY, label: fact.projectName || "Untitled project", detail: fact.customerName ?? NO_CLIENT_LABEL, special: false };
        case "task":
            return { key: fact.taskId!, label: fact.taskTitle || "Untitled task", detail: fact.projectName, special: false };
        case "model":
            return { key: modelKey(fact.provider, fact.model), label: fact.model || "Unknown model", detail: fact.provider, special: !fact.model };
        case "agent":
            if (fact.agentId === OTHER_AGENTS_KEY) return { key: OTHER_AGENTS_KEY, label: OTHER_AGENTS_LABEL, detail: "Outside your scope", special: true };
            return fact.agentId
                ? { key: fact.agentId, label: fact.agentName || "Unnamed agent", detail: null, special: false }
                : { key: NO_AGENT_KEY, label: "Deleted agent", detail: null, special: true };
        case "day":
            return { key: fact.day, label: fact.day, detail: null, special: false };
    }
}

export type BasisSplit = Record<CostBasis, { costCents: number; runs: number }>;

export type CostTotals = {
    runs: number;
    inputTokens: number;
    outputTokens: number;
    /** input + output (input already includes cached prompt tokens). */
    tokens: number;
    cacheReadTokens: number;
    reasoningTokens: number;
    costCents: number;
    basis: BasisSplit;
    /** Tokens of unpriced runs (their cost is unknown, counted as 0). */
    unpricedTokens: number;
};

export type CostGroup = CostTotals & GroupIdentity & {
    /** Share of the overall cost, 0..1 (0 when the total is 0). */
    share: number;
};

function emptyTotals(): CostTotals {
    return {
        runs: 0, inputTokens: 0, outputTokens: 0, tokens: 0, cacheReadTokens: 0, reasoningTokens: 0, costCents: 0,
        basis: { reported: { costCents: 0, runs: 0 }, estimated: { costCents: 0, runs: 0 }, unpriced: { costCents: 0, runs: 0 } },
        unpricedTokens: 0,
    };
}

function addFact(into: CostTotals, fact: CostFact, priced: { basis: CostBasis; costCents: number }) {
    into.runs += fact.runs;
    into.inputTokens += fact.inputTokens;
    into.outputTokens += fact.outputTokens;
    into.tokens += fact.inputTokens + fact.outputTokens;
    into.cacheReadTokens += fact.cacheReadTokens;
    into.reasoningTokens += fact.reasoningTokens;
    into.costCents += priced.costCents;
    into.basis[priced.basis].costCents += priced.costCents;
    into.basis[priced.basis].runs += fact.runs;
    if (priced.basis === "unpriced") into.unpricedTokens += fact.inputTokens + fact.outputTokens;
}

export type CostBreakdown = { total: CostTotals; groups: CostGroup[] };

/**
 * Totals and one group per key of `dimension`, most expensive first (ties by
 * runs, then label). Every fact lands in exactly one group, so the groups
 * always add up to the total.
 */
export function aggregateCosts(facts: CostFact[], prices: CostPrice[], dimension: CostDimension): CostBreakdown {
    const total = emptyTotals();
    const groups = new Map<string, CostGroup>();
    for (const fact of facts) {
        const priced = priceFact(fact, prices);
        addFact(total, fact, priced);
        const identity = groupIdentity(fact, dimension);
        let group = groups.get(identity.key);
        if (!group) {
            group = { ...emptyTotals(), ...identity, share: 0 };
            groups.set(identity.key, group);
        }
        addFact(group, fact, priced);
    }
    const list = [...groups.values()];
    for (const group of list) group.share = total.costCents > 0 ? group.costCents / total.costCents : 0;
    list.sort((a, b) => b.costCents - a.costCents || b.runs - a.runs || a.label.localeCompare(b.label));
    return { total, groups: list };
}

/** Share of the cost that is estimated (0..1). */
export function estimatedShare(totals: CostTotals): number {
    return totals.costCents > 0 ? totals.basis.estimated.costCents / totals.costCents : 0;
}

/** Facts narrowed to one drill-down (customer, project, model or agent key). */
export type CostFilter = { customer?: string; project?: string; model?: string; agent?: string };

export function filterFacts(facts: CostFact[], filter: CostFilter): CostFact[] {
    return facts.filter((fact) =>
        (filter.customer === undefined || groupIdentity(fact, "customer").key === filter.customer)
        && (filter.project === undefined || groupIdentity(fact, "project").key === filter.project)
        && (filter.model === undefined || groupIdentity(fact, "model").key === filter.model)
        && (filter.agent === undefined || groupIdentity(fact, "agent").key === filter.agent));
}

/** One point per day of the range (UTC), zero-filled. */
export function dailySeries(facts: CostFact[], prices: CostPrice[], range: { from: Date; to: Date }): { day: string; costCents: number; runs: number }[] {
    const byDay = new Map<string, { costCents: number; runs: number }>();
    for (const fact of facts) {
        const entry = byDay.get(fact.day) ?? { costCents: 0, runs: 0 };
        entry.costCents += priceFact(fact, prices).costCents;
        entry.runs += fact.runs;
        byDay.set(fact.day, entry);
    }
    const out: { day: string; costCents: number; runs: number }[] = [];
    for (let at = range.from.getTime(); at < range.to.getTime(); at += DAY_MS) {
        const day = new Date(at).toISOString().slice(0, 10);
        out.push({ day, ...(byDay.get(day) ?? { costCents: 0, runs: 0 }) });
    }
    return out;
}

// ── Date ranges ─────────────────────────────────────────────────────────────

export const DAY_MS = 86_400_000;
export const MAX_RANGE_DAYS = 366;
export const RANGE_PRESETS = ["7d", "30d", "90d", "this-month", "last-month", "custom"] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];
export const RANGE_PRESET_LABELS: Record<RangePreset, string> = {
    "7d": "7 days", "30d": "30 days", "90d": "90 days", "this-month": "This month", "last-month": "Last month", custom: "Custom",
};

/** [from, to) in UTC whole days; `to` is exclusive. */
export type CostRange = { preset: RangePreset; from: Date; to: Date; days: number };

function utcDay(date: Date): Date {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function parseDay(value: string | undefined): Date | null {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date;
}

export function isoDay(date: Date): string {
    return date.toISOString().slice(0, 10);
}

/**
 * The range for a preset. "custom" takes inclusive YYYY-MM-DD bounds (swapped
 * when reversed, capped at MAX_RANGE_DAYS ending on `to`); a bad custom range
 * falls back to the last 30 days.
 */
export function resolveRange(preset: RangePreset, now: Date, custom: { from?: string; to?: string } = {}): CostRange {
    const today = utcDay(now);
    const tomorrow = new Date(today.getTime() + DAY_MS);
    const make = (p: RangePreset, from: Date, to: Date): CostRange => ({ preset: p, from, to, days: Math.round((to.getTime() - from.getTime()) / DAY_MS) });
    switch (preset) {
        case "7d": return make(preset, new Date(tomorrow.getTime() - 7 * DAY_MS), tomorrow);
        case "90d": return make(preset, new Date(tomorrow.getTime() - 90 * DAY_MS), tomorrow);
        case "this-month": return make(preset, new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)), tomorrow);
        case "last-month": return make(preset,
            new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1)),
            new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)));
        case "custom": {
            let from = parseDay(custom.from);
            let to = parseDay(custom.to);
            if (!from || !to) return resolveRange("30d", now);
            if (from > to) [from, to] = [to, from];
            const end = new Date(to.getTime() + DAY_MS);
            const start = end.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS ? new Date(end.getTime() - MAX_RANGE_DAYS * DAY_MS) : from;
            return make(preset, start, end);
        }
        default: return make("30d", new Date(tomorrow.getTime() - 30 * DAY_MS), tomorrow);
    }
}

// ── URL state ───────────────────────────────────────────────────────────────

export const COST_TABS = ["customer", "project", "model", "agent", "budgets"] as const;
export type CostTab = (typeof COST_TABS)[number];
export const COST_TAB_LABELS: Record<CostTab, string> = {
    customer: "By client", project: "By project", model: "By model", agent: "By agent", budgets: "Budgets",
};

export type CostsQuery = {
    tab: CostTab;
    /** The grouping shown: the tab's, or "task" when drilling into a project. */
    dimension: CostDimension | null;
    range: CostRange;
    filter: CostFilter;
};

type RawParams = Record<string, string | string[] | undefined> | URLSearchParams;

function param(params: RawParams, name: string): string | undefined {
    const value = params instanceof URLSearchParams ? params.get(name) ?? undefined : params[name];
    const first = Array.isArray(value) ? value[0] : value;
    const trimmed = first?.trim();
    return trimmed ? trimmed.slice(0, 300) : undefined;
}

/** Parse /costs search params (unknown values fall back to defaults). */
export function parseCostsQuery(params: RawParams, now: Date): CostsQuery {
    const rawTab = param(params, "tab");
    const tab: CostTab = (COST_TABS as readonly string[]).includes(rawTab ?? "") ? rawTab as CostTab : "customer";
    const rawPreset = param(params, "range");
    const preset: RangePreset = (RANGE_PRESETS as readonly string[]).includes(rawPreset ?? "") ? rawPreset as RangePreset : "30d";
    const range = resolveRange(preset, now, { from: param(params, "from"), to: param(params, "to") });
    const filter: CostFilter = {};
    for (const key of ["customer", "project", "model", "agent"] as const) {
        const value = param(params, key);
        if (value !== undefined) filter[key] = value;
    }
    const dimension: CostDimension | null = tab === "budgets" ? null
        : tab === "project" && filter.project !== undefined ? "task"
            : tab;
    return { tab, dimension, range, filter };
}

/** Search params for a costs URL (keeps the range; drops empty values). */
export function costsSearch(query: { tab: CostTab; range: CostRange; filter?: CostFilter }): string {
    const params = new URLSearchParams();
    params.set("tab", query.tab);
    params.set("range", query.range.preset);
    if (query.range.preset === "custom") {
        params.set("from", isoDay(query.range.from));
        params.set("to", isoDay(new Date(query.range.to.getTime() - DAY_MS)));
    }
    for (const [key, value] of Object.entries(query.filter ?? {})) if (value !== undefined) params.set(key, value);
    return params.toString();
}

/** Where a group row drills to inside Costs, or null (chat and unknown buckets never link). */
export function drillDown(group: Pick<CostGroup, "key" | "special">, dimension: CostDimension, range: CostRange): string | null {
    switch (dimension) {
        case "customer":
            if (group.key === CHAT_KEY || group.key === UNKNOWN_TASK_KEY) return null;
            return `/costs?${costsSearch({ tab: "project", range, filter: { customer: group.key } })}`;
        case "project":
            if (group.special) return null;
            return `/costs?${costsSearch({ tab: "project", range, filter: { project: group.key } })}`;
        case "task":
            return group.special ? null : `/projects/tasks/${encodeURIComponent(group.key)}`;
        case "model":
            return `/costs?${costsSearch({ tab: "agent", range, filter: { model: group.key } })}`;
        case "agent":
            if (group.special) return null;
            return `/costs?${costsSearch({ tab: "model", range, filter: { agent: group.key } })}`;
        default:
            return null;
    }
}

// ── Formatting & CSV ────────────────────────────────────────────────────────

/** Cents → "$12.34"; sub-cent spend reads "<$0.01", never "$0.00". */
export function formatUsd(cents: number): string {
    if (!Number.isFinite(cents) || cents === 0) return "$0.00";
    if (cents > 0 && cents < 1) return "<$0.01";
    return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatTokens(tokens: number): string {
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1)}M`;
    if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens >= 10_000 ? 0 : 1)}K`;
    return String(tokens);
}

/**
 * One CSV cell. Quotes cells holding a comma, quote or line break (doubling
 * quotes), and defuses spreadsheet formulas: a text cell starting with = + - @
 * tab or CR gets a leading apostrophe. Numbers are written as-is.
 */
export function csvCell(value: string | number | null | undefined): string {
    if (value === null || value === undefined) return "";
    if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
    let text = value;
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: (string | number | null | undefined)[][]): string {
    return rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

const DIMENSION_HEADER: Record<CostDimension, string> = {
    customer: "Client", project: "Project", task: "Task", model: "Model", agent: "Agent", day: "Day",
};
const DETAIL_HEADER: Record<CostDimension, string> = {
    customer: "Detail", project: "Client", task: "Project", model: "Provider", agent: "Detail", day: "Detail",
};

const dollars = (cents: number) => Math.round(cents * 100) / 10_000; // cents → USD, 4 decimals

/** The current view as CSV: one row per group plus a Total row. */
export function costsCsv(breakdown: CostBreakdown, dimension: CostDimension): string {
    const header = [DIMENSION_HEADER[dimension], DETAIL_HEADER[dimension], "Runs", "Input tokens", "Output tokens", "Total tokens",
        "Cost (USD)", "Share (%)", "Reported (USD)", "Estimated (USD)", "Unpriced runs"];
    const line = (label: string, detail: string | null, t: CostTotals, share: number) => [
        label, detail, t.runs, t.inputTokens, t.outputTokens, t.tokens, dollars(t.costCents), Math.round(share * 10_000) / 100,
        dollars(t.basis.reported.costCents), dollars(t.basis.estimated.costCents), t.basis.unpriced.runs,
    ];
    return toCsv([
        header,
        ...breakdown.groups.map((group) => line(group.label, group.detail, group, group.share)),
        line("Total", null, breakdown.total, breakdown.total.costCents > 0 ? 1 : 0),
    ]);
}
