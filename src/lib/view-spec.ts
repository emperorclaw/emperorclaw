// Views (roadmap 0.15): the declarative format agents build dashboards in.
//
// A view is a 12-column grid of typed panels. The LAYOUT (panel id, type,
// title, width, height) is the view's spec and is versioned; each panel's
// VALUES are its data, pushed separately with update_panel so a refresh never
// rewrites the layout. Agents never send HTML: everything here is rendered by
// our own components, and this module is the only gate between an agent's
// JSON and the page.
//
// Pure and client-safe (zod only). Unit-tested in tests/unit/view-spec.test.ts.

import { z } from "zod";

export const VIEW_PANEL_TYPES = ["metric", "line", "bar", "table", "list", "markdown", "progress"] as const;
export type ViewPanelType = (typeof VIEW_PANEL_TYPES)[number];

export const VIEW_SCOPE_TYPES = ["company", "customer", "project"] as const;
export type ViewScopeType = (typeof VIEW_SCOPE_TYPES)[number];

export const VIEW_GRID_COLUMNS = 12;
export const VIEW_PANEL_MAX_HEIGHT = 8;
export const VIEW_MAX_PANELS = 40;
/** Everything one create_view / update_view call sends (layout plus inline data). */
export const VIEW_SPEC_MAX_BYTES = 256 * 1024;
/** One update_panel payload. */
export const VIEW_PANEL_DATA_MAX_BYTES = 256 * 1024;
/** All panel data a view may hold at once. */
export const VIEW_TOTAL_DATA_MAX_BYTES = 512 * 1024;
export const VIEW_TITLE_MAX = 160;
export const VIEW_DESCRIPTION_MAX = 1000;
export const VIEW_TABLE_MAX_ROWS = 500;
export const VIEW_TABLE_MAX_COLUMNS = 20;
export const VIEW_LIST_MAX_ITEMS = 200;
export const VIEW_MARKDOWN_MAX = 20_000;
export const VIEW_CHART_MAX_SERIES = 12;
export const VIEW_CHART_MAX_POINTS = 500;
export const VIEW_CHART_MAX_TOTAL_POINTS = 2000;
/** Numbers beyond this are almost certainly a unit mistake (and break chart scales). */
const NUMBER_LIMIT = 1e15;

// ─── Primitives ──────────────────────────────────────────────────────────────

/** Raw HTML of any kind, script URLs and HTML data URLs: never valid anywhere in a view. */
const FORBIDDEN_TEXT: { re: RegExp; reason: string }[] = [
    { re: /<\/?[a-z!?]/i, reason: "HTML is not allowed" },
    { re: /\b(?:java|vb)script\s*:/i, reason: "script URLs are not allowed" },
    { re: /\bdata\s*:\s*text\/html/i, reason: "HTML data URLs are not allowed" },
];
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const LINE_BREAKS = /[\r\n\t]/;

/** A plain-text string: trimmed, length-capped, single line unless `multiline`, no HTML or script URLs. */
function text(max: number, options: { multiline?: boolean; min?: number } = {}) {
    return z.string().trim().min(options.min ?? 0).max(max).superRefine((value, ctx) => {
        if (CONTROL_CHARS.test(value) || (!options.multiline && LINE_BREAKS.test(value))) {
            ctx.addIssue({ code: "custom", message: "contains control characters or line breaks" });
            return;
        }
        for (const rule of FORBIDDEN_TEXT) {
            if (rule.re.test(value)) {
                ctx.addIssue({ code: "custom", message: rule.reason });
                return;
            }
        }
    });
}

const finite = z.number().refine((n) => Number.isFinite(n) && Math.abs(n) <= NUMBER_LIMIT, { message: "must be a finite number" });

/**
 * A link: an absolute http(s) URL, or a relative app path ("/projects?...").
 * Protocol-relative ("//host"), backslashes and every other scheme are refused.
 */
export function isSafeViewHref(value: string): boolean {
    if (typeof value !== "string" || value.length === 0 || value.length > 2000) return false;
    if (/[\s\\]/.test(value) || CONTROL_CHARS.test(value)) return false;
    if (value.startsWith("/")) return !value.startsWith("//");
    if (!/^https?:\/\//i.test(value)) return false;
    try {
        const url = new URL(value);
        return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
    } catch {
        return false;
    }
}

const href = z.string().trim().refine(isSafeViewHref, { message: "must be an http(s) URL or a relative app path starting with /" });

// ─── Layout ──────────────────────────────────────────────────────────────────

const PANEL_ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/i;

/** Sensible sizes when an agent leaves w/h out. */
export const DEFAULT_PANEL_SIZE: Record<ViewPanelType, { w: number; h: number }> = {
    metric: { w: 3, h: 1 },
    progress: { w: 3, h: 1 },
    line: { w: 6, h: 3 },
    bar: { w: 6, h: 3 },
    table: { w: 12, h: 4 },
    list: { w: 4, h: 3 },
    markdown: { w: 6, h: 2 },
};

export const viewPanelLayoutSchema = z.object({
    id: z.string().regex(PANEL_ID_RE, "must be 1-48 letters, digits, - or _"),
    type: z.enum(VIEW_PANEL_TYPES),
    title: text(120, { min: 1 }),
    subtitle: text(200).optional(),
    w: z.number().int().min(1).max(VIEW_GRID_COLUMNS),
    h: z.number().int().min(1).max(VIEW_PANEL_MAX_HEIGHT),
}).strict();

export type ViewPanelLayout = z.infer<typeof viewPanelLayoutSchema>;

export const viewSpecSchema = z.object({
    panels: z.array(viewPanelLayoutSchema).max(VIEW_MAX_PANELS, `a view holds at most ${VIEW_MAX_PANELS} panels`),
}).strict().superRefine((spec, ctx) => {
    const seen = new Set<string>();
    spec.panels.forEach((panel, index) => {
        const key = panel.id.toLowerCase();
        if (seen.has(key)) ctx.addIssue({ code: "custom", path: ["panels", index, "id"], message: `duplicate panel id "${panel.id}"` });
        seen.add(key);
    });
});

export type ViewSpec = z.infer<typeof viewSpecSchema>;

// ─── Panel data ──────────────────────────────────────────────────────────────

const metricData = z.object({
    value: z.union([finite, text(40)]),
    unit: text(16).optional(),
    delta: finite.optional(),
    deltaLabel: text(60).optional(),
    /** A direction, or a short series drawn as a sparkline. */
    trend: z.union([z.enum(["up", "down", "flat"]), z.array(finite).min(2).max(120)]).optional(),
    /** Which way is good for the delta's color (default "up"). */
    goodDirection: z.enum(["up", "down"]).optional(),
}).strict();

const chartData = z.object({
    series: z.array(z.object({
        name: text(80, { min: 1 }),
        points: z.array(z.object({
            x: z.union([text(40), finite]),
            y: finite,
        }).strict()).max(VIEW_CHART_MAX_POINTS),
    }).strict()).min(1).max(VIEW_CHART_MAX_SERIES),
    xLabel: text(60).optional(),
    yLabel: text(60).optional(),
    unit: text(16).optional(),
    stacked: z.boolean().optional(),
}).strict().superRefine((data, ctx) => {
    const total = data.series.reduce((sum, s) => sum + s.points.length, 0);
    if (total > VIEW_CHART_MAX_TOTAL_POINTS) ctx.addIssue({ code: "custom", path: ["series"], message: `at most ${VIEW_CHART_MAX_TOTAL_POINTS} points across all series` });
});

const COLUMN_KEY_RE = /^[A-Za-z0-9_.-]{1,40}$/;
const cell = z.union([text(500), finite, z.boolean(), z.null()]);

const tableData = z.object({
    columns: z.array(z.object({
        key: z.string().regex(COLUMN_KEY_RE, "must be 1-40 letters, digits, _ . or -"),
        label: text(80, { min: 1 }),
        align: z.enum(["left", "right", "center"]).optional(),
        format: z.enum(["text", "number", "integer", "percent", "currency", "date"]).optional(),
        currency: z.string().regex(/^[A-Z]{3}$/, "must be a 3-letter currency code").optional(),
    }).strict()).min(1).max(VIEW_TABLE_MAX_COLUMNS),
    rows: z.array(z.record(z.string(), cell)).max(VIEW_TABLE_MAX_ROWS, `a table holds at most ${VIEW_TABLE_MAX_ROWS} rows`),
}).strict().superRefine((data, ctx) => {
    const keys = new Set<string>();
    data.columns.forEach((column, index) => {
        if (keys.has(column.key)) ctx.addIssue({ code: "custom", path: ["columns", index, "key"], message: `duplicate column key "${column.key}"` });
        keys.add(column.key);
    });
    data.rows.forEach((row, index) => {
        const unknown = Object.keys(row).find((key) => !keys.has(key));
        if (unknown !== undefined) ctx.addIssue({ code: "custom", path: ["rows", index], message: `unknown column "${unknown.slice(0, 40)}"` });
    });
});

const listData = z.object({
    items: z.array(z.object({
        title: text(200, { min: 1 }),
        subtitle: text(300).optional(),
        value: z.union([text(60), finite]).optional(),
        href: href.optional(),
    }).strict()).max(VIEW_LIST_MAX_ITEMS, `a list holds at most ${VIEW_LIST_MAX_ITEMS} items`),
}).strict();

/** Inline link targets: `[label](target "title")`. */
const MARKDOWN_INLINE_LINK = /\]\(\s*<?([^\s)>]*)/g;
/** Reference definitions: `[label]: target`. */
const MARKDOWN_LINK_DEFINITION = /^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*<?([^\s>]*)/gm;

/**
 * Markdown in a view may not load anything: no images (they would be fetched
 * from wherever the agent points them, by every person who opens the page),
 * and links only to http(s) URLs or app paths (isSafeViewHref). Raw HTML is
 * already refused by `text`.
 */
export function viewMarkdownProblem(value: string): string | null {
    if (/!\[/.test(value)) return "images are not allowed in a view; use a list or table panel with a link instead";
    for (const re of [MARKDOWN_INLINE_LINK, MARKDOWN_LINK_DEFINITION]) {
        for (const match of value.matchAll(re)) {
            const target = match[1] ?? "";
            if (!isSafeViewHref(target)) return `links must be http(s) URLs or app paths starting with / (got "${target.slice(0, 60)}")`;
        }
    }
    return null;
}

/** Markdown as stored: read leniently so older values still show (the renderer drops images and unsafe links). */
const storedMarkdownData = z.object({
    text: text(VIEW_MARKDOWN_MAX, { multiline: true }),
}).strict();

const markdownData = storedMarkdownData.superRefine((data, ctx) => {
    const problem = viewMarkdownProblem(data.text);
    if (problem) ctx.addIssue({ code: "custom", path: ["text"], message: problem });
});

const progressData = z.object({
    value: finite,
    max: finite.refine((n) => n > 0, { message: "must be greater than 0" }),
    label: text(120).optional(),
    unit: text(16).optional(),
}).strict();

export const PANEL_DATA_SCHEMAS = {
    metric: metricData,
    line: chartData,
    bar: chartData,
    table: tableData,
    list: listData,
    markdown: markdownData,
    progress: progressData,
} as const;

export type MetricPanelData = z.infer<typeof metricData>;
export type ChartPanelData = z.infer<typeof chartData>;
export type TablePanelData = z.infer<typeof tableData>;
export type ListPanelData = z.infer<typeof listData>;
export type MarkdownPanelData = z.infer<typeof markdownData>;
export type ProgressPanelData = z.infer<typeof progressData>;
export type ViewPanelData = MetricPanelData | ChartPanelData | TablePanelData | ListPanelData | MarkdownPanelData | ProgressPanelData;

// ─── Results ─────────────────────────────────────────────────────────────────

export type SpecResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** "panels[2].data.rows: Too big" — the first few issues, readable by an agent. */
export function describeIssues(error: z.ZodError, prefix: (string | number)[] = []): string {
    return error.issues.slice(0, 5).map((issue) => {
        const path = [...prefix, ...issue.path].reduce<string>((out, part) => (
            typeof part === "number" ? `${out}[${part}]` : out ? `${out}.${String(part)}` : String(part)
        ), "");
        return path ? `${path}: ${issue.message}` : issue.message;
    }).join("; ");
}

export function jsonBytes(value: unknown): number {
    try {
        return new TextEncoder().encode(JSON.stringify(value) ?? "").length;
    } catch {
        return Infinity;
    }
}

function sizeError(bytes: number, max: number, what: string): string | null {
    return bytes > max ? `${what} is ${Math.ceil(bytes / 1024)} KB; the limit is ${Math.floor(max / 1024)} KB` : null;
}

/** Validate a layout (as stored, or as an update_view sends it). */
export function parseViewSpec(input: unknown): SpecResult<ViewSpec> {
    const tooBig = sizeError(jsonBytes(input), VIEW_SPEC_MAX_BYTES, "The view");
    if (tooBig) return { ok: false, error: tooBig };
    const parsed = viewSpecSchema.safeParse(input);
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: describeIssues(parsed.error) };
}

/** Validate one panel's values against its type (update_panel). */
export function parsePanelData(type: ViewPanelType, data: unknown): SpecResult<ViewPanelData> {
    const tooBig = sizeError(jsonBytes(data), VIEW_PANEL_DATA_MAX_BYTES, "The panel data");
    if (tooBig) return { ok: false, error: tooBig };
    const schema = PANEL_DATA_SCHEMAS[type];
    if (!schema) return { ok: false, error: `Unknown panel type "${String(type)}"` };
    const parsed = schema.safeParse(data);
    return parsed.success ? { ok: true, value: parsed.data as ViewPanelData } : { ok: false, error: describeIssues(parsed.error, ["data"]) };
}

// ─── Agent input: panels with inline data ────────────────────────────────────

/** What create_view / update_view accept per panel: id, w and h are optional. */
export type ViewPanelInput = {
    id?: unknown;
    type?: unknown;
    title?: unknown;
    subtitle?: unknown;
    w?: unknown;
    h?: unknown;
    data?: unknown;
};

function slugify(value: string): string {
    return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "panel";
}

/**
 * Turn the panels an agent sends into a layout plus per-panel data. Missing
 * ids are derived from the title ("Revenue this month" → "revenue-this-month",
 * de-duplicated); missing sizes come from DEFAULT_PANEL_SIZE. Every panel's
 * data, when present, is validated against its type.
 */
export function parseViewPanels(input: unknown): SpecResult<{ spec: ViewSpec; data: Record<string, ViewPanelData> }> {
    if (!Array.isArray(input)) return { ok: false, error: "panels must be an array" };
    const tooBig = sizeError(jsonBytes(input), VIEW_SPEC_MAX_BYTES, "The view");
    if (tooBig) return { ok: false, error: tooBig };
    if (input.length > VIEW_MAX_PANELS) return { ok: false, error: `a view holds at most ${VIEW_MAX_PANELS} panels` };

    const used = new Set(input.map((p) => (p && typeof p === "object" && typeof (p as ViewPanelInput).id === "string" ? String((p as ViewPanelInput).id).toLowerCase() : "")).filter(Boolean));
    const layouts: unknown[] = [];
    const rawData: { id: string; type: unknown; data: unknown; index: number }[] = [];
    for (let index = 0; index < input.length; index++) {
        const raw = input[index];
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: `panels[${index}]: must be an object` };
        const panel = raw as ViewPanelInput;
        const extra = Object.keys(panel).find((key) => !["id", "type", "title", "subtitle", "w", "h", "data"].includes(key));
        if (extra) return { ok: false, error: `panels[${index}]: unknown field "${extra.slice(0, 40)}" (panel values go in "data")` };
        let id = typeof panel.id === "string" ? panel.id.trim() : panel.id;
        if (id === undefined || id === "") {
            const base = slugify(typeof panel.title === "string" ? panel.title : `panel-${index + 1}`);
            let candidate = base;
            for (let n = 2; used.has(candidate); n++) candidate = `${base.slice(0, 44)}-${n}`;
            used.add(candidate);
            id = candidate;
        }
        const type = panel.type;
        const size = typeof type === "string" && (VIEW_PANEL_TYPES as readonly string[]).includes(type) ? DEFAULT_PANEL_SIZE[type as ViewPanelType] : { w: 6, h: 2 };
        const layout: Record<string, unknown> = { id, type, title: panel.title, w: panel.w ?? size.w, h: panel.h ?? size.h };
        if (panel.subtitle !== undefined && panel.subtitle !== null && panel.subtitle !== "") layout.subtitle = panel.subtitle;
        layouts.push(layout);
        if (panel.data !== undefined && panel.data !== null) rawData.push({ id: String(id), type, data: panel.data, index });
    }

    const spec = viewSpecSchema.safeParse({ panels: layouts });
    if (!spec.success) return { ok: false, error: describeIssues(spec.error) };

    const data: Record<string, ViewPanelData> = {};
    for (const entry of rawData) {
        const parsed = parsePanelData(entry.type as ViewPanelType, entry.data);
        if (!parsed.ok) return { ok: false, error: `panels[${entry.index}].${parsed.error}` };
        data[entry.id] = parsed.value;
    }
    return { ok: true, value: { spec: spec.data, data } };
}

/** Title / description of a view (create, rename). */
export function parseViewTitle(value: unknown): SpecResult<string> {
    const parsed = text(VIEW_TITLE_MAX, { min: 1 }).safeParse(value);
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: describeIssues(parsed.error, ["title"]) };
}

export function parseViewDescription(value: unknown): SpecResult<string | null> {
    if (value === null || value === undefined || value === "") return { ok: true, value: null };
    const parsed = text(VIEW_DESCRIPTION_MAX, { multiline: true }).safeParse(value);
    if (!parsed.success) return { ok: false, error: describeIssues(parsed.error, ["description"]) };
    return { ok: true, value: parsed.data || null };
}

// ─── Versions ────────────────────────────────────────────────────────────────

/** Key order-independent comparison of two stored layouts. */
function sameSpec(a: ViewSpec, b: ViewSpec): boolean {
    if (a.panels.length !== b.panels.length) return false;
    return a.panels.every((panel, i) => {
        const other = b.panels[i];
        return panel.id === other.id && panel.type === other.type && panel.title === other.title
            && (panel.subtitle ?? null) === (other.subtitle ?? null) && panel.w === other.w && panel.h === other.h;
    });
}

/**
 * What an update_view (or a revert) does to the version: a new version when
 * the title or the layout actually changes, nothing otherwise. Values pushed
 * with update_panel never version.
 */
export function planViewVersion(
    current: { title: string; spec: ViewSpec; version: number },
    next: { title?: string; spec?: ViewSpec },
): { changed: boolean; version: number; title: string; spec: ViewSpec } {
    const title = next.title ?? current.title;
    const spec = next.spec ?? current.spec;
    const changed = title !== current.title || !sameSpec(current.spec, spec);
    return { changed, version: changed ? current.version + 1 : current.version, title, spec };
}

/** Read a stored spec defensively: anything malformed reads as an empty layout. */
export function storedViewSpec(value: unknown): ViewSpec {
    const parsed = viewSpecSchema.safeParse(value);
    return parsed.success ? parsed.data : { panels: [] };
}

/** Read stored panel data defensively: null when it no longer matches the panel's type. */
export function storedPanelData(type: ViewPanelType, value: unknown): ViewPanelData | null {
    const schema = type === "markdown" ? storedMarkdownData : PANEL_DATA_SCHEMAS[type];
    const parsed = schema ? schema.safeParse(value) : null;
    return parsed?.success ? (parsed.data as ViewPanelData) : null;
}

/**
 * The chat directive the Refresh button sends to the agent that keeps a view
 * fresh. A fixed sentence carrying only the view id: the title, panel titles
 * and values are agent-writable, so none of them may become an instruction to
 * another agent. The agent reads the panels itself with get_view.
 */
export function viewRefreshDirective(view: { id: string }): string {
    const id = String(view.id).replace(/[^0-9a-f-]/gi, "").slice(0, 36);
    return `Please refresh the view ${id} now: call get_view with viewId ${id}, pull fresh numbers from your sources, and call update_panel for each of its panels.`;
}
