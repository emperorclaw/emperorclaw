import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { companies } from "@/db/schema";
import { AuthError, requireRole } from "@/lib/roles";
import { getDirectChatMode } from "@/lib/control-plane";
import { isDirectChatMode } from "@/lib/direct-chat-mode";
import { logAudit } from "@/lib/mcp";

export const dynamic = "force-dynamic";

function failure(error: unknown) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
    console.error("[direct-chats]", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
}

/** The company's direct-chat mode: "shared" or "private". */
export async function GET() {
    try {
        const { companyId } = await requireRole("member")();
        return NextResponse.json({ mode: await getDirectChatMode(companyId) });
    } catch (error) {
        return failure(error);
    }
}

/**
 * Owners/admins change it: { mode: "shared" | "private" }. Existing threads are
 * never split or merged: the shared thread stays (as the Operations thread in
 * private mode) and private threads stay private.
 */
export async function PUT(req: NextRequest) {
    try {
        const { companyId, userId } = await requireRole("admin")();
        const body = await req.json().catch(() => ({}));
        if (!isDirectChatMode(body?.mode)) {
            return NextResponse.json({ error: "mode must be \"shared\" or \"private\"" }, { status: 400 });
        }
        const previous = await getDirectChatMode(companyId);
        if (previous !== body.mode) {
            await db.update(companies).set({ directChatMode: body.mode }).where(eq(companies.id, companyId));
            await logAudit(companyId, "human", userId, "company.direct_chat_mode_changed", "company", companyId, { from: previous, to: body.mode });
        }
        return NextResponse.json({ ok: true, mode: body.mode });
    } catch (error) {
        return failure(error);
    }
}
