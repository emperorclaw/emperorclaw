"use server";

import { db } from "@/db";
import { agentIntegrations, integrationSecretVersions } from "@/db/schema";
import { getCompanyId } from "@/lib/auth";
import { eq, and } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { canManageSecrets, encryptSecretPayload } from "@/lib/secrets";

export async function getAgentIntegrations(agentId: string) {
    const companyId = await getCompanyId();
    if (!companyId) throw new Error("Unauthorized");

    const integrations = await db.select().from(agentIntegrations).where(
        and(
            eq(agentIntegrations.companyId, companyId),
            eq(agentIntegrations.agentId, agentId),
            eq(agentIntegrations.status, 'active')
        )
    );

    return integrations.map(({ secretJson, ...integration }) => ({
        ...integration,
        secretConfigured: integration.ownership === "managed",
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

    const ownership = canManageSecrets() ? "managed" : "local_runtime";
    const [newIntegration] = await db.insert(agentIntegrations).values({
        companyId,
        agentId: data.agentId,
        provider: data.provider,
        name: data.name,
        ownership,
        configJson: data.configJson,
        secretJson: {},
    }).returning();

    if (ownership === "managed" && data.secretJson && Object.keys(data.secretJson).length > 0) {
        const encrypted = encryptSecretPayload(data.secretJson);
        if (!encrypted) {
            throw new Error("Managed secret storage is unavailable");
        }

        await db.insert(integrationSecretVersions).values({
            companyId,
            integrationId: newIntegration.id,
            version: 1,
            encryptedSecret: encrypted.encryptedSecret,
            keyVersion: encrypted.keyVersion,
        });
    }

    revalidatePath("/agents");
    return {
        ...newIntegration,
        secretConfigured: ownership === "managed",
    };
}

export async function deleteAgentIntegration(id: string) {
    const companyId = await getCompanyId();
    if (!companyId) throw new Error("Unauthorized");

    await db.update(agentIntegrations)
        .set({ status: 'archived', updatedAt: new Date() })
        .where(and(
            eq(agentIntegrations.id, id),
            eq(agentIntegrations.companyId, companyId)
        ));

    revalidatePath("/agents");
}
