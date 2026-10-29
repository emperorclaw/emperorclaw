import type { IntlError } from "next-intl";

type MessageTree = { [key: string]: string | MessageTree };

/**
 * Deep-merge a translation over the English messages: every key English has
 * exists in the result, so a key missing (or left empty) in a translation
 * renders its English text instead of an error.
 */
export function withEnglishFallback<T extends MessageTree>(english: T, translated: MessageTree): T {
    const out: MessageTree = {};
    for (const [key, value] of Object.entries(english)) {
        const other = translated?.[key];
        if (typeof value === "string") out[key] = typeof other === "string" && other.trim() ? other : value;
        else out[key] = withEnglishFallback(value, other && typeof other === "object" ? other : {});
    }
    return out as T;
}

/** Missing messages are silent in production and a warning in development; never a crash. */
export function handleIntlError(error: IntlError) {
    if (process.env.NODE_ENV !== "production") console.warn(`[i18n] ${error.message}`);
}

/** Shown only when a key is missing even in English (the type system prevents that). */
export function intlMessageFallback({ namespace, key }: { namespace?: string; key: string }) {
    return namespace ? `${namespace}.${key}` : key;
}
