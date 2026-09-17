// Docker returns NDJSON progress on success and may stream an error with HTTP
// 200. Failed requests often carry a JSON `message` explaining registry auth.
export function parseDockerPullResponse(statusCode: number, raw: string): string {
    const records = raw.trim().split("\n").filter(Boolean).map(line => {
        try { return JSON.parse(line) as Record<string, unknown>; }
        catch { return null; }
    });
    const failure = records.find(row => typeof row?.error === "string" ||
        (row?.errorDetail && typeof row.errorDetail === "object" && "message" in row.errorDetail));
    if (failure || statusCode !== 200) {
        const detail = failure?.errorDetail as { message?: string } | undefined;
        const message = detail?.message || failure?.error || records.find(row => typeof row?.message === "string")?.message;
        throw new Error(`Pull failed: HTTP ${statusCode}${message ? ` — ${String(message).slice(0, 1500)}` : ""}`);
    }
    const last = records.at(-1);
    return typeof last?.status === "string" ? last.status : "Image pulled";
}
