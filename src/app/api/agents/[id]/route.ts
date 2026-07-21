import { NextRequest, NextResponse } from "next/server";
import { getCompanyId, getUserId } from "@/lib/auth";
import { deleteAgentAndData } from "@/lib/agent-deletion";
import { db } from "@/db";
import {
    actionRuns,
    agentMemoryEntries,
    agentMemorySnapshots,
    agentSessions,
    agents,
    messageThreads,
    threadMessages,
    threadParticipants,
} from "@/db/schema";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { isMissingSchemaError } from "@/lib/schema-compat";

export const dynamic = "force-dynamic";

export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const companyId = await getCompanyId();
    if (!companyId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;
    const body = await req.json().catch(() => ({}));

    // Support updating doctrine_json, budget, provider, deployment mode, and other fields
    const updates: Record<string, unknown> = {};
    if (body.doctrineJson && typeof body.doctrineJson === "object") {
        updates.doctrineJson = body.doctrineJson;
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
    if (typeof body.llmProvider === "string" && ["", "openai", "anthropic", "google", "openrouter", "grok", "deepseek"].includes(body.llmProvider)) {
        updates.llmProvider = body.llmProvider || null;
    }
    if (typeof body.llmModel === "string") {
        updates.llmModel = body.llmModel || null;
    }

    if (Object.keys(updates).length === 0) {
        return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
    }

    const [updated] = await db.update(agents)
        .set(updates)
        .where(and(eq(agents.id, id), eq(agents.companyId, companyId)))
        .returning();

    if (!updated) return NextResponse.json({ error: "Agent not found" }, { status: 404 });

    return NextResponse.json({ agent: updated });
}

export async function GET(
    _req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const companyId = await getCompanyId();
    if (!companyId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;
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
        agent,
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
    const [companyId, userId] = await Promise.all([getCompanyId(), getUserId()]);
    if (!companyId || !userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const confirmName = typeof body.confirmName === "string" ? body.confirmName.trim() : "";

    let deletedAgent;
    try {
        deletedAgent = await deleteAgentAndData({
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

    if (!deletedAgent) {
        return NextResponse.json({ error: "Agent not found or already deleted." }, { status: 404 });
    }

    return NextResponse.json({
        message: `Agent ${deletedAgent.name} deleted.`,
        agent: { id: deletedAgent.id, name: deletedAgent.name },
    });
}
