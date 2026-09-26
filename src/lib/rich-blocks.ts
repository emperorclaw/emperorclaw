/**
 * Rich message blocks — the parsing half of Emperor's rich chat rendering.
 *
 * Agents write ordinary Markdown plus a few fenced blocks whose language tag
 * names a renderer:
 *
 *   ```chart   JSON chart spec        → native SVG chart
 *   ```stats   JSON list of KPI tiles → stat cards
 *   ```tabs    Markdown split by `=== Label` lines → tabbed panel
 *   ```html    self-contained HTML    → sandboxed interactive widget
 *
 * Fences are deliberate: an older Emperor UI, an email digest, or another
 * agent reading history sees a plain code block, never broken markup. Every
 * parser here is pure and total — bad input returns `null` and the caller
 * falls back to showing the fence as code, so a malformed block can never
 * break the message around it.
 */

export const RICH_BLOCK_LANGUAGES = ["chart", "stats", "tabs", "html"] as const;
export type RichBlockLanguage = (typeof RICH_BLOCK_LANGUAGES)[number];

/** Bumped when the agent-facing block contract changes incompatibly. The
 *  bridge only teaches agents the blocks when the server advertises this. */
export const RICH_BLOCKS_CAPABILITY = "rich-blocks-v1";

const RICH_FENCE_RE = /^\s*(`{3,}|~{3,})\s*(chart|stats|tabs|html)\b/im;

export function isRichBlockLanguage(language: string | null | undefined): language is RichBlockLanguage {
    return !!language && (RICH_BLOCK_LANGUAGES as readonly string[]).includes(language.toLowerCase());
}

/** Cheap check used to widen the chat bubble for messages that carry a
 *  chart, tabs, or widget. Tables alone keep the normal bubble. */
export function hasRichBlocks(text: string): boolean {
    return RICH_FENCE_RE.test(text);
}

// ─── Charts ────────────────────────────────────────────────────────────────

export type ChartType = "bar" | "line" | "area" | "pie" | "donut";

export interface ChartSeries {
    name: string;
    data: number[];
    color?: string;
}

export interface ChartSpec {
    type: ChartType;
    title?: string;
    subtitle?: string;
    labels: string[];
    series: ChartSeries[];
    stacked: boolean;
    horizontal: boolean;
    unit?: string;
    prefix?: string;
    height: number;
    /** True when the agent set `height` itself. */
    explicitHeight: boolean;
}

const CHART_TYPES = new Set<ChartType>(["bar", "line", "area", "pie", "donut"]);
const MAX_POINTS = 500;
const MAX_SERIES = 12;

function asText(value: unknown, max = 160): string | undefined {
    if (typeof value !== "string" && typeof value !== "number") return undefined;
    const text = String(value).trim();
    return text ? text.slice(0, max) : undefined;
}

function asNumber(value: unknown): number {
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    if (typeof value === "string") {
        const n = Number(value.replace(/[,_\s%$€£]/g, ""));
        return Number.isFinite(n) ? n : 0;
    }
    return 0;
}

/** Only colors a chart can safely drop into an SVG attribute. */
function asColor(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const color = value.trim();
    if (/^#[0-9a-f]{3,8}$/i.test(color)) return color;
    if (/^(rgb|rgba|hsl|hsla|oklch)\([\d\s.,%/-]+\)$/i.test(color)) return color;
    if (/^var\(--[a-z0-9-]+\)$/i.test(color)) return color;
    if (/^[a-z]{3,20}$/i.test(color)) return color;
    return undefined;
}

/**
 * Parse a ```chart body. Accepts the documented shape plus the shorthands
 * models reach for without being told:
 *   {"data": [{"label": "A", "value": 3}]}             (single series)
 *   {"data": [{"month": "Jan", "a": 1, "b": 2}], "x": "month"}  (row records)
 *   {"series": [{"name": "A", "values": [...]}]}      (values alias)
 */
export function parseChartSpec(source: string): ChartSpec | null {
    let raw: unknown;
    try {
        raw = JSON.parse(source);
    } catch {
        return null;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const input = raw as Record<string, unknown>;

    let typeName = String(input.type || "bar").toLowerCase();
    let horizontal = input.horizontal === true;
    if (typeName === "hbar" || typeName === "horizontal-bar" || typeName === "barh") {
        typeName = "bar";
        horizontal = true;
    }
    if (typeName === "doughnut") typeName = "donut";
    if (typeName === "column") typeName = "bar";
    const type = (CHART_TYPES.has(typeName as ChartType) ? typeName : "bar") as ChartType;

    let labels: string[] = Array.isArray(input.labels)
        ? input.labels.slice(0, MAX_POINTS).map((l) => asText(l, 60) ?? "")
        : [];
    let series: ChartSeries[] = [];

    if (Array.isArray(input.series)) {
        series = input.series.slice(0, MAX_SERIES).flatMap((entry, index) => {
            if (Array.isArray(entry)) {
                return [{ name: `Series ${index + 1}`, data: entry.slice(0, MAX_POINTS).map(asNumber) }];
            }
            if (!entry || typeof entry !== "object") return [];
            const s = entry as Record<string, unknown>;
            const values = Array.isArray(s.data) ? s.data : Array.isArray(s.values) ? s.values : null;
            if (!values) return [];
            return [{
                name: asText(s.name ?? s.label, 60) ?? `Series ${index + 1}`,
                data: values.slice(0, MAX_POINTS).map(asNumber),
                color: asColor(s.color),
            }];
        });
    } else if (Array.isArray(input.data) && input.data.length > 0) {
        const rows = input.data.slice(0, MAX_POINTS).filter((r) => r && typeof r === "object") as Record<string, unknown>[];
        if (rows.length > 0) {
            const first = rows[0];
            const xKey = typeof input.x === "string" && input.x in first
                ? input.x
                : ["label", "name", "x", "category", "date", "month", "day"].find((k) => k in first)
                    ?? Object.keys(first).find((k) => typeof first[k] === "string");
            labels = rows.map((r) => (xKey ? asText(r[xKey], 60) ?? "" : ""));
            const valueKeys = "value" in first
                ? ["value"]
                : Object.keys(first).filter((k) => k !== xKey && rows.some((r) => typeof r[k] === "number" || (typeof r[k] === "string" && asNumber(r[k]) !== 0)));
            series = valueKeys.slice(0, MAX_SERIES).map((key) => ({
                name: key === "value" ? asText(input.name ?? input.title, 60) ?? "Value" : key,
                data: rows.map((r) => asNumber(r[key])),
            }));
        }
    } else if (Array.isArray(input.values)) {
        series = [{ name: asText(input.name, 60) ?? "Value", data: input.values.slice(0, MAX_POINTS).map(asNumber) }];
    }

    series = series.filter((s) => s.data.length > 0);
    if (series.length === 0) return null;

    const length = Math.max(...series.map((s) => s.data.length));
    if (labels.length < length) {
        labels = [...labels, ...Array.from({ length: length - labels.length }, (_, i) => String(labels.length + i + 1))];
    }
    labels = labels.slice(0, length);
    series = series.map((s) => ({ ...s, data: s.data.length < length ? [...s.data, ...Array(length - s.data.length).fill(0)] : s.data }));

    const height = Math.round(asNumber(input.height));
    return {
        type,
        title: asText(input.title),
        subtitle: asText(input.subtitle ?? input.description),
        labels,
        series,
        stacked: input.stacked === true,
        horizontal,
        unit: asText(input.unit ?? input.suffix, 12),
        prefix: asText(input.prefix, 6),
        height: height >= 120 && height <= 640 ? height : type === "pie" || type === "donut" ? 240 : 260,
        explicitHeight: height >= 120 && height <= 640,
    };
}

/** Compact, human number formatting for axes and tooltips. */
export function formatChartValue(value: number, prefix = "", unit = "", compact = false): string {
    const abs = Math.abs(value);
    let body: string;
    if (compact && abs >= 1_000_000_000) body = `${trimZeros((value / 1_000_000_000).toFixed(1))}B`;
    else if (compact && abs >= 1_000_000) body = `${trimZeros((value / 1_000_000).toFixed(1))}M`;
    else if (compact && abs >= 10_000) body = `${trimZeros((value / 1_000).toFixed(1))}k`;
    else if (Number.isInteger(value)) body = value.toLocaleString("en-US");
    else body = value.toLocaleString("en-US", { maximumFractionDigits: abs < 1 ? 3 : 2 });
    const spacer = unit && !/^[%°]/.test(unit) ? " " : "";
    return `${prefix}${body}${unit ? spacer + unit : ""}`;
}

function trimZeros(value: string): string {
    return value.replace(/\.0$/, "");
}

/** Round an axis maximum up to a "nice" number and return evenly spaced ticks. */
export function niceTicks(min: number, max: number, count = 5): number[] {
    if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
    if (min === max) {
        if (max === 0) return [0, 1];
        min = Math.min(0, min);
        max = Math.max(0, max);
    }
    const span = max - min;
    const rawStep = span / Math.max(1, count);
    const magnitude = 10 ** Math.floor(Math.log10(rawStep));
    const residual = rawStep / magnitude;
    // Heckbert's "nice numbers": round the raw step to the nearest 1/2/5/10.
    const step = (residual < 1.5 ? 1 : residual < 3 ? 2 : residual < 7 ? 5 : 10) * magnitude;
    const start = Math.floor(min / step) * step;
    const end = Math.ceil(max / step) * step;
    const ticks: number[] = [];
    for (let v = start; v <= end + step / 2; v += step) ticks.push(Number(v.toPrecision(12)));
    return ticks;
}

// ─── Stats ─────────────────────────────────────────────────────────────────

export type StatTrend = "up" | "down" | "flat";
export type StatTone = "positive" | "negative" | "neutral";

export interface StatItem {
    label: string;
    value: string;
    delta?: string;
    trend?: StatTrend;
    tone: StatTone;
    hint?: string;
    progress?: number;
    spark?: number[];
}

const MAX_STATS = 12;

/** Parse a ```stats body: an array of tiles, or `{"items": [...]}`. */
export function parseStats(source: string): StatItem[] | null {
    let raw: unknown;
    try {
        raw = JSON.parse(source);
    } catch {
        return null;
    }
    const list = Array.isArray(raw)
        ? raw
        : raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).items)
            ? (raw as Record<string, unknown>).items as unknown[]
            : null;
    if (!list) return null;

    const items = list.slice(0, MAX_STATS).flatMap((entry): StatItem[] => {
        if (!entry || typeof entry !== "object") return [];
        const s = entry as Record<string, unknown>;
        const label = asText(s.label ?? s.name ?? s.title, 60);
        const value = asText(s.value, 40);
        if (!label || value === undefined) return [];
        const delta = asText(s.delta ?? s.change, 24);
        let trend = typeof s.trend === "string" && ["up", "down", "flat"].includes(s.trend) ? s.trend as StatTrend : undefined;
        if (!trend && delta) trend = /^\s*[-−↓]/.test(delta) ? "down" : /^\s*[+↑]/.test(delta) ? "up" : undefined;
        // "good" lets a falling error rate read as positive.
        const good = typeof s.good === "string" ? s.good : undefined;
        let tone: StatTone = "neutral";
        if (trend === "up") tone = good === "down" ? "negative" : "positive";
        if (trend === "down") tone = good === "down" ? "positive" : "negative";
        if (typeof s.tone === "string" && ["positive", "negative", "neutral"].includes(s.tone)) tone = s.tone as StatTone;
        const progressRaw = s.progress === undefined ? undefined : asNumber(s.progress);
        const progress = progressRaw === undefined ? undefined : Math.max(0, Math.min(100, progressRaw <= 1 && progressRaw > 0 && String(s.progress).includes(".") ? progressRaw * 100 : progressRaw));
        const sparkRaw = Array.isArray(s.spark) ? s.spark : Array.isArray(s.sparkline) ? s.sparkline : null;
        const spark = sparkRaw && sparkRaw.length >= 2 ? sparkRaw.slice(0, 60).map(asNumber) : undefined;
        return [{ label, value, delta, trend, tone, hint: asText(s.hint ?? s.caption ?? s.note, 80), progress, spark }];
    });
    return items.length > 0 ? items : null;
}

// ─── Tabs ──────────────────────────────────────────────────────────────────

export interface TabSection {
    label: string;
    content: string;
}

const TAB_HEADING_RE = /^\s*={3,}\s+(.+?)\s*=*\s*$/;
const MAX_TABS = 12;

/**
 * Split a ```tabs body on `=== Label` lines. Text before the first marker is
 * ignored when it is blank and becomes an "Overview" tab otherwise. Markers
 * inside nested fences are content, not tab boundaries.
 */
export function splitTabs(source: string): TabSection[] | null {
    const lines = source.replace(/\r\n?/g, "\n").split("\n");
    const tabs: TabSection[] = [];
    let current: TabSection | null = null;
    let preamble: string[] = [];
    let fence: string | null = null;

    for (const line of lines) {
        const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
        if (fenceMatch) {
            const marker = fenceMatch[1];
            if (fence === null) fence = marker;
            else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
        }
        const heading = fence === null ? TAB_HEADING_RE.exec(line) : null;
        if (heading) {
            if (current) tabs.push(current);
            current = { label: heading[1].slice(0, 40), content: "" };
            continue;
        }
        if (current) current.content += (current.content ? "\n" : "") + line;
        else preamble.push(line);
    }
    if (current) tabs.push(current);

    const intro = preamble.join("\n").trim();
    if (intro && tabs.length > 0) tabs.unshift({ label: "Overview", content: intro });
    preamble = [];

    const cleaned = tabs
        .map((t) => ({ label: t.label, content: t.content.trim() }))
        .filter((t) => t.label)
        .slice(0, MAX_TABS);
    return cleaned.length > 0 ? cleaned : null;
}

// ─── HTML widgets ──────────────────────────────────────────────────────────

/** Hard cap on a widget document; larger bodies render as code instead. */
export const MAX_WIDGET_HTML_CHARS = 200_000;

/** Theme tokens handed to widgets under stable, documented names. */
export const WIDGET_THEME_TOKENS = [
    "background",
    "foreground",
    "card",
    "card-foreground",
    "muted",
    "muted-foreground",
    "primary",
    "primary-foreground",
    "accent",
    "accent-foreground",
    "border",
    "destructive",
    "chart-1",
    "chart-2",
    "chart-3",
    "chart-4",
    "chart-5",
] as const;

export function widgetTitle(html: string): string {
    const comment = /<!--\s*title:\s*([^>]*?)\s*-->/i.exec(html)?.[1];
    const title = comment
        || /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]
        || /<h[12][^>]*>([\s\S]*?)<\/h[12]>/i.exec(html)?.[1]
        || "";
    return title.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Interactive widget";
}

/**
 * Content-Security-Policy placed FIRST in every widget document. It stacks on
 * top of the page CSP the srcdoc frame inherits (policies intersect, and a
 * meta policy can't be removed by later markup), so a widget can run its own
 * inline script but cannot fetch, open sockets, submit forms, or pull in
 * external scripts — its only door out is the size/prompt postMessage below.
 */
export const WIDGET_CSP = [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src data: blob: https:",
    "media-src data: blob: https:",
    "font-src data:",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
].join("; ");

function escapeAttr(value: string): string {
    return value.replace(/[&"<>]/g, (c) => ({ "&": "&amp;", "\"": "&quot;", "<": "&lt;", ">": "&gt;" }[c]!));
}

/**
 * Assemble the srcdoc for a widget: CSP, then the theme prelude (so the
 * widget's own styles win), then the bridge script, then the agent's HTML.
 * `token` tags every postMessage so the parent can ignore other frames.
 */
export function buildWidgetDocument(html: string, options: {
    token: string;
    theme: Record<string, string>;
    colorScheme: "light" | "dark";
    fontFamily?: string;
}): string {
    const vars = Object.entries(options.theme)
        .filter(([name, value]) => /^[a-z0-9-]+$/.test(name) && value && !/[;{}<>]/.test(value))
        .map(([name, value]) => `--${name}:${value};`)
        .join("");
    // The app's web font isn't loadable inside the frame, so the system stack
    // always follows it — otherwise a widget falls back to a serif default.
    const systemStack = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
    const font = options.fontFamily && !/[;{}<>]/.test(options.fontFamily)
        ? `${options.fontFamily}, ${systemStack}`
        : systemStack;
    const token = JSON.stringify(options.token);

    const prelude = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeAttr(WIDGET_CSP)}"><meta name="viewport" content="width=device-width, initial-scale=1"><style>:root{${vars}color-scheme:${options.colorScheme};}html,body{margin:0;padding:0;background:transparent;color:var(--foreground);font-family:${font};font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;}body{display:flow-root;}*,*::before,*::after{box-sizing:border-box;}a{color:var(--primary);}button{font:inherit;color:inherit;cursor:pointer;}</style>`;

    // Size reporting + the widget's one voice back to the chat. Runs inside
    // the opaque origin, so postMessage is its only channel to the parent.
    const bridge = `<script>(function(){var T=${token};var last=0;function post(){var b=document.body;if(!b)return;var h=Math.ceil(Math.max(b.scrollHeight,b.getBoundingClientRect().height));if(Math.abs(h-last)>1){last=h;parent.postMessage({type:"emperor-widget:size",token:T,height:h},"*");}}function send(p){p=String(p==null?"":p).slice(0,500).trim();if(p)parent.postMessage({type:"emperor-widget:send",token:T,prompt:p},"*");}window.emperor={send:send};document.addEventListener("click",function(e){var el=e.target&&e.target.closest?e.target.closest("[data-emperor-send]"):null;if(el){e.preventDefault();send(el.getAttribute("data-emperor-send"));}},true);if(typeof ResizeObserver==="function"){var ro=new ResizeObserver(post);ro.observe(document.documentElement);if(document.body)ro.observe(document.body);else document.addEventListener("DOMContentLoaded",function(){ro.observe(document.body);post();});}window.addEventListener("load",post);document.addEventListener("DOMContentLoaded",post);setTimeout(post,50);setTimeout(post,400);})();</script>`;

    // The bridge loads BEFORE the widget so `emperor.send` exists when the
    // widget's own top-level script runs; it attaches to <body> once parsed.
    return prelude + bridge + html;
}
