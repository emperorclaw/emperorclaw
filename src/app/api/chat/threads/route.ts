import { NextRequest, NextResponse } from "next/server";
import { companyRouteAccess } from "@/lib/company-access";
import { canonicalAgentId } from "@/lib/agent-access-server";
import { listPrivateChats, PrivateChatError } from "@/lib/private-chats";

export const dynamic = "force-dynamic";

/**
 * GET /api/chat/threads?agentId=<id>&archived=1
 * The caller's own private chats with one agent: open ones (main first), or
 * archived ones with `archived=1`. Nobody else's chats, admins included.
 */
export async function GET(req: NextRequest) {
    const access = await companyRouteAccess("viewer");
    if (access.response) return access.response;
    const { searchParams } = new URL(req.url);
    const agentRef = searchParams.get("agentId");
    if (!agentRef) return NextResponse.json({ error: "agentId is required" }, { status: 400 });
    const archivedParam = searchParams.get("archived");
    const archived = archivedParam === "1" || archivedParam === "true";

    try {
        const agentId = await canonicalAgentId(access.ctx.companyId, agentRef);
        if (!agentId) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
        const { chats, open, settings, directChatMode } = await listPrivateChats(access.ctx, agentId, { archived });
        return NextResponse.json({
            chats,
            open,
            limit: settings.maxOpen,
            // Whether this person may start another chat with the agent right now.
            multiChatEnabled: settings.enabled && directChatMode === "private",
        });
    } catch (error) {
        if (error instanceof PrivateChatError) return NextResponse.json(error.body(), { status: error.status });
        console.error("[/api/chat/threads] GET error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
