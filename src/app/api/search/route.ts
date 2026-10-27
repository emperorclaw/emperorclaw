import { NextRequest, NextResponse } from "next/server";
import { companyRouteAccess } from "@/lib/company-access";
import { roleGte } from "@/lib/roles";
import { searchCompany } from "@/lib/search";
import { parseSearchParams } from "@/lib/search-query";

export const dynamic = "force-dynamic";

/**
 * GET /api/search?q=&type=&limit=&cursor= : full-text search over everything
 * the signed-in person may open (company, member scope, private chats and
 * pair threads are enforced in lib/search.ts). `type` is one of task,
 * message, knowledge, file, project, customer, agent (or a comma list).
 */
export async function GET(req: NextRequest) {
    const access = await companyRouteAccess("viewer");
    if (access.response) return access.response;
    const { companyId, userId, role, scope } = access.ctx;
    try {
        const params = parseSearchParams(req.nextUrl.searchParams);
        const data = await searchCompany(
            { companyId, userId, isAdmin: roleGte(role, "admin"), scope },
            { q: params.q, types: params.types, limit: params.limit, offset: params.offset },
        );
        return NextResponse.json(data, { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
        console.error("[/api/search] GET error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
