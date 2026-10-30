import { useCallback } from "react";
import { useTranslations } from "next-intl";
import { translateCopy, type CodedCopy, type CopyTranslator } from "@/lib/coded-copy";

/**
 * Renders coded copy (src/lib/coded-copy.ts) in the viewer's language:
 * `render(copy, english)` returns the translation, or the server's English
 * when the copy is missing or names a key this build does not know.
 */
export function useCopy() {
    const t = useTranslations() as unknown as CopyTranslator;
    return useCallback((item: CodedCopy | null | undefined, fallback: string) => translateCopy(t, item, fallback), [t]);
}
