import { NextRequest, NextResponse } from "next/server";
import { companyRouteAccess } from "@/lib/company-access";
import { attentionAccessFromGuard } from "@/lib/attention";
import { loadPaletteData } from "@/lib/palette";
import { roleGte } from "@/lib/roles";
import { searchCompany } from "@/lib/search";
import { PALETTE_MATCH_LIMIT } from "@/lib/search-query";

export const dynamic = "force-dynamic";

/**
 * GET /api/ui/palette?q= : agents, projects, customers and open tasks for the
 * command palette, member-scoped. With a query it also returns the top
 * full-text `matches` (lib/search.ts, same access rules as /api/search).
 */
export async function GET(req: NextRequest) {
    const guard = await companyRouteAccess("viewer");
    if (guard.response) return guard.response;
    const { companyId, userId, role, scope } = guard.ctx;
    const q = req.nextUrl.searchParams.get("q") ?? "";
    try {
        const [data, search] = await Promise.all([
            loadPaletteData(companyId, attentionAccessFromGuard(guard.ctx).scope, q),
            q.trim()
                ? searchCompany({ companyId, userId, isAdmin: roleGte(role, "admin"), scope }, { q, limit: PALETTE_MATCH_LIMIT }).catch((error) => {
                    // Full-text matches are a bonus: the palette still answers without them.
                    console.error("[/api/ui/palette] search error:", error);
                    return null;
                })
                : Promise.resolve(null),
        ]);
        return NextResponse.json(search ? { ...data, matches: search.results } : data, { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
        console.error("[/api/ui/palette] GET error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
