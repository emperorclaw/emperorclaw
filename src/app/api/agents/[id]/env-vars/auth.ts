import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { companyRouteAccess } from "@/lib/company-access";
import { canAdmin } from "@/lib/role-matrix";

export type AgentSecretsAuth = { companyId: string; userId: string; isAdmin: boolean };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Only the agent's owner or a company owner/admin may list or change an
 * agent's secrets. Other members get 403 even for the metadata list.
 */
export async function authorizeAgentSecrets(
    id: string,
): Promise<{ auth: AgentSecretsAuth; response?: undefined } | { auth?: undefined; response: NextResponse }> {
    const access = await companyRouteAccess("viewer");
    if (access.response) return { response: access.response };

    if (!UUID_RE.test(id)) {
        return { response: NextResponse.json({ error: "Agent not found" }, { status: 404 }) };
    }

    const [agent] = await db.select({ ownerUserId: agents.ownerUserId }).from(agents).where(and(
        eq(agents.id, id),
        eq(agents.companyId, access.ctx.companyId),
        isNull(agents.deletedAt),
    )).limit(1);
    if (!agent) return { response: NextResponse.json({ error: "Agent not found" }, { status: 404 }) };

    const isAdmin = canAdmin(access.ctx.role);
    if (!isAdmin && agent.ownerUserId !== access.ctx.userId) {
        return {
            response: NextResponse.json(
                { error: "Only the agent's owner or a company owner/admin can manage its secrets" },
                { status: 403 },
            ),
        };
    }

    return { auth: { companyId: access.ctx.companyId, userId: access.ctx.userId, isAdmin } };
}
