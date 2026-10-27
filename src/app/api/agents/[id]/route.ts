import { NextRequest, NextResponse } from "next/server";
import { deleteAgentAndData } from "@/lib/agent-deletion";
import { db } from "@/db";
import {
    actionRuns,
    agentMemoryEntries,
    agentMemorySnapshots,
    agentSessions,
    agents,
    llmPricing,
    messageThreads,
    threadMessages,
    threadParticipants,
} from "@/db/schema";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { isMissingSchemaError } from "@/lib/schema-compat";
import { userMayUseThread } from "@/lib/direct-chat-mode";
import { getDirectChatMode } from "@/lib/control-plane";
import { resolveAgentModelConfiguration } from "@/lib/agent-model-config";
import { encryptSecretPayload } from "@/lib/secrets";
import { validAvatarUrl } from "@/lib/avatar";
import { legacyAvatarToAppearance, normalizeAppearance } from "@/lib/character/model";
import { companyRouteAccess } from "@/lib/company-access";
import { memberMaySeeAgent } from "@/lib/member-scope";
import { canAdmin } from "@/lib/role-matrix";
import { humanActor, recordAgentChange } from "@/lib/audit";

function redactAgent<T extends { llmApiKeyEncrypted?: unknown; llmApiKeyVersion?: unknown }>(agent: T) {
    const { llmApiKeyEncrypted: _e, llmApiKeyVersion: _v, ...safe } = agent;
    void _e;
    void _v;
    return safe;
}

export const dynamic = "force-dynamic";

export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const access = await companyRouteAccess("member");
    if (access.response) return access.response;
    const companyId = access.ctx.companyId;

    const { id } = await params;
    if (!memberMaySeeAgent(access.ctx.scope, id)) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
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
    const llmApiKey = typeof body.llmApiKey === "string" ? body.llmApiKey.trim() : "";
    if (llmApiKey) {
        const encrypted = encryptSecretPayload({ apiKey: llmApiKey });
        if (!encrypted) {
            return NextResponse.json(
                { error: "EMPEROR_CLAW_MASTER_KEY is not configured; cannot store LLM API keys." },
                { status: 500 }
            );
        }
        updates.llmApiKeyEncrypted = encrypted.encryptedSecret;
        updates.llmApiKeyVersion = encrypted.keyVersion;
    }
    const llmProviderProvided =
        typeof body.llmProvider === "string" &&
        ["", "openai", "anthropic", "google", "openrouter", "grok", "deepseek"].includes(body.llmProvider);
    const llmModelProvided = typeof body.llmModel === "string";
    if (llmProviderProvided || llmModelProvided) {
        const [[currentAgent], pricing] = await Promise.all([
            db.select({ llmProvider: agents.llmProvider, llmModel: agents.llmModel })
                .from(agents)
                .where(and(eq(agents.id, id), eq(agents.companyId, companyId), isNull(agents.deletedAt)))
                .limit(1),
            db.select({ provider: llmPricing.provider, model: llmPricing.model }).from(llmPricing),
        ]);
        if (!currentAgent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
        const resolved = resolveAgentModelConfiguration({
            current: currentAgent,
            provider: llmProviderProvided ? body.llmProvider : undefined,
            model: llmModelProvided ? body.llmModel : undefined,
            pricing,
        });
        updates.llmProvider = resolved.llmProvider;
        updates.llmModel = resolved.llmModel;
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
    if (before) await recordAgentChange(companyId, humanActor(access.ctx.userId), before, updated);

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
    if (!memberMaySeeAgent(access.ctx.scope, id)) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    const [agent] = await db.select().from(agents).where(
        and(eq(agents.id, id), eq(agents.companyId, companyId), isNull(agents.deletedAt))
    ).limit(1);

    if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });

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

    return NextResponse.json({
        agent: redactAgent(agent),
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
    if (!memberMaySeeAgent(access.ctx.scope, id)) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
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
