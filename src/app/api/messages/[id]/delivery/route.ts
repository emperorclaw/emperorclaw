import { NextRequest, NextResponse } from "next/server";
import { getCompanyId } from "@/lib/auth";
import { loadMessageDelivery } from "@/lib/run-ledger-reads";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/messages/[id]/delivery — the delivery inspector's data: every stored
 * verdict for the message (agent, addressed, reason, streak/max), the runs it
 * triggered, and the message's current delivery state. Human session, scoped to
 * the caller's company.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const companyId = await getCompanyId();
    if (!companyId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: "Invalid message id" }, { status: 400 });

    const view = await loadMessageDelivery(companyId, id);
    if (!view) return NextResponse.json({ error: "Message not found" }, { status: 404 });
    return NextResponse.json(view);
}
