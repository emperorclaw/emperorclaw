/**
 * A few seconds of in-process memory for loadOrganization (lib/organization.ts):
 * routing, the lean context and MCP instructions read the chart on hot paths.
 * Invalidated in this process whenever the chart, a group or an agent changes
 * (organization-note-schedule.ts is called on every such change); other
 * processes see the change within the TTL. No imports, so any module may call it.
 */
export const ORGANIZATION_CACHE_TTL_MS = 5_000;

const entries = new Map<string, { at: number; value: Promise<unknown> }>();

export function cachedOrganization<T>(companyId: string, load: () => Promise<T>, now = Date.now()): Promise<T> {
    const hit = entries.get(companyId);
    if (hit && now - hit.at < ORGANIZATION_CACHE_TTL_MS) return hit.value as Promise<T>;
    const value = load();
    entries.set(companyId, { at: now, value });
    // A failed load is never served from the cache.
    value.catch(() => { if (entries.get(companyId)?.value === value) entries.delete(companyId); });
    if (entries.size > 500) entries.delete(entries.keys().next().value!);
    return value;
}

export function invalidateOrganizationCache(companyId: string | null | undefined): void {
    if (companyId) entries.delete(companyId);
}
