import { NextResponse } from "next/server";
import { AuthError, requireRole, type Role } from "@/lib/roles";
import { memberMayUseAllAgents, type AgentAccessViewer } from "@/lib/agent-access-server";
import { GroupError, getGroup } from "@/lib/groups";
import { memberMaySeeAgent, type MemberScope } from "@/lib/member-scope";

/**
 * A restricted member reaches a group only when every agent in it is inside
 * their scope (a group with an out-of-scope agent would expose that agent's
 * messages). Reads as "not found" otherwise.
 */
export function memberMaySeeGroup(scope: MemberScope | null, group: { members: { kind: string; id: string }[] }): boolean {
    if (!scope) return true;
    return group.members.filter((m) => m.kind === "agent").every((m) => memberMaySeeAgent(scope, m.id));
}

/** Throws a 404 GroupError when the group is outside the member's scope. */
export async function requireGroupInScope(companyId: string, groupId: string, userId: string, scope: MemberScope | null) {
    const group = await getGroup(companyId, groupId, { type: "human", id: userId });
    if (!memberMaySeeGroup(scope, group)) throw new GroupError("Group not found", 404);
    return group;
}

/** Throws a 404 GroupError when a request would add an agent outside the member's scope. */
export function requireAgentsInScope(scope: MemberScope | null, agentIds: unknown) {
    if (!scope) return;
    const ids = Array.isArray(agentIds) ? agentIds : [];
    if (ids.some((id) => typeof id !== "string" || !memberMaySeeAgent(scope, id))) throw new GroupError("Agent not found", 404);
}

/**
 * Throws a 404 GroupError when a request would add an agent limited to other
 * people (0.20, lib/agent-access.ts): a group would let everyone in it talk to it.
 */
export async function requireAgentsUsable(viewer: AgentAccessViewer, agentIds: unknown) {
    const ids = (Array.isArray(agentIds) ? agentIds : []).filter((id): id is string => typeof id === "string");
    if (!(await memberMayUseAllAgents(viewer, ids))) throw new GroupError("Agent not found", 404);
}
import { broadcastMcpEvent } from "@/lib/pubsub";

/**
 * Shared plumbing for the group REST routes: members (not viewers) may create
 * and manage groups, and every failure maps to a clean status.
 */
export async function groupRoute<T>(handler: (ctx: { userId: string; companyId: string; scope: MemberScope | null; role: Role }) => Promise<T>, status = 200) {
    try {
        const ctx = await requireRole("member")();
        const result = await handler({ userId: ctx.userId, companyId: ctx.companyId, scope: ctx.scope, role: ctx.role });
        return NextResponse.json(result, { status });
    } catch (error) {
        if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
        if (error instanceof GroupError) return NextResponse.json({ error: error.message }, { status: error.status });
        console.error("[groups] route error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

export function announceGroup(companyId: string, groupId: string, change: string) {
    void broadcastMcpEvent(companyId, { type: "group_updated", groupId, change });
}
