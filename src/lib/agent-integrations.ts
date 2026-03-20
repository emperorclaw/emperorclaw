import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentIntegrations, integrationSecretVersions } from "@/db/schema";
import { canManageSecrets, encryptSecretPayload } from "@/lib/secrets";
import { isMissingSchemaError } from "@/lib/schema-compat";

type CompatMode = "current" | "legacy-inline";

export type AgentIntegrationCompat = {
    id: string;
    companyId: string;
    agentId: string;
    provider: string;
    name: string;
    ownership: string;
    configJson: any;
    secretJson: any;
    status: string;
    lastUsedAt: Date | null;
    lastFailureAt: Date | null;
    lastFailureReason: string | null;
    createdAt: Date;
    updatedAt: Date;
    compatMode: CompatMode;
};

function withCompatMode<T extends Omit<AgentIntegrationCompat, "compatMode">>(rows: T[]): AgentIntegrationCompat[] {
    return rows.map((row) => ({
        ...row,
        compatMode: "current",
    }));
}

function getLegacySelect() {
    return {
        id: agentIntegrations.id,
        companyId: agentIntegrations.companyId,
        agentId: agentIntegrations.agentId,
        provider: agentIntegrations.provider,
        name: agentIntegrations.name,
        ownership: sql<string>`'legacy_inline'`,
        configJson: agentIntegrations.configJson,
        secretJson: agentIntegrations.secretJson,
        status: agentIntegrations.status,
        lastUsedAt: sql<Date | null>`null`,
        lastFailureAt: sql<Date | null>`null`,
        lastFailureReason: sql<string | null>`null`,
        createdAt: agentIntegrations.createdAt,
        updatedAt: agentIntegrations.updatedAt,
        compatMode: sql<CompatMode>`'legacy-inline'`,
    };
}

async function selectByConditions(conditions: ReturnType<typeof eq>[]) {
    try {
        const rows = await db.select().from(agentIntegrations).where(and(...conditions)).orderBy(desc(agentIntegrations.updatedAt));
        return withCompatMode(rows);
    } catch (error) {
        if (!isMissingSchemaError(error)) throw error;

        return db.select(getLegacySelect()).from(agentIntegrations).where(and(...conditions)).orderBy(desc(agentIntegrations.updatedAt));
    }
}

export async function listAgentIntegrationsForAgent(companyId: string, agentId: string) {
    return selectByConditions([
        eq(agentIntegrations.companyId, companyId),
        eq(agentIntegrations.agentId, agentId),
        eq(agentIntegrations.status, "active"),
    ]);
}

export async function listAgentIntegrationsForAgents(companyId: string, agentIds: string[]) {
    if (agentIds.length === 0) return [] as AgentIntegrationCompat[];

    return selectByConditions([
        eq(agentIntegrations.companyId, companyId),
        inArray(agentIntegrations.agentId, agentIds),
        eq(agentIntegrations.status, "active"),
    ]);
}

export async function getAgentIntegration(companyId: string, agentId: string, integrationId: string) {
    const integrations = await selectByConditions([
        eq(agentIntegrations.companyId, companyId),
        eq(agentIntegrations.agentId, agentId),
        eq(agentIntegrations.id, integrationId),
        eq(agentIntegrations.status, "active"),
    ]);

    return integrations[0];
}

export async function createAgentIntegration(input: {
    companyId: string;
    agentId: string;
    provider: string;
    name: string;
    configJson: any;
    secretJson: any;
}) {
    const ownership = canManageSecrets() ? "managed" : "local_runtime";
    const secretJson = input.secretJson || {};
    const configJson = input.configJson || {};

    try {
        const [newIntegration] = await db.insert(agentIntegrations).values({
            companyId: input.companyId,
            agentId: input.agentId,
            provider: input.provider,
            name: input.name,
            ownership,
            configJson,
            secretJson: ownership === "managed" ? {} : secretJson,
            status: "active",
        }).returning();

        if (ownership === "managed" && Object.keys(secretJson).length > 0) {
            const encrypted = encryptSecretPayload(secretJson);
            if (!encrypted) {
                throw new Error("Managed secret storage is unavailable");
            }

            try {
                await db.insert(integrationSecretVersions).values({
                    companyId: input.companyId,
                    integrationId: newIntegration.id,
                    version: 1,
                    encryptedSecret: encrypted.encryptedSecret,
                    keyVersion: encrypted.keyVersion,
                });
            } catch (error) {
                if (!isMissingSchemaError(error)) throw error;

                const [legacyStored] = await db.update(agentIntegrations).set({
                    secretJson,
                    updatedAt: new Date(),
                }).where(eq(agentIntegrations.id, newIntegration.id)).returning();

                return {
                    ...legacyStored,
                    ownership: "legacy_inline",
                    lastUsedAt: null,
                    lastFailureAt: null,
                    lastFailureReason: null,
                    compatMode: "legacy-inline" as const,
                };
            }
        }

        return {
            ...newIntegration,
            lastUsedAt: newIntegration.lastUsedAt ?? null,
            lastFailureAt: newIntegration.lastFailureAt ?? null,
            lastFailureReason: newIntegration.lastFailureReason ?? null,
            compatMode: "current" as const,
        };
    } catch (error) {
        if (!isMissingSchemaError(error)) throw error;

        const [legacyIntegration] = await db.insert(agentIntegrations).values({
            companyId: input.companyId,
            agentId: input.agentId,
            provider: input.provider,
            name: input.name,
            configJson,
            secretJson,
            status: "active",
        }).returning();

        return {
            ...legacyIntegration,
            ownership: Object.keys(secretJson).length > 0 ? "legacy_inline" : "local_runtime",
            lastUsedAt: null,
            lastFailureAt: null,
            lastFailureReason: null,
            compatMode: "legacy-inline" as const,
        };
    }
}

export async function archiveAgentIntegration(companyId: string, integrationId: string) {
    await db.update(agentIntegrations)
        .set({ status: "archived", updatedAt: new Date() })
        .where(and(eq(agentIntegrations.id, integrationId), eq(agentIntegrations.companyId, companyId)));
}

export async function updateIntegrationLeaseState(
    integrationId: string,
    patch: Partial<Pick<AgentIntegrationCompat, "lastUsedAt" | "lastFailureAt" | "lastFailureReason">>
) {
    try {
        await db.update(agentIntegrations).set({
            ...patch,
            updatedAt: new Date(),
        }).where(eq(agentIntegrations.id, integrationId));
    } catch (error) {
        if (!isMissingSchemaError(error)) throw error;
    }
}
