/**
 * Project names are short labels; the purpose goes in a description.
 *
 * Agents often put a whole brief into the project name ("Slovak e-shop + XML
 * feed discovery — build shared, continuously-updated dataset of ..."). The
 * board, drawers and selects need a label that fits on one line, so every
 * surface derives `{ name, description }` from the stored text with
 * `splitProjectTitle`, and the create/update paths use `normalizeProjectInput`
 * to reject or auto-split names longer than `PROJECT_NAME_MAX`.
 *
 * Pure and dependency-free so it runs in the browser, on the server and in
 * the one-off data migration (scripts/split-long-project-names.ts).
 */

/** Longest project name we store or show unclipped. */
export const PROJECT_NAME_MAX = 60;

/** Below this a head is too short to stand alone as a name ("SK: ..."). */
const MIN_NAME_CHARS = 3;

/**
 * Separators that usually mean "name, then explanation", strongest first.
 * The earliest one in the text wins, so "Acme: Q3 launch - phase 2" splits
 * on ": " rather than " - ".
 */
const SEPARATORS = [" — ", " – ", " | ", " - ", ": "] as const;

/** Trailing characters that read wrong at the end of a clipped name. */
const TRAILING_JUNK = /[\s,;:.+&/|\-–—(]+$/u;

export type ProjectTitle = {
    /** One-line label, at most PROJECT_NAME_MAX characters. */
    name: string;
    /** The explanation that was attached to the name, or null. */
    description: string | null;
    /** True when the name had to be cut at a word boundary. */
    clipped: boolean;
};

function collapse(raw: unknown): string {
    return typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
}

function capitalizeFirst(text: string): string {
    return text ? text.charAt(0).toLocaleUpperCase() + text.slice(1) : text;
}

/** Cut `text` to at most `max` characters, at a word boundary when one is close enough. */
export function clipAtWord(text: string, max = PROJECT_NAME_MAX): string {
    const clean = collapse(text);
    if (clean.length <= max) return clean;
    const slice = clean.slice(0, max + 1);
    const lastSpace = slice.lastIndexOf(" ");
    // Only back up to a space when that keeps most of the text; one huge
    // word (a URL, a hash) is cut hard instead of collapsing to nothing.
    const cut = lastSpace >= Math.floor(max * 0.5) ? slice.slice(0, lastSpace) : clean.slice(0, max);
    return cut.replace(TRAILING_JUNK, "");
}

/**
 * Split a stored project title into a short name and an optional description.
 *
 * - Titles that already fit (≤ PROJECT_NAME_MAX) are returned unchanged.
 * - Longer titles split on the earliest " — ", " – ", " | ", " - " or ": ".
 * - A name that is still too long is clipped at a word boundary; the
 *   description then keeps the full original text so nothing is lost.
 */
export function splitProjectTitle(raw: unknown, max = PROJECT_NAME_MAX): ProjectTitle {
    const text = collapse(raw);
    if (!text) return { name: "", description: null, clipped: false };
    if (text.length <= max) return { name: text, description: null, clipped: false };

    let best: { index: number; separator: string } | null = null;
    for (const separator of SEPARATORS) {
        const index = text.indexOf(separator);
        if (index >= MIN_NAME_CHARS && (best === null || index < best.index)) best = { index, separator };
    }

    if (best) {
        const head = text.slice(0, best.index).replace(TRAILING_JUNK, "").trim();
        const tail = text.slice(best.index + best.separator.length).trim();
        if (head.length >= MIN_NAME_CHARS && tail) {
            if (head.length <= max) return { name: head, description: capitalizeFirst(tail), clipped: false };
            return { name: clipAtWord(head, max), description: text, clipped: true };
        }
    }

    return { name: clipAtWord(text, max), description: text, clipped: true };
}

/**
 * The label and description to show for a project row. Prefers real columns
 * (`name`, `description`) when the row has them, and falls back to splitting
 * the legacy `goal` text, which is what the projects table stores today.
 */
export function projectTitle(project: { goal?: unknown; name?: unknown; description?: unknown } | null | undefined): ProjectTitle {
    if (!project) return { name: "", description: null, clipped: false };
    const stored = collapse(project.name) || collapse(project.goal);
    const split = splitProjectTitle(stored);
    const description = collapse(project.description);
    if (!description) return split;
    // A real description wins; keep any text the split carved off the name.
    const extra = split.description && !split.clipped && !description.includes(split.description) ? `${split.description}\n\n` : "";
    return { name: split.name, description: `${extra}${description}`, clipped: split.clipped };
}

export type NormalizedProjectInput =
    | { ok: true; name: string; description: string | null; autoSplit: boolean }
    | { ok: false; error: string };

/**
 * Server-side guard for project create/update. A name that fits passes
 * through. An overlong one is split into name + description when
 * `mode: "split"` (the default for agent/MCP writes), or rejected with a
 * clear message when `mode: "reject"` (forms that can show the error).
 */
export function normalizeProjectInput(
    input: { name?: unknown; description?: unknown },
    options: { mode?: "split" | "reject"; max?: number } = {},
): NormalizedProjectInput {
    const max = options.max ?? PROJECT_NAME_MAX;
    const name = collapse(input.name);
    const explicit = typeof input.description === "string" ? input.description.trim() : "";
    if (!name) return { ok: false, error: "Project name is required." };
    if (name.length <= max) return { ok: true, name, description: explicit || null, autoSplit: false };
    if (options.mode === "reject") {
        return {
            ok: false,
            error: `Project name is ${name.length} characters. Keep it under ${max} and put the purpose in the description.`,
        };
    }
    const split = splitProjectTitle(name, max);
    const carried = split.description ?? "";
    const description = [carried, explicit].filter(Boolean).join("\n\n") || null;
    return { ok: true, name: split.name, description, autoSplit: true };
}
