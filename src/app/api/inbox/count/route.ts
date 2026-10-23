import { NextResponse } from "next/server";
import { companyRouteAccess } from "@/lib/company-access";
import { attentionAccessFromGuard, buildAttention } from "@/lib/attention";

export const dynamic = "force-dynamic";

/**
 * The navigation badges: the Inbox count comes from the same builder as the
 * /inbox page (src/lib/attention.ts), so the badge is always what the page
 * lists under "Needs a decision" and "Blocked or failing".
 */
export async function GET() {
    const guard = await companyRouteAccess("viewer");
    if (guard.response) return guard.response;
    const companyId = guard.ctx.companyId;
    try {
        const access = attentionAccessFromGuard(guard.ctx);
        const { counts, workingNow } = await buildAttention(companyId, access);
        return NextResponse.json(
            { count: counts.needsYou, hasFailures: counts.hasFailures, approvals: counts.approvals, decide: counts.decide, blocked: counts.blocked, fyi: counts.fyi, working: workingNow.length },
            { headers: { "Cache-Control": "private, no-store" } },
        );
    } catch (error) {
        console.error("[/api/inbox/count] GET error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
