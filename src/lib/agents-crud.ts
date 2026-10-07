import { db } from "@/db";
import { agents, llmPricing } from "@/db/schema";
import { and, desc, eq, isNull } from "drizzle-orm";
import { writeAgentMemory } from "@/lib/control-plane";
import { resolveAgentModelConfiguration } from "@/lib/agent-model-config";
import { logAudit } from "@/lib/mcp";
import { broadcastMcpEvent } from "@/lib/pubsub";
import { legacyAvatarToAppearance, normalizeAppearance, resolveAvatarPhoto } from "@/lib/character/model";

// Strips the encrypted LLM API key (ciphertext + rotation version) before
// returning an agent row to any caller — REST or MCP. Encrypted at rest, but
// there's no legitimate reason for a caller to ever see it, so don't emit it.
function redactAgent<T extends { llmApiKeyEncrypted?: unknown; llmApiKeyVersion?: unknown }>(agent: T) {
    const { llmApiKeyEncrypted: _e, llmApiKeyVersion: _v, ...safe } = agent;
    void _e;
    void _v;
    return safe;
}

export type ListAgentsInput = {
    companyId: string;
    limit?: number;
};

export async function listAgentsForCompany(input: ListAgentsInput) {
    const limit = Math.min(input.limit || 100, 500);
    const rows = await db.select()
        .from(agents)
        .where(and(eq(agents.companyId, input.companyId), isNull(agents.deletedAt)))
        .orderBy(desc(agents.createdAt))
        .limit(limit);
    return rows.map(redactAgent);
}

export async function getAgentForCompany(companyId: string, agentId: string) {
    const [agent] = await db.select().from(agents).where(
        and(eq(agents.id, agentId), eq(agents.companyId, companyId), isNull(agents.deletedAt))
    ).limit(1);
    return agent ? redactAgent(agent) : null;
}

export type CreateAgentInput = {
    companyId: string;
    name: string;
    role?: string | null;
    avatarUrl?: string | null;
    avatarAppearance?: unknown;
    skillsJson?: unknown[] | null;
    memory?: string | null;
    modelPolicyJson?: Record<string, unknown> | null;
    concurrencyLimit?: number | null;
    llmProvider?: string | null;
    llmModel?: string | null;
    actorType?: string;
};

export async function createAgentForCompany(input: CreateAgentInput) {
    const pricing = await db.select({ provider: llmPricing.provider, model: llmPricing.model }).from(llmPricing);
    const llmConfiguration = resolveAgentModelConfiguration({
        current: { llmProvider: null, llmModel: null },
        provider: input.llmProvider ?? undefined,
        model: input.llmModel ?? undefined,
        pricing,
    });

    // A drawn character override wins; a legacy DiceBear URL in avatarUrl is
    // turned into an appearance so its seed survives. Otherwise both stay null
    // and the look is derived from the agent id.
    const requestedAppearance = normalizeAppearance(input.avatarAppearance);
    const legacyAppearance = legacyAvatarToAppearance(input.avatarUrl);
    const avatarAppearance = requestedAppearance ?? legacyAppearance;
    const avatarUrl = avatarAppearance ? null : resolveAvatarPhoto({ avatarUrl: input.avatarUrl });

    const [agent] = await db.insert(agents).values({
        companyId: input.companyId,
        name: input.name,
        role: input.role || "operator",
        avatarUrl,
        avatarAppearance,
        skillsJson: Array.isArray(input.skillsJson) ? input.skillsJson : [],
        memory: input.memory || null,
        modelPolicyJson: input.modelPolicyJson || {},
        concurrencyLimit: typeof input.concurrencyLimit === "number" ? input.concurrencyLimit : 1,
        status: "online",
        lastSeenAt: new Date(),
        currentLoad: 0,
        llmProvider: llmConfiguration.llmProvider,
        llmModel: llmConfiguration.llmModel,
    }).returning();

    await logAudit(input.companyId, input.actorType || "system", null, "register_agent", "agent", agent.id, { name: input.name, role: input.role });

    if (input.memory) {
        await writeAgentMemory({
            companyId: input.companyId,
            agentId: agent.id,
            kind: "context",
            content: input.memory,
            summary: `Initial memory bootstrap for ${input.name}`,
            snapshot: input.memory,
        });
    }

    await broadcastMcpEvent(input.companyId, { type: "agent_registered", agent });
    return redactAgent(agent);
}

export type UpdateAgentInput = {
    companyId: string;
    agentId: string;
    name?: string;
    role?: string;
    avatarUrl?: string;
    avatarAppearance?: unknown;
    skillsJson?: unknown[];
    memory?: string;
    modelPolicyJson?: Record<string, unknown>;
    concurrencyLimit?: number;
    monthlyBudgetCents?: number;
    monthlyCostCents?: number;
    monthlyTokenUsage?: number;
    budgetStatus?: "active" | "warning" | "paused";
    llmProvider?: string;
    llmModel?: string;
};

export async function updateAgentForCompany(input: UpdateAgentInput) {
    const existing = await getAgentForCompany(input.companyId, input.agentId);
    if (!existing) {
        throw new Error("AGENT_NOT_FOUND");
    }

    const hasLLM = typeof input.llmProvider === "string" || typeof input.llmModel === "string";

    const updateData: Record<string, unknown> = {};
    if (input.name !== undefined) updateData.name = input.name;
    if (input.role !== undefined) updateData.role = input.role;
    if (input.skillsJson !== undefined) updateData.skillsJson = input.skillsJson;
    if (input.memory !== undefined) updateData.memory = input.memory;
    if (input.modelPolicyJson !== undefined) updateData.modelPolicyJson = input.modelPolicyJson;
    if (input.concurrencyLimit !== undefined) updateData.concurrencyLimit = input.concurrencyLimit;
    if (input.avatarAppearance !== undefined) updateData.avatarAppearance = normalizeAppearance(input.avatarAppearance);
    if (input.avatarUrl !== undefined) {
        // A legacy DiceBear URL becomes an explicit appearance; any other URL is
        // kept as the uploaded photo and clears the drawn override.
        const legacy = legacyAvatarToAppearance(input.avatarUrl);
        if (legacy) {
            updateData.avatarAppearance = legacy;
            updateData.avatarUrl = null;
        } else {
            updateData.avatarUrl = input.avatarUrl || null;
            if (input.avatarAppearance === undefined && input.avatarUrl) updateData.avatarAppearance = null;
        }
    }
    if (typeof input.monthlyBudgetCents === "number" && input.monthlyBudgetCents >= 0) updateData.monthlyBudgetCents = Math.round(input.monthlyBudgetCents);
    if (typeof input.monthlyCostCents === "number" && input.monthlyCostCents >= 0) updateData.monthlyCostCents = Math.round(input.monthlyCostCents);
    if (typeof input.monthlyTokenUsage === "number" && input.monthlyTokenUsage >= 0) updateData.monthlyTokenUsage = Math.round(input.monthlyTokenUsage);
    if (input.budgetStatus && ["active", "warning", "paused"].includes(input.budgetStatus)) updateData.budgetStatus = input.budgetStatus;
    if (hasLLM) {
        const pricing = await db.select({ provider: llmPricing.provider, model: llmPricing.model }).from(llmPricing);
        const resolved = resolveAgentModelConfiguration({
            current: { llmProvider: existing.llmProvider, llmModel: existing.llmModel },
            provider: input.llmProvider,
            model: input.llmModel,
            pricing,
        });
        updateData.llmProvider = resolved.llmProvider;
        updateData.llmModel = resolved.llmModel;
    }

    if (Object.keys(updateData).length === 0) {
        throw new Error("NO_FIELDS_TO_UPDATE");
    }

    const [updated] = await db.update(agents).set(updateData).where(eq(agents.id, input.agentId)).returning();

    if (input.memory !== undefined) {
        await writeAgentMemory({
            companyId: input.companyId,
            agentId: input.agentId,
            kind: "checkpoint",
            content: input.memory || "",
            summary: "Agent memory updated",
            snapshot: input.memory || "",
        });
    }

    await broadcastMcpEvent(input.companyId, { type: "agent_updated", agent: updated });
    return redactAgent(updated);
}
