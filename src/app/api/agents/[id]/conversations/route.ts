import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { AuthError, requireRole } from "@/lib/roles";
import { listAgentConversations } from "@/lib/groups";

export const dynamic = "force-dynamic";

/**
 * GET /api/agents/[id]/conversations — the selected agent's active pair threads
 * (read-only), for the office "Conversations" card. Pair threads are private
 * agent conversations, so this is gated to owners/admins only.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const ctx = await requireRole("owner", "admin")();
        const { id } = await params;
        if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
        const [agent] = await db.select({ id: agents.id }).from(agents)
            .where(and(eq(agents.id, id), eq(agents.companyId, ctx.companyId), isNull(agents.deletedAt))).limit(1);
        if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
        const conversations = await listAgentConversations(ctx.companyId, id, 5);
        return NextResponse.json({ conversations });
    } catch (error) {
        if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
        console.error("Agent conversations error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
