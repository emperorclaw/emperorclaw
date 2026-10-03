import { NextRequest, NextResponse } from "next/server";
import { resolveBoundAgentId, verifyMcpToken } from "@/lib/mcp";
import { GroupError, isAgentGroupMember, type GroupActor } from "@/lib/groups";
import { broadcastMcpEvent } from "@/lib/pubsub";

/**
 * Runtime-side (company token) plumbing for groups. Who acts:
 *   - a token bound to an agent acts as that agent;
 *   - an unbound (operator) token acts as `agentId` from the request, or as
 *     the system when none is given.
 * An agent may create groups (it joins them) but may only change groups it is
 * a member of; operator tokens may manage any group of their company.
 */
export async function groupMcpRoute<T>(
    req: NextRequest,
    requestedAgentId: unknown,
    handler: (ctx: { companyId: string; actor: GroupActor; requireMember: (groupId: string) => Promise<void> }) => Promise<T>,
    status = 200,
) {
    const auth = await verifyMcpToken(req);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const companyId = auth.companyToken!.companyId;
    try {
        const bound = auth.companyToken!.agentId || null;
        const agentId = await resolveBoundAgentId(companyId, auth.companyToken!, typeof requestedAgentId === "string" && requestedAgentId ? requestedAgentId : null);
        const actor: GroupActor = agentId ? { type: "agent", id: agentId } : { type: "system", id: null };
        const requireMember = async (groupId: string) => {
            if (bound && !(await isAgentGroupMember(companyId, groupId, bound))) {
                throw new GroupError("This agent is not a member of that group", 403);
            }
        };
        return NextResponse.json(await handler({ companyId, actor, requireMember }), { status });
    } catch (error) {
        if (error instanceof GroupError) return NextResponse.json({ error: error.message }, { status: error.status });
        const message = error instanceof Error ? error.message : "Internal Server Error";
        if (message.startsWith("Access denied")) return NextResponse.json({ error: message }, { status: 403 });
        if (message.startsWith("Agent not found")) return NextResponse.json({ error: message }, { status: 404 });
        console.error("[mcp/groups] route error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

export function announceGroupChange(companyId: string, groupId: string, change: string) {
    void broadcastMcpEvent(companyId, { type: "group_updated", groupId, change });
}
