import { useCallback } from "react";
import { apiErrorCopy } from "@/lib/api-error-copy";
import { useCopy } from "./use-copy";

/**
 * `apiError(serverText, fallback)`: a common API error (src/lib/api-error-copy.ts)
 * in the viewer's language, any other server text as is, else `fallback`.
 */
export function useApiError() {
    const render = useCopy();
    return useCallback((text: string | null | undefined, fallback: string): string => {
        if (!text) return fallback;
        return render(apiErrorCopy(text), text);
    }, [render]);
}
