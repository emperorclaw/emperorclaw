export function isMissingSchemaError(error: unknown) {
    if (!error || typeof error !== "object") return false;

    const code = "code" in error ? String((error as { code?: unknown }).code) : "";
    return code === "42703" || code === "42P01";
}
