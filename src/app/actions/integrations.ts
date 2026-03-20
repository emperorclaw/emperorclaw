"use server";

import { db } from "@/db";
import { agentIntegrations } from "@/db/schema";
import { getCompanyId } from "@/lib/auth";
import { eq, and } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { archiveAgentIntegration, createAgentIntegration, listAgentIntegrationsForAgent } from "@/lib/agent-integrations";

export async function getAgentIntegrations(agentId: string) {
    const companyId = await getCompanyId();
    if (!companyId) throw new Error("Unauthorized");

    const integrations = await listAgentIntegrationsForAgent(companyId, agentId);

    return integrations.map(({ secretJson, ...integration }) => ({
        ...integration,
        secretConfigured: integration.ownership === "managed" || integration.compatMode === "legacy-inline",
    }));
}

export async function saveAgentIntegration(data: {
    agentId: string;
    provider: string;
    name: string;
    configJson: any;
    secretJson: any;
}) {
    const companyId = await getCompanyId();
    if (!companyId) throw new Error("Unauthorized");

    const newIntegration = await createAgentIntegration({
        companyId,
        agentId: data.agentId,
        provider: data.provider,
        name: data.name,
        configJson: data.configJson,
        secretJson: data.secretJson,
    });

    revalidatePath("/agents");
    revalidatePath(`/agents/${data.agentId}`);
    return {
        ...newIntegration,
        secretConfigured: newIntegration.ownership === "managed" || newIntegration.compatMode === "legacy-inline",
    };
}

export async function deleteAgentIntegration(id: string) {
    const companyId = await getCompanyId();
    if (!companyId) throw new Error("Unauthorized");

    await archiveAgentIntegration(companyId, id);

    revalidatePath("/agents");
}
