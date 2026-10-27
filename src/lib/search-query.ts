/**
 * Global search (roadmap 11.5), the pure half: turning what a person typed
 * into a safe `to_tsquery` string, reading the API's query parameters, and
 * turning a `ts_headline` into plain text plus highlight ranges.
 *
 * No DB access: safe for unit tests and client components.
 */

export const SEARCH_TYPES = ["task", "message", "knowledge", "file", "project", "customer", "agent"] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

export const SEARCH_TYPE_LABELS: Record<SearchType, string> = {
    task: "Tasks",
    message: "Messages",
    knowledge: "Knowledge",
    file: "Files",
    project: "Projects",
    customer: "Customers",
    agent: "Agents",
};

export type SearchResult = {
    type: SearchType;
    id: string;
    /** Plain text, never markup. */
    title: string;
    /** Plain text, never markup; `highlights` marks the matched words in it. */
    snippet: string;
    /** [start, end) character ranges of `snippet` that matched the query. */
    highlights: [number, number][];
    /** Where the result opens in the app. */
    href: string;
    /** A short line of context (project, thread, sender), or null. */
    context: string | null;
    updatedAt: string;
};

export type SearchResponse = {
    query: string;
    results: SearchResult[];
    nextCursor: string | null;
};

export const SEARCH_MIN_QUERY_LENGTH = 2;
export const SEARCH_MAX_QUERY_LENGTH = 200;
export const SEARCH_MAX_TERMS = 8;
export const SEARCH_MAX_TERM_LENGTH = 64;
export const SEARCH_DEFAULT_LIMIT = 20;
/** Results per page on /search. */
export const SEARCH_PAGE_LIMIT = 30;
/** Full-text matches shown inline in the command palette. */
export const PALETTE_MATCH_LIMIT = 5;
export const SEARCH_MAX_LIMIT = 50;
/** Deep paging is not a search use case; this also bounds the work per page. */
export const SEARCH_MAX_OFFSET = 500;

/** Markers ts_headline wraps matches in (control characters never typed by a person). */
export const HEADLINE_START = "\u0002";
export const HEADLINE_STOP = "\u0003";

/**
 * The words of a query: letters and digits only (accents and other combining
 * marks stay with their letter). Everything else separates words, so no
 * tsquery operator (&, |, !, <->, :, *, parentheses, quotes) can survive.
 */
export function searchTerms(raw: string): string[] {
    const text = String(raw ?? "").normalize("NFC").slice(0, SEARCH_MAX_QUERY_LENGTH);
    const words = text.match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu) ?? [];
    const terms: string[] = [];
    const seen = new Set<string>();
    for (const word of words) {
        const term = word.toLowerCase().slice(0, SEARCH_MAX_TERM_LENGTH);
        if (seen.has(term)) continue;
        seen.add(term);
        terms.push(term);
        if (terms.length >= SEARCH_MAX_TERMS) break;
    }
    return terms;
}

/**
 * A `to_tsquery` string: every word must match and the last one matches as a
 * prefix, so results keep up while someone is still typing ("inv" finds
 * "invoice"). Null when there is nothing worth searching for. The string is
 * still passed as a bound parameter; the word filter above is what keeps it
 * valid tsquery syntax.
 */
export function buildTsQuery(raw: string): string | null {
    const trimmed = String(raw ?? "").trim();
    if (trimmed.length < SEARCH_MIN_QUERY_LENGTH) return null;
    const terms = searchTerms(trimmed);
    if (terms.length === 0) return null;
    return terms.map((term, index) => (index === terms.length - 1 ? `${term}:*` : term)).join(" & ");
}

export type ParsedSearchParams = {
    q: string;
    types: SearchType[];
    limit: number;
    offset: number;
};

/** `type` is one type or a comma list; unknown types are ignored, none = all. */
export function parseSearchTypes(value: string | null | undefined): SearchType[] {
    if (!value) return [...SEARCH_TYPES];
    const wanted = new Set(value.split(",").map((v) => v.trim().toLowerCase()));
    const types = SEARCH_TYPES.filter((type) => wanted.has(type));
    return types.length ? types : [...SEARCH_TYPES];
}

export function encodeSearchCursor(offset: number): string {
    return Buffer.from(JSON.stringify({ o: offset })).toString("base64url");
}

/** An opaque cursor back to its offset; anything malformed restarts at 0. */
export function decodeSearchCursor(cursor: string | null | undefined): number {
    if (!cursor || cursor.length > 64) return 0;
    try {
        const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { o?: unknown };
        const offset = typeof parsed.o === "number" && Number.isInteger(parsed.o) ? parsed.o : 0;
        return Math.min(Math.max(offset, 0), SEARCH_MAX_OFFSET);
    } catch {
        return 0;
    }
}

export function parseSearchParams(params: URLSearchParams): ParsedSearchParams {
    const q = (params.get("q") ?? "").slice(0, SEARCH_MAX_QUERY_LENGTH);
    const rawLimit = Number.parseInt(params.get("limit") ?? "", 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), SEARCH_MAX_LIMIT) : SEARCH_DEFAULT_LIMIT;
    return { q, types: parseSearchTypes(params.get("type")), limit, offset: decodeSearchCursor(params.get("cursor")) };
}

const SNIPPET_MAX = 320;
const TITLE_MAX = 160;

/** Drop HTML tags/comments and control characters (but not the headline markers). */
function stripMarkup(value: string): string {
    return value
        .replace(/<!--[\s\S]*?-->/g, " ")
        // Only complete tags: "a <b and c" in plain text is left alone.
        .replace(/<\/?[a-zA-Z][^<>]*>/g, " ")
        // Markdown links read as their text; table rules (|---|---|) as nothing.
        .replace(/\[([^[\]]*)\]\([^()\s]*\)/g, "$1")
        .replace(/\|?(\s*:?-{3,}:?\s*\|)+/g, " ")
        .replace(/[\u0000\u0001\u0004-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
        .replace(/\s+/g, " ");
}

/** Plain, single-line, length-capped text with no markup (titles). */
export function plainText(value: string | null | undefined, max = TITLE_MAX): string {
    const text = stripMarkup(String(value ?? "")).replaceAll(HEADLINE_START, "").replaceAll(HEADLINE_STOP, "").trim();
    return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/**
 * A ts_headline (matches wrapped in HEADLINE_START/STOP) as plain text plus
 * the ranges to highlight. HTML is stripped, so the UI renders text nodes
 * only; unbalanced markers are tolerated.
 */
export function parseHeadline(raw: string | null | undefined, max = SNIPPET_MAX): { snippet: string; highlights: [number, number][] } {
    const source = stripMarkup(String(raw ?? "")).trim();
    let snippet = "";
    const highlights: [number, number][] = [];
    let openAt: number | null = null;
    for (const char of source) {
        if (char === HEADLINE_START) {
            if (openAt === null) openAt = snippet.length;
            continue;
        }
        if (char === HEADLINE_STOP) {
            if (openAt !== null && snippet.length > openAt) highlights.push([openAt, snippet.length]);
            openAt = null;
            continue;
        }
        if (snippet.length >= max) break;
        // Markers removed between two spaces must not leave a double space.
        if (char === " " && (snippet.length === 0 || snippet.endsWith(" "))) continue;
        snippet += char;
    }
    if (openAt !== null && snippet.length > openAt) highlights.push([openAt, snippet.length]);
    const trimmedEnd = snippet.trimEnd();
    if (snippet.length >= max) snippet = `${trimmedEnd}…`;
    else snippet = trimmedEnd;
    return { snippet, highlights: highlights.map(([a, b]) => [a, Math.min(b, trimmedEnd.length)] as [number, number]).filter(([a, b]) => b > a) };
}

/** Split a snippet into plain/highlighted parts for rendering as text nodes. */
export function snippetParts(snippet: string, highlights: readonly [number, number][]): { text: string; match: boolean }[] {
    const parts: { text: string; match: boolean }[] = [];
    let at = 0;
    for (const [start, end] of [...highlights].sort((a, b) => a[0] - b[0])) {
        if (start < at || end > snippet.length) continue;
        if (start > at) parts.push({ text: snippet.slice(at, start), match: false });
        parts.push({ text: snippet.slice(start, end), match: true });
        at = end;
    }
    if (at < snippet.length) parts.push({ text: snippet.slice(at), match: false });
    return parts;
}
