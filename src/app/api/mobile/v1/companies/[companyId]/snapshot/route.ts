import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { mobileCompanyAccess } from "@/lib/mobile-auth";
import { mobileJson, mobileError } from "@/lib/mobile-response";
import { loadAgentActivity } from "@/lib/agent-activity";
import { agentsNotUsableBy } from "@/lib/agent-access-server";
import { getScopedAgentIds } from "@/lib/member-scope";

export async function GET(request: Request, { params }: { params: Promise<{ companyId: string }> }) {
    try {
        const { companyId } = await params;
        const ctx = await mobileCompanyAccess(request, companyId);
        const [activity, access, roster] = await Promise.all([
            loadAgentActivity(companyId, { viewerUserId: ctx.userId, scope: ctx.scope, agentIds: getScopedAgentIds(ctx.scope) }),
            agentsNotUsableBy(ctx),
            db.select({ id: agents.id, name: agents.name, role: agents.role, budgetStatus: agents.budgetStatus }).from(agents).where(and(eq(agents.companyId, companyId), isNull(agents.deletedAt))),
        ]);
        const names = new Map(roster.map((agent) => [agent.id, agent]));
        return mobileJson({ companyId, updatedAt: new Date().toISOString(), agents: activity.filter((agent) => !access.hidden.has(agent.agentId)).map((agent) => ({
            id: agent.agentId, name: names.get(agent.agentId)?.name ?? "Agent", role: names.get(agent.agentId)?.role ?? "operator",
            state: agent.state, activity: agent.activity, taskTitle: agent.task?.title ?? null, lastSeenAt: agent.lastSeenAt,
            paused: names.get(agent.agentId)?.budgetStatus === "paused",
        })) });
    } catch (error) { return mobileError(error); }
}
