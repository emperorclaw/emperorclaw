/**
 * Coded copy: a message key plus its values, sent next to the English text a
 * server module builds, so the UI can render it in the viewer's language
 * without changing what agents, webhooks or stored rows read.
 *
 * Pure and dependency-free (no next-intl): server modules attach a copy, UI
 * code translates it with translateCopy (or the useCopy hook in
 * src/lib/i18n/use-copy.ts). Keys are full paths into messages/en.json. A
 * value may itself be coded copy (a translated cause inside a reason line).
 * Anything the messages do not know (a newer server's key, an unknown state)
 * falls back to the English text the server sent.
 */

export type CopyValue = string | number | CodedCopy;

export interface CodedCopy {
    /** Full message path, e.g. "failures.headlines.provider_credits". */
    key: string;
    values?: Record<string, CopyValue>;
}

export function copy(key: string, values?: Record<string, CopyValue>): CodedCopy {
    return values ? { key, values } : { key };
}

/** The slice of a next-intl / use-intl translator translateCopy needs. */
export interface CopyTranslator {
    (key: string, values?: Record<string, string | number>): string;
    has(key: string): boolean;
}

function resolve(t: CopyTranslator, item: CodedCopy, depth: number): string | null {
    if (depth > 4 || !item || typeof item.key !== "string" || !t.has(item.key)) return null;
    const values: Record<string, string | number> = {};
    for (const [name, value] of Object.entries(item.values ?? {})) {
        if (value && typeof value === "object") {
            const nested = resolve(t, value, depth + 1);
            if (nested === null) return null;
            values[name] = nested;
        } else {
            values[name] = value as string | number;
        }
    }
    let out: string;
    try {
        out = t(item.key, values);
    } catch {
        return null;
    }
    // next-intl does not throw when formatting fails (e.g. a placeholder the
    // message needs is missing): it reports through onError and returns the
    // message fallback, which for a root translator is the key path itself.
    if (typeof out !== "string" || out === item.key) return null;
    return out;
}

/**
 * Render coded copy with a root translator; `fallback` (the server's English)
 * when there is no copy or any key in it is unknown.
 */
export function translateCopy(t: CopyTranslator, item: CodedCopy | null | undefined, fallback: string): string {
    if (!item) return fallback;
    return resolve(t, item, 0) ?? fallback;
}
