import { NextRequest, NextResponse } from "next/server";
import { getCompanyId } from "@/lib/auth";
import { getThreadMessageReasoning } from "@/lib/control-plane";

/**
 * GET /api/chat/reasoning?messageId=... — the reasoning transcript for one
 * message, scoped to the signed-in user's company.
 *
 * Intentionally one message per request. The chat message list is a polling
 * loop, so reasoning must never ride along with it: the disclosure in the UI is
 * collapsed by default and calls this only when a reader expands it.
 */
export async function GET(req: NextRequest) {
    const companyId = await getCompanyId();
    if (!companyId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const messageId = new URL(req.url).searchParams.get("messageId");
    if (!messageId) return NextResponse.json({ error: "messageId is required" }, { status: 400 });

    try {
        const row = await getThreadMessageReasoning(companyId, messageId);
        if (!row) return NextResponse.json({ messageId, reasoning: null });
        return NextResponse.json({
            messageId: row.messageId,
            reasoning: row.reasoning,
            createdAt: row.createdAt,
        });
    } catch (error: unknown) {
        console.error("[/api/chat/reasoning] GET error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
