import { z } from "zod";

type ParseResult<T> =
    | { data: T; error?: undefined }
    | { data?: undefined; error: string };

/**
 * Parse and validate a JSON request body at the route boundary. Returns a
 * readable error string (for a 400 response) instead of throwing, so
 * malformed JSON or wrong field types never surface as a 500.
 */
export async function parseJsonBody<T extends z.ZodTypeAny>(
    req: Request,
    schema: T,
): Promise<ParseResult<z.infer<T>>> {
    let raw: unknown;
    try {
        raw = await req.json();
    } catch {
        return { error: "Request body must be valid JSON" };
    }
    const result = schema.safeParse(raw);
    if (!result.success) {
        const issue = result.error.issues[0];
        const path = issue && issue.path.length > 0 ? issue.path.join(".") : "body";
        return { error: `Invalid request body — ${path}: ${issue?.message ?? "invalid"}` };
    }
    return { data: result.data };
}

/** Optional string that also tolerates null (agents often send explicit nulls). */
export const optionalString = z.string().nullish();
