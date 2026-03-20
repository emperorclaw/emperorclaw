"use server";

import { db } from "@/db";
import { agentIntegrations } from "@/db/schema";
import { getCompanyId, getUserId } from "@/lib/auth";
import { eq, and } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { archiveAgentIntegration, createAgentIntegration, listAgentIntegrationsForAgent, type AgentIntegrationCompat } from "@/lib/agent-integrations";
import { broadcastMcpEvent } from "@/lib/pubsub";

function toBroadcastIntegration(integration: AgentIntegrationCompat) {
    const { secretJson, ...rest } = integration;
    void secretJson;
    return {
        ...rest,
        secretConfigured: integration.ownership === "managed" || integration.compatMode === "legacy-inline",
    };
}

export async function getAgentIntegrations(agentId: string) {
    const companyId = await getCompanyId();
    if (!companyId) throw new Error("Unauthorized");

    const integrations = await listAgentIntegrationsForAgent(companyId, agentId);

    return integrations.map((integration) => toBroadcastIntegration(integration));
}

export async function saveAgentIntegration(data: {
    agentId: string;
    provider: string;
    name: string;
    configJson: Record<string, unknown>;
    secretJson: Record<string, unknown>;
}) {
    const companyId = await getCompanyId();
    const userId = await getUserId();
    if (!companyId) throw new Error("Unauthorized");

    const newIntegration = await createAgentIntegration({
        companyId,
        agentId: data.agentId,
        provider: data.provider,
        name: data.name,
        configJson: data.configJson,
        secretJson: data.secretJson,
    });

    await broadcastMcpEvent(companyId, {
        type: "agent_integration_created",
        agentId: data.agentId,
        actorUserId: userId,
        integration: toBroadcastIntegration(newIntegration),
    });

    revalidatePath("/agents");
    revalidatePath(`/agents/${data.agentId}`);
    return toBroadcastIntegration(newIntegration);
}

export async function deleteAgentIntegration(id: string) {
    const companyId = await getCompanyId();
    const userId = await getUserId();
    if (!companyId) throw new Error("Unauthorized");

    const [existing] = await db.select().from(agentIntegrations)
        .where(and(eq(agentIntegrations.id, id), eq(agentIntegrations.companyId, companyId)))
        .limit(1);

    await archiveAgentIntegration(companyId, id);

    if (existing) {
        await broadcastMcpEvent(companyId, {
            type: "agent_integration_archived",
            agentId: existing.agentId,
            actorUserId: userId,
            integration: {
                id: existing.id,
                agentId: existing.agentId,
                provider: existing.provider,
                name: existing.name,
                status: "archived",
            },
        });
        revalidatePath(`/agents/${existing.agentId}`);
    }

    revalidatePath("/agents");
}

import { canManageSecrets } from "@/lib/secrets";
export async function getSecretManagerStatus() {
    return {
        enabled: canManageSecrets()
    };
}
