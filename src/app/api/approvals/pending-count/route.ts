import { NextResponse } from "next/server";
import { getCompanyId } from "@/lib/auth";
import { listPendingDecisions } from "@/lib/approvals";

/** Decisions waiting on a human, for the sidebar badge (same definition as the Approvals page). */
export async function GET() {
    const companyId = await getCompanyId();
    if (!companyId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { count } = await listPendingDecisions(companyId);
    return NextResponse.json({ count });
}
