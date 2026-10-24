/**
 * Shared rules for single-key shortcuts (the command palette's g-chords and
 * `?`, the inbox's j/k/a/r). Pure and DOM-light so it is unit-tested
 * (tests/unit/keyboard-shortcuts.test.ts).
 */

/** The minimal shape of an event target we inspect (an Element in the browser). */
export interface ShortcutTarget {
    tagName?: string;
    isContentEditable?: boolean;
    getAttribute?: (name: string) => string | null;
    closest?: (selector: string) => unknown;
}

const TEXT_INPUT_TYPES = new Set(["", "text", "search", "email", "url", "tel", "password", "number", "date", "datetime-local", "month", "time", "week"]);

/** True when a key press belongs to text entry, so single-key shortcuts must ignore it. */
export function isTypingTarget(target: ShortcutTarget | null | undefined): boolean {
    if (!target) return false;
    const tag = (target.tagName ?? "").toUpperCase();
    if (tag === "TEXTAREA" || tag === "SELECT") return true;
    if (tag === "INPUT") {
        const type = (target.getAttribute?.("type") ?? "").toLowerCase();
        return TEXT_INPUT_TYPES.has(type);
    }
    if (target.isContentEditable) return true;
    const editable = target.getAttribute?.("contenteditable");
    if (editable !== null && editable !== undefined && editable !== "false") return true;
    if (target.getAttribute?.("role") === "textbox") return true;
    // Inside a contenteditable host (rich editors put focus on inner nodes).
    return Boolean(target.closest?.("[contenteditable]:not([contenteditable='false'])"));
}

/** Modifier-free key presses only: never steal Ctrl/Cmd/Alt combinations. */
export function isPlainKey(event: { ctrlKey: boolean; metaKey: boolean; altKey: boolean }): boolean {
    return !event.ctrlKey && !event.metaKey && !event.altKey;
}

/** `g` then a letter: where each chord goes. */
export const GO_CHORDS: Record<string, { href: string; label: string }> = {
    h: { href: "/", label: "Home" },
    i: { href: "/inbox", label: "Inbox" },
    m: { href: "/messages", label: "Messages" },
    p: { href: "/projects", label: "Projects" },
    t: { href: "/timeline", label: "Timeline" },
    a: { href: "/agents", label: "Agents" },
};

/** How long after `g` the second key still counts. */
export const CHORD_TIMEOUT_MS = 1200;

/** Plain-text palette matching: every word of the query must appear (case and accents ignored). */
export function matchesQuery(text: string, query: string): boolean {
    const fold = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    const haystack = fold(text);
    return fold(query).split(/\s+/).filter(Boolean).every((word) => haystack.includes(word));
}
