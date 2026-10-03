import { NextResponse } from "next/server";
import { AuthError, requireRole } from "@/lib/roles";
import { GroupError } from "@/lib/groups";
import { broadcastMcpEvent } from "@/lib/pubsub";

/**
 * Shared plumbing for the group REST routes: members (not viewers) may create
 * and manage groups, and every failure maps to a clean status.
 */
export async function groupRoute<T>(handler: (ctx: { userId: string; companyId: string }) => Promise<T>, status = 200) {
    try {
        const ctx = await requireRole("member")();
        const result = await handler({ userId: ctx.userId, companyId: ctx.companyId });
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
