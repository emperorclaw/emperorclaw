"use server";

import { db } from "@/db";
import { agentIntegrations } from "@/db/schema";
import { getCompanyId } from "@/lib/auth";
import { eq, and } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function getAgentIntegrations(agentId: string) {
    const companyId = await getCompanyId();
    if (!companyId) throw new Error("Unauthorized");

    return await db.select().from(agentIntegrations).where(
        and(
            eq(agentIntegrations.companyId, companyId),
            eq(agentIntegrations.agentId, agentId),
            eq(agentIntegrations.status, 'active')
        )
    );
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

    const [newIntegration] = await db.insert(agentIntegrations).values({
        companyId,
        agentId: data.agentId,
        provider: data.provider,
        name: data.name,
        configJson: data.configJson,
        secretJson: data.secretJson,
    }).returning();

    revalidatePath("/agents");
    return newIntegration;
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
