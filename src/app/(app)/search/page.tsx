import { redirect } from "next/navigation";
import { requireRole, roleGte } from "@/lib/roles";
import { searchCompany } from "@/lib/search";
import { parseSearchParams, SEARCH_PAGE_LIMIT, type SearchResponse, type SearchType } from "@/lib/search-query";
import { SearchClient } from "./search-client";

export const dynamic = "force-dynamic";

/**
 * Global search (roadmap 11.5): full-text search over tasks and their notes,
 * messages, Knowledge & Rules, files, projects, customers and agents. The
 * first page renders on the server for a shared /search?q= link; the client
 * searches as you type through GET /api/search (same access rules).
 */
export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string; type?: string }> }) {
    const guard = await requireRole("viewer")().catch(() => null);
    if (!guard) redirect("/login");
    const params = await searchParams;
    const parsed = parseSearchParams(new URLSearchParams({ q: params.q ?? "", type: params.type ?? "" }));
    // One type in the URL filters; anything else (none, unknown, a list) means all.
    const type: SearchType | null = parsed.types.length === 1 ? parsed.types[0] : null;
    const initial: SearchResponse | null = parsed.q.trim()
        ? await searchCompany(
            { companyId: guard.companyId, userId: guard.userId, isAdmin: roleGte(guard.role, "admin"), scope: guard.scope },
            { q: parsed.q, types: type ? [type] : undefined, limit: SEARCH_PAGE_LIMIT },
        ).catch(() => null)
        : null;
    return <SearchClient initialQuery={parsed.q} initialType={type} initial={initial} />;
}
