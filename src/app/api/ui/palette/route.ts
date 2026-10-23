import { NextRequest, NextResponse } from "next/server";
import { companyRouteAccess } from "@/lib/company-access";
import { attentionAccessFromGuard } from "@/lib/attention";
import { loadPaletteData } from "@/lib/palette";

export const dynamic = "force-dynamic";

/** GET /api/ui/palette?q= : agents, projects, customers and open tasks for the command palette, member-scoped. */
export async function GET(req: NextRequest) {
    const guard = await companyRouteAccess("viewer");
    if (guard.response) return guard.response;
    const companyId = guard.ctx.companyId;
    try {
        const data = await loadPaletteData(companyId, attentionAccessFromGuard(guard.ctx).scope, req.nextUrl.searchParams.get("q") ?? "");
        return NextResponse.json(data, { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
        console.error("[/api/ui/palette] GET error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
