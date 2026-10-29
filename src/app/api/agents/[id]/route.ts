import { NextRequest, NextResponse } from "next/server";
import { deleteAgentAndData } from "@/lib/agent-deletion";
import { db } from "@/db";
import {
    actionRuns,
    agentMemoryEntries,
    agentMemorySnapshots,
    agentRuns,
    agentSessions,
    agents,
    llmPricing,
    runtimeHosts,
    messageThreads,
    threadMessages,
    threadParticipants,
} from "@/db/schema";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { isMissingSchemaError } from "@/lib/schema-compat";
import { userMayUseThread } from "@/lib/direct-chat-mode";
import { getDirectChatMode } from "@/lib/control-plane";
import { resolveAgentModelConfiguration } from "@/lib/agent-model-config";
import { decryptSecretPayload, encryptSecretPayload } from "@/lib/secrets";
import { CUSTOM_LLM_PROVIDER, checkLlmModelName, llmEndpointHost, llmSecretPayload, normalizeLlmBaseUrl, parseLlmSecret, type LlmSecret } from "@/lib/llm-endpoint";
import { checkLlmEndpointForSave } from "@/lib/llm-endpoint-policy";
import { validAvatarUrl } from "@/lib/avatar";
import { legacyAvatarToAppearance, normalizeAppearance } from "@/lib/character/model";
import { companyRouteAccess } from "@/lib/company-access";
import { agentUseFor, loadAgentAccessInfo } from "@/lib/agent-access-server";
import type { AgentUse } from "@/lib/agent-access";
import { canAdmin } from "@/lib/role-matrix";
import { humanActor, recordAgentChange } from "@/lib/audit";
import { PROVIDER_TROUBLE_RUNS, providerTroubleFromRuns } from "@/lib/provider-trouble";

function redactAgent<T extends { llmApiKeyEncrypted?: unknown; llmApiKeyVersion?: unknown }>(agent: T) {
    const { llmApiKeyEncrypted: _e, llmApiKeyVersion: _v, ...safe } = agent;
    void _e;
    void _v;
    return safe;
}

export const dynamic = "force-dynamic";

/** What an owner/admin who may not use an agent sees: name, owner, status and cost (lib/agent-access.ts). */
function agentMetadata(agent: typeof agents.$inferSelect) {
    return {
        id: agent.id, name: agent.name, role: agent.role, avatarUrl: agent.avatarUrl, avatarAppearance: agent.avatarAppearance,
        status: agent.status, lastSeenAt: agent.lastSeenAt, createdAt: agent.createdAt,
        monthlyCostCents: agent.monthlyCostCents, monthlyBudgetCents: agent.monthlyBudgetCents, budgetStatus: agent.budgetStatus,
        access: agent.access, ownerUserId: agent.ownerUserId,
    };
}

/** 404 when the agent is out of reach, 403 when only its metadata is (owners/admins). */
function agentUseDenied(use: AgentUse): NextResponse | null {
    if (use === "full") return null;
    return use === "metadata"
        ? NextResponse.json({ error: "This agent is limited to other people" }, { status: 403 })
        : NextResponse.json({ error: "Agent not found" }, { status: 404 });
}

const LLM_FIELDS = ["llmProvider", "llmModel", "llmApiKey", "llmBaseUrl"] as const;
const LLM_PROVIDERS = ["", "openai", "anthropic", "google", "openrouter", "grok", "deepseek", CUSTOM_LLM_PROVIDER];

type LlmAudit = { before: { llmEndpointHost: string | null }; after: { llmEndpointHost: string | null; llmKeyChanged?: true } };
type LlmChange = { error: string; status: number } | { updates: Record<string, unknown>; audit: LlmAudit };

/**
 * Resolve a PATCH of the agent's model endpoint (provider, base URL, model,
 * key) into column updates.
 *
 * The stored key only ever goes back to the endpoint it was given for: when
 * the provider or the base URL changes (a model of another provider changes
 * the provider too), the request must carry the new endpoint's key
 * (`llmApiKey`), or `llmApiKey: null` for an endpoint without one. Clearing
 * the provider drops the key. `llmApiKey` alone rotates the key for the
 * current endpoint; an empty string changes nothing.
 */
async function resolveLlmChange(body: Record<string, unknown>, agentId: string, companyId: string): Promise<LlmChange> {
    const providerProvided = body.llmProvider !== undefined;
    if (providerProvided && (typeof body.llmProvider !== "string" || !LLM_PROVIDERS.includes(body.llmProvider))) {
        return { error: "Unknown LLM provider", status: 400 };
    }
    let model: string | undefined;
    if (body.llmModel !== undefined) {
        const checked = checkLlmModelName(body.llmModel);
        if (!checked.ok) return { error: checked.error, status: 400 };
        model = checked.model;
    }
    if (body.llmApiKey !== undefined && body.llmApiKey !== null && typeof body.llmApiKey !== "string") {
        return { error: "llmApiKey must be a string, or null for an endpoint without a key", status: 400 };
    }
    const newKey = typeof body.llmApiKey === "string" ? body.llmApiKey.trim() : "";
    const keyRemoved = body.llmApiKey === null;
    let newBaseUrl: string | null | undefined;
    if (body.llmBaseUrl === null) newBaseUrl = null;
    else if (body.llmBaseUrl !== undefined) {
        const checked = normalizeLlmBaseUrl(body.llmBaseUrl);
        if (!checked.ok) return { error: checked.error, status: 400 };
        const allowed = await checkLlmEndpointForSave(checked.url);
        if (!allowed.ok) return { error: allowed.error, status: 400 };
        newBaseUrl = checked.url;
    }

    const [current] = await db.select({ llmProvider: agents.llmProvider, llmModel: agents.llmModel, llmApiKeyEncrypted: agents.llmApiKeyEncrypted })
        .from(agents).where(and(eq(agents.id, agentId), eq(agents.companyId, companyId), isNull(agents.deletedAt))).limit(1);
    if (!current) return { error: "Agent not found", status: 404 };
    let previous: LlmSecret = { apiKey: null, baseUrl: null };
    if (current.llmApiKeyEncrypted) {
        try { previous = parseLlmSecret(decryptSecretPayload(current.llmApiKeyEncrypted)); } catch { /* unreadable: replaced below if anything changes */ }
    }

    const requestedProvider = providerProvided ? body.llmProvider as string : current.llmProvider;
    const resolved = resolveAgentModelConfiguration({
        current: { llmProvider: current.llmProvider, llmModel: current.llmModel },
        provider: providerProvided ? body.llmProvider as string : undefined,
        model,
        // A custom endpoint's model name is its own, never a priced model of another provider.
        pricing: requestedProvider === CUSTOM_LLM_PROVIDER ? [] : await db.select({ provider: llmPricing.provider, model: llmPricing.model }).from(llmPricing),
    });

    const custom = resolved.llmProvider === CUSTOM_LLM_PROVIDER;
    const wasCustom = current.llmProvider === CUSTOM_LLM_PROVIDER;
    const previousBaseUrl = wasCustom ? previous.baseUrl : null;
    const nextBaseUrl = custom ? (newBaseUrl !== undefined ? newBaseUrl : previousBaseUrl) : null;
    if (custom && !nextBaseUrl) return { error: "A custom endpoint needs its base URL (llmBaseUrl).", status: 400 };
    if (!custom && newBaseUrl) return { error: "A base URL only applies to the custom (OpenAI-compatible) provider.", status: 400 };
    const endpointChanged = (resolved.llmProvider ?? null) !== (current.llmProvider ?? null) || nextBaseUrl !== previousBaseUrl;

    let nextKey: string | null;
    if (newKey) nextKey = newKey;
    else if (keyRemoved || !resolved.llmProvider) nextKey = null;
    else if (endpointChanged && previous.apiKey) {
        return {
            error: "Changing the provider or base URL needs that endpoint's API key (llmApiKey, or null for an endpoint without one): the stored key is never sent to a different endpoint.",
            status: 400,
        };
    } else nextKey = endpointChanged ? null : previous.apiKey;

    const updates: Record<string, unknown> = {};
    if (providerProvided || model !== undefined) {
        updates.llmProvider = resolved.llmProvider;
        updates.llmModel = resolved.llmModel;
    }
    const keyChanged = nextKey !== previous.apiKey;
    if (keyChanged || nextBaseUrl !== previous.baseUrl) {
        const payload = llmSecretPayload({ apiKey: nextKey, baseUrl: nextBaseUrl });
        if (payload) {
            const encrypted = encryptSecretPayload(payload);
            if (!encrypted) return { error: "EMPEROR_CLAW_MASTER_KEY is not configured; cannot store LLM API keys.", status: 500 };
            updates.llmApiKeyEncrypted = encrypted.encryptedSecret;
            updates.llmApiKeyVersion = encrypted.keyVersion;
        } else {
            updates.llmApiKeyEncrypted = null;
            updates.llmApiKeyVersion = null;
        }
    }
    return {
        updates,
        audit: {
            before: { llmEndpointHost: llmEndpointHost(previousBaseUrl) },
            after: { llmEndpointHost: llmEndpointHost(nextBaseUrl), ...(keyChanged ? { llmKeyChanged: true as const } : {}) },
        },
    };
}

export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const access = await companyRouteAccess("member");
    if (access.response) return access.response;
    const companyId = access.ctx.companyId;

    const { id } = await params;
    // Configuring an agent needs full use of it (0.20): who can use it is /access.
    const denied = agentUseDenied(await agentUseFor(access.ctx, id));
    if (denied) return denied;
    const body = await req.json().catch(() => ({}));

    if (body.provider !== undefined || body.deploymentMode !== undefined) {
        const [current] = await db.select({ provider: agents.provider, deploymentMode: agents.deploymentMode })
            .from(agents).where(and(eq(agents.id, id), eq(agents.companyId, companyId), isNull(agents.deletedAt))).limit(1);
        if (!current) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
        if ((body.deploymentMode ?? current.deploymentMode) === "local" && (body.provider ?? current.provider) !== "hermes") {
            return NextResponse.json({ error: "Only Hermes supports local deployment" }, { status: 400 });
        }
    }

    // Support updating doctrine_json, budget, provider, deployment mode, and other fields
    const updates: Record<string, unknown> = {};
    if (body.doctrineJson && typeof body.doctrineJson === "object") {
        updates.doctrineJson = body.doctrineJson;
    }
    if (body.avatarAppearance !== undefined) {
        const appearance = body.avatarAppearance === null ? null : normalizeAppearance(body.avatarAppearance);
        if (body.avatarAppearance !== null && !appearance) {
            return NextResponse.json({ error: "avatarAppearance is not a valid character appearance" }, { status: 400 });
        }
        updates.avatarAppearance = appearance;
        if (appearance) updates.avatarUrl = null;
    }
    if (body.avatarUrl !== undefined) {
        const avatarUrl = body.avatarUrl === null ? null : validAvatarUrl(body.avatarUrl);
        if (body.avatarUrl !== null && !avatarUrl) return NextResponse.json({ error: "avatarUrl must be an https image URL" }, { status: 400 });
        const legacy = legacyAvatarToAppearance(avatarUrl);
        if (legacy) {
            updates.avatarAppearance = legacy;
            updates.avatarUrl = null;
        } else {
            updates.avatarUrl = avatarUrl;
            if (avatarUrl && body.avatarAppearance === undefined) updates.avatarAppearance = null;
        }
    }
    if (typeof body.provider === "string" && body.provider) {
        updates.provider = body.provider;
    }
    if (typeof body.deploymentMode === "string" && ["local", "remote"].includes(body.deploymentMode)) {
        updates.deploymentMode = body.deploymentMode;
    }
    if (typeof body.monthlyBudgetCents === "number" && body.monthlyBudgetCents >= 0) {
        updates.monthlyBudgetCents = Math.round(body.monthlyBudgetCents);
    }
    if (typeof body.monthlyTokenUsage === "number" && body.monthlyTokenUsage >= 0) {
        updates.monthlyTokenUsage = Math.round(body.monthlyTokenUsage);
    }
    if (typeof body.budgetStatus === "string" && ["active", "warning", "paused"].includes(body.budgetStatus)) {
        updates.budgetStatus = body.budgetStatus;
    }
    if (body.scopeJson && typeof body.scopeJson === "object") {
        // An agent's data scope is a security boundary: only owners/admins set it.
        if (!canAdmin(access.ctx.role)) {
            return NextResponse.json({ error: "Only owners and admins can change an agent's data scope" }, { status: 403 });
        }
        const mode = body.scopeJson.mode;
        if (mode !== "all" && mode !== "restricted") {
            return NextResponse.json({ error: "scopeJson.mode must be 'all' or 'restricted'" }, { status: 400 });
        }
        const asStringArray = (value: unknown): string[] =>
            Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
        // agentIds: the agents it can work with (one-way). null = all agents
        // (the default); an array, even empty, = only those plus itself.
        // Omitted = keep the stored list, so editing customers/projects never
        // silently lifts an agent restriction.
        let agentIds: string[] | undefined;
        if (Array.isArray(body.scopeJson.agentIds)) {
            agentIds = [...new Set(asStringArray(body.scopeJson.agentIds).filter((agentId) => agentId !== id))];
        } else if (body.scopeJson.agentIds === undefined) {
            const [current] = await db.select({ scopeJson: agents.scopeJson }).from(agents)
                .where(and(eq(agents.id, id), eq(agents.companyId, companyId), isNull(agents.deletedAt))).limit(1);
            const stored = (current?.scopeJson as { agentIds?: unknown } | null | undefined)?.agentIds;
            agentIds = Array.isArray(stored) ? asStringArray(stored) : undefined;
        } else if (body.scopeJson.agentIds !== null) {
            return NextResponse.json({ error: "scopeJson.agentIds must be a list of agent ids or null" }, { status: 400 });
        }
        if (Array.isArray(body.scopeJson.agentIds) && agentIds && agentIds.length > 0) {
            const known = await db.select({ id: agents.id }).from(agents)
                .where(and(eq(agents.companyId, companyId), isNull(agents.deletedAt), inArray(agents.id, agentIds)));
            if (known.length !== agentIds.length) {
                return NextResponse.json({ error: "scopeJson.agentIds contains an unknown agent" }, { status: 400 });
            }
        }
        updates.scopeJson = {
            mode,
            customerIds: asStringArray(body.scopeJson.customerIds),
            projectIds: asStringArray(body.scopeJson.projectIds),
            ...(agentIds ? { agentIds } : {}),
        };
    }
    // The provider, base URL, model and key decide where the agent's key is
    // sent, so only owners and admins change them: a member could otherwise
    // point a stored key at a host they control and recreate the runtime.
    const llmFieldsTouched = LLM_FIELDS.some((field) => body[field] !== undefined);
    if (llmFieldsTouched && !canAdmin(access.ctx.role)) {
        return NextResponse.json({ error: "Only owners and admins can change an agent's model provider, endpoint, model or API key" }, { status: 403 });
    }
    let llmAudit: LlmAudit | null = null;
    if (llmFieldsTouched) {
        const change = await resolveLlmChange(body, id, companyId);
        if ("error" in change) return NextResponse.json({ error: change.error }, { status: change.status });
        Object.assign(updates, change.updates);
        llmAudit = change.audit;
    }

    if (Object.keys(updates).length === 0) {
        return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
    }

    const [before] = await db.select().from(agents).where(and(eq(agents.id, id), eq(agents.companyId, companyId), isNull(agents.deletedAt))).limit(1);
    const [updated] = await db.update(agents)
        .set(updates)
        .where(and(eq(agents.id, id), eq(agents.companyId, companyId)))
        .returning();

    if (!updated) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    if (before) {
        await recordAgentChange(
            companyId,
            humanActor(access.ctx.userId),
            llmAudit ? { ...before, ...llmAudit.before } : before,
            llmAudit ? { ...updated, ...llmAudit.after } : updated,
        );
    }

    return NextResponse.json({ agent: redactAgent(updated) });
}

export async function GET(
    _req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const access = await companyRouteAccess("viewer");
    if (access.response) return access.response;
    const companyId = access.ctx.companyId;
    const viewerId = access.ctx.userId;

    const { id } = await params;
    const use = await agentUseFor(access.ctx, id);
    if (use === "none") return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    const [agent] = await db.select().from(agents).where(
        and(eq(agents.id, id), eq(agents.companyId, companyId), isNull(agents.deletedAt))
    ).limit(1);

    if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    const accessInfo = await loadAgentAccessInfo(companyId, id);
    // An owner/admin who may not use it: name, owner, status and cost only.
    if (use === "metadata") {
        return NextResponse.json({ agent: agentMetadata(agent), access: "metadata", accessInfo });
    }

    let latestSnapshot = null;
    let memoryEntries: typeof agentMemoryEntries.$inferSelect[] = [];
    let sessions: typeof agentSessions.$inferSelect[] = [];
    let runs: typeof actionRuns.$inferSelect[] = [];
    let threads: typeof messageThreads.$inferSelect[] = [];
    let lastMessages: typeof threadMessages.$inferSelect[] = [];

    try {
        [latestSnapshot] = await db.select().from(agentMemorySnapshots).where(
            and(eq(agentMemorySnapshots.companyId, companyId), eq(agentMemorySnapshots.agentId, id))
        ).orderBy(desc(agentMemorySnapshots.createdAt)).limit(1);

        memoryEntries = await db.select().from(agentMemoryEntries).where(
            and(eq(agentMemoryEntries.companyId, companyId), eq(agentMemoryEntries.agentId, id))
        ).orderBy(desc(agentMemoryEntries.createdAt)).limit(30);

        sessions = await db.select().from(agentSessions).where(
            and(eq(agentSessions.companyId, companyId), eq(agentSessions.agentId, id))
        ).orderBy(desc(agentSessions.startedAt)).limit(20);

        runs = await db.select().from(actionRuns).where(
            and(eq(actionRuns.companyId, companyId), eq(actionRuns.agentId, id))
        ).orderBy(desc(actionRuns.startedAt)).limit(20);

        const participants = await db.select().from(threadParticipants).where(
            and(eq(threadParticipants.companyId, companyId), eq(threadParticipants.participantType, "agent"), eq(threadParticipants.participantId, id))
        );

        const threadIds = participants.map(p => p.threadId);
        threads = threadIds.length > 0
            ? await db.select().from(messageThreads).where(
                and(eq(messageThreads.companyId, companyId), inArray(messageThreads.id, threadIds), isNull(messageThreads.archivedAt))
            ).orderBy(desc(messageThreads.createdAt)).limit(20)
            : [];
        // Never list (or quote) another person's private direct thread.
        threads = threads.filter((thread) => userMayUseThread(thread, viewerId));

        lastMessages = threadIds.length > 0
            ? await db.select().from(threadMessages).where(
                and(eq(threadMessages.companyId, companyId), inArray(threadMessages.threadId, threadIds))
            ).orderBy(desc(threadMessages.createdAt)).limit(100)
            : [];
    } catch (error) {
        if (!isMissingSchemaError(error)) throw error;
    }

    const latestMessageByThread: Record<string, typeof threadMessages.$inferSelect> = {};
    for (const msg of lastMessages) {
        if (!latestMessageByThread[msg.threadId]) latestMessageByThread[msg.threadId] = msg;
    }

    // Online can still mean every turn fails on the model provider: say so next to the status.
    const latestRuns = await db.select({ status: agentRuns.status, error: agentRuns.error, exitReason: agentRuns.exitReason, startedAt: agentRuns.startedAt, endedAt: agentRuns.endedAt })
        .from(agentRuns).where(and(eq(agentRuns.companyId, companyId), eq(agentRuns.agentId, id), inArray(agentRuns.status, ["succeeded", "failed", "timeout", "lost"])))
        .orderBy(desc(agentRuns.startedAt)).limit(PROVIDER_TROUBLE_RUNS)
        .catch(() => []);

    // The paired runtime host it runs on (0.21): Settings -> Runtime hosts.
    const [runtimeHost] = agent.runtimeHostId
        ? await db.select({ id: runtimeHosts.id, name: runtimeHosts.name, status: runtimeHosts.status, inventoryJson: runtimeHosts.inventoryJson })
            .from(runtimeHosts).where(and(eq(runtimeHosts.id, agent.runtimeHostId), eq(runtimeHosts.companyId, companyId), isNull(runtimeHosts.revokedAt))).limit(1)
        : [];
    const hostProfiles = ((runtimeHost?.inventoryJson as { profiles?: { profile?: string; topology?: string }[] } | null)?.profiles) ?? [];

    return NextResponse.json({
        agent: redactAgent(agent),
        access: "full",
        accessInfo,
        providerTrouble: providerTroubleFromRuns(latestRuns),
        runtimeHost: runtimeHost ? {
            id: runtimeHost.id,
            name: runtimeHost.name,
            status: runtimeHost.status,
            profile: agent.runtimeProfile,
            // As last reported (display only: the host's own record decides what a restart touches).
            topology: (() => {
                const reported = hostProfiles.find((p) => p.profile === agent.runtimeProfile)?.topology;
                return reported === "shared" || reported === "standalone" ? reported : "unknown";
            })(),
            sharedAgents: hostProfiles.filter((p) => p.topology === "shared").length,
        } : null,
        directChatMode: await getDirectChatMode(companyId),
        latestSnapshot,
        memoryEntries,
        sessions,
        runs,
        threads: threads.map(t => ({
            ...t,
            lastMessage: latestMessageByThread[t.id]?.text ?? null,
        })),
    });
}

export async function DELETE(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const access = await companyRouteAccess("member");
    if (access.response) return access.response;
    const companyId = access.ctx.companyId;
    const userId = access.ctx.userId;

    const { id } = await params;
    // An agent limited to some people is deleted by its owner, owners and admins (who may not use it).
    const use = await agentUseFor(access.ctx, id);
    if (use === "none") return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    const accessInfo = await loadAgentAccessInfo(companyId, id);
    if (accessInfo && accessInfo.access !== "everyone" && !canAdmin(access.ctx.role) && accessInfo.owner?.id !== userId) {
        return NextResponse.json({ error: "Only its owner, owners and admins can delete this agent" }, { status: 403 });
    }
    const body = await req.json().catch(() => ({}));
    const confirmName = typeof body.confirmName === "string" ? body.confirmName.trim() : "";

    let deleted;
    try {
        deleted = await deleteAgentAndData({
            companyId,
            agentId: id,
            actorType: "human",
            actorId: userId,
            confirmName,
        });
    } catch (error) {
        if (error instanceof Error && error.name === "ConfirmationMismatchError") {
            return NextResponse.json({ error: error.message }, { status: 400 });
        }
        throw error;
    }

    if (!deleted) {
        return NextResponse.json({ error: "Agent not found or already deleted." }, { status: 404 });
    }

    const { agent: deletedAgent, cleanup } = deleted;
    return NextResponse.json({
        message: `Agent ${deletedAgent.name} deleted.`,
        agent: { id: deletedAgent.id, name: deletedAgent.name },
        cleanup,
    });
}
