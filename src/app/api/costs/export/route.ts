import { NextRequest, NextResponse } from "next/server";
import { companyRouteAccess } from "@/lib/company-access";
import { costsCsv, isoDay, parseCostsQuery, DAY_MS } from "@/lib/costs";
import { loadCostsView } from "@/lib/costs-reads";

/**
 * GET /api/costs/export?tab=…&range=…[&from&to][&customer|project|model|agent]
 *
 * The Costs view the page shows, as CSV. Same access as the page: any member
 * (viewer and up), limited to a restricted member's scope.
 */
export async function GET(req: NextRequest) {
    const access = await companyRouteAccess("viewer", { module: "costs" });
    if (access.response) return access.response;
    const query = parseCostsQuery(req.nextUrl.searchParams, new Date());
    if (!query.dimension) return NextResponse.json({ error: "Nothing to export for this tab" }, { status: 400 });

    const view = await loadCostsView({ companyId: access.ctx.companyId, scope: access.ctx.scope }, query.dimension, query.range, query.filter);
    const filename = `costs-by-${query.dimension}-${isoDay(query.range.from)}-to-${isoDay(new Date(query.range.to.getTime() - DAY_MS))}.csv`;
    return new NextResponse(costsCsv(view, query.dimension), {
        headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": `attachment; filename="${filename}"`,
            "cache-control": "no-store",
        },
    });
}
