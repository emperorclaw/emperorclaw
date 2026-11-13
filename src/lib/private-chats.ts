/**
 * Several private chats per (person, agent): create, list, rename, archive and
 * restore (docs/design/multi-chat-per-agent.md §5). The main chat itself is
 * still created by ensureDirectThread (lib/control-plane.ts); everything here
 * runs under the same per-(person, agent) advisory lock, so the main-chat
 * get-or-create, the open-chat cap and restores never race each other.
 *
 * Privacy is unchanged: a chat is its owner's alone. Anyone else, admins
 * included, gets "not found". Audit rows carry ids and the agent's name only,
 * never a chat's title (it comes from the first message) or any content.
 */
import { createHash } from "node:crypto";
import { and, count, eq, inArray, isNotNull, isNull, max, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentObjectives, agentRuns, agents, companies, idempotencyKeys, messageThreads, threadMessages, threadParticipants } from "@/db/schema";
import { getDirectChatMode, getOrCreateMainChatLocked, insertPreparedThreadMessage, lockPrivateChats, prepareThreadMessage, type ThreadMessageAttachment } from "@/lib/control-plane";
import { agentUseFor, viewerForUser, type AgentAccessViewer } from "@/lib/agent-access-server";
import { humanActor, recordAudit } from "@/lib/audit";
import { unreadCountsForUser } from "@/lib/messages-listing";
import { chatLimitReached, newChatTitle, normalizeMultiChatSettings, type ArchiveReason, type MultiChatErrorCode, type MultiChatSettings } from "@/lib/multi-chat";
import { roleGte } from "@/lib/role-matrix";
import { cancelOpenAgentWork, getAgentRuntimeTraits } from "@/lib/agent-control";
import { broadcastMcpEvent } from "@/lib/pubsub";
import { isMissingSchemaError } from "@/lib/schema-compat";
import { consumeRateLimit } from "@/lib/rate-limit";

type ThreadRow = typeof messageThreads.$inferSelect;
type MessageRow = typeof threadMessages.$inferSelect;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A refusal with an HTTP status, a stable code and optional extra fields (e.g. the cap). */
export class PrivateChatError extends Error {
    constructor(message: string, readonly status: number, readonly code: MultiChatErrorCode | "not_found" | "forbidden" | "invalid", readonly extra: Record<string, unknown> = {}) {
        super(message);
        this.name = "PrivateChatError";
    }

    body() {
        return { error: this.message, code: this.code, ...this.extra };
    }
}

const notFound = () => new PrivateChatError("Conversation not found", 404, "not_found");

/** The company's multi-chat settings; off for a database without the columns yet. */
export async function getMultiChatSettings(companyId: string): Promise<MultiChatSettings> {
    try {
        const [row] = await db.select({
            multiChatEnabled: companies.multiChatEnabled,
            multiChatMaxOpen: companies.multiChatMaxOpen,
            multiChatIdleArchiveDays: companies.multiChatIdleArchiveDays,
        }).from(companies).where(eq(companies.id, companyId)).limit(1);
        return normalizeMultiChatSettings(row);
    } catch (error) {
        if (isMissingSchemaError(error)) return { ...normalizeMultiChatSettings(null), enabled: false };
        throw error;
    }
}

/** The person's live chats with an agent (main included): what the cap counts. */
async function openChatCount(executor: Pick<typeof db, "select">, companyId: string, userId: string, agentId: string): Promise<number> {
    const [row] = await executor.select({ value: count() }).from(messageThreads).where(and(
        eq(messageThreads.companyId, companyId),
        eq(messageThreads.type, "direct"),
        eq(messageThreads.ownerUserId, userId),
        eq(messageThreads.directAgentId, agentId),
        isNull(messageThreads.archivedAt),
    ));
    return Number(row?.value ?? 0);
}

/** The person's own private chat by id (live or archived), or null. Owner only: never anyone else's. */
export async function findOwnedPrivateChat(companyId: string, userId: string, threadId: string, agentId?: string | null): Promise<ThreadRow | null> {
    if (!UUID_RE.test(threadId) || !UUID_RE.test(userId)) return null;
    const [thread] = await db.select().from(messageThreads).where(and(
        eq(messageThreads.id, threadId),
        eq(messageThreads.companyId, companyId),
        eq(messageThreads.type, "direct"),
        eq(messageThreads.ownerUserId, userId),
        agentId ? eq(messageThreads.directAgentId, agentId) : undefined,
    )).limit(1);
    return thread ?? null;
}

/** Same idempotency table as the MCP Idempotency-Key (lib/mcp.ts), keyed per person and agent. */
const NEW_CHAT_ENDPOINT = "chat.new";

function newChatRequestHash(companyId: string, userId: string, agentId: string, clientKey: string): string {
    return createHash("sha256").update(`${NEW_CHAT_ENDPOINT}:${companyId}:${userId}:${agentId}:${clientKey}`).digest("hex");
}

async function requireFullUse(viewer: AgentAccessViewer, agentId: string) {
    const use = await agentUseFor(viewer, agentId);
    if (use === "full") return;
    throw use === "metadata"
        ? new PrivateChatError("This agent is limited to other people", 403, "forbidden")
        : new PrivateChatError("Agent not found", 404, "not_found");
}

async function agentName(companyId: string, agentId: string | null): Promise<string | null> {
    if (!agentId) return null;
    const [row] = await db.select({ name: agents.name }).from(agents).where(and(eq(agents.id, agentId), eq(agents.companyId, companyId))).limit(1);
    return row?.name ?? null;
}

async function auditThread(companyId: string, userId: string, action: "thread.created" | "thread.archived" | "thread.restored", thread: ThreadRow, extra: { reason?: ArchiveReason } = {}) {
    // Ids and the agent's name only: a chat's title comes from its first message.
    await recordAudit({
        companyId, actor: humanActor(userId), action, target: { type: "thread", id: thread.id },
        meta: { agentId: thread.directAgentId, label: await agentName(companyId, thread.directAgentId), ...(extra.reason ? { reason: extra.reason } : {}) },
    });
}

/**
 * Starts an extra private chat with an agent and posts its first message
 * (§5.1), in ONE transaction under the per-(person, agent) lock: the chat, the
 * `clientKey` idempotency row (with the message id) and the first message are
 * stored together or not at all, so there is never an empty chat and never a
 * second copy of the first message. The same key returns the same chat and
 * message (`created: false`), even after the setting or the cap changed.
 *
 * The person's main chat is created first when it does not exist yet, so the
 * open-chat cap (which counts it) is right from the first extra chat.
 *
 * `rateLimit` is consumed only for a real creation, after the idempotent
 * lookup: a retry of an existing key is never rate limited.
 *
 * Refusals: not a member / agent not usable (404/403), role below member
 * (403), setting off or company not in private mode (403
 * multi_chat_disabled), cap reached (409 chat_limit_reached {limit, open}),
 * rate limited (429 rate_limited {retryAfterMs}).
 */
export async function createPrivateChat(input: {
    companyId: string;
    userId: string;
    agentId: string;
    firstMessage: string;
    attachments?: ThreadMessageAttachment[];
    clientKey: string;
    rateLimit?: { key: string; limit: number; windowMs: number };
}): Promise<{ thread: ThreadRow; created: boolean; message: MessageRow }> {
    const { companyId, userId, agentId, clientKey } = input;
    const viewer = await viewerForUser(companyId, userId);
    if (!viewer) throw notFound();
    if (!roleGte(viewer.role, "member")) throw new PrivateChatError("Viewers cannot start chats", 403, "forbidden");
    await requireFullUse(viewer, agentId);

    // Every read the message needs, before the lock (no second connection under it).
    const prepared = await prepareThreadMessage({
        companyId, threadId: "", senderType: "human", senderId: userId, targetAgentId: agentId,
        text: input.firstMessage, attachments: input.attachments ?? [],
    });
    const requestHash = newChatRequestHash(companyId, userId, agentId, clientKey);
    const result = await db.transaction(async (tx) => {
        await lockPrivateChats(tx, companyId, agentId, userId);

        const [key] = await tx.select({ id: idempotencyKeys.id, snapshot: idempotencyKeys.responseSnapshot }).from(idempotencyKeys)
            .where(and(eq(idempotencyKeys.companyId, companyId), eq(idempotencyKeys.requestHash, requestHash))).limit(1);
        if (key) {
            const snapshot = (key.snapshot ?? {}) as { threadId?: unknown; messageId?: unknown };
            const [existing] = typeof snapshot.threadId === "string" && UUID_RE.test(snapshot.threadId)
                ? await tx.select().from(messageThreads).where(and(
                    eq(messageThreads.id, snapshot.threadId), eq(messageThreads.companyId, companyId), eq(messageThreads.ownerUserId, userId),
                )).limit(1)
                : [];
            const [message] = existing && typeof snapshot.messageId === "string" && UUID_RE.test(snapshot.messageId)
                ? await tx.select().from(threadMessages).where(and(
                    eq(threadMessages.id, snapshot.messageId), eq(threadMessages.companyId, companyId), eq(threadMessages.threadId, existing.id),
                )).limit(1)
                : [];
            if (existing && message) return { thread: existing, created: false, message };
            // The chat or its message is gone (e.g. the agent was deleted): the key is stale.
            await tx.delete(idempotencyKeys).where(eq(idempotencyKeys.id, key.id));
        }

        if (input.rateLimit) {
            const limit = consumeRateLimit(input.rateLimit);
            if (!limit.allowed) throw new PrivateChatError("Too many new chats. Try again in a minute.", 429, "rate_limited", { retryAfterMs: limit.retryAfterMs });
        }

        const [settingsRow] = await tx.select({
            multiChatEnabled: companies.multiChatEnabled,
            multiChatMaxOpen: companies.multiChatMaxOpen,
            multiChatIdleArchiveDays: companies.multiChatIdleArchiveDays,
            directChatMode: companies.directChatMode,
        }).from(companies).where(eq(companies.id, companyId)).limit(1);
        const settings = normalizeMultiChatSettings(settingsRow);
        if (!settings.enabled) throw new PrivateChatError("New chats are turned off for this company", 403, "multi_chat_disabled");
        if (settingsRow?.directChatMode !== "private") throw new PrivateChatError("New chats need private direct chats", 403, "multi_chat_disabled");

        // The cap counts the main chat: make sure it exists before counting.
        await getOrCreateMainChatLocked(tx, companyId, agentId, userId);
        const open = await openChatCount(tx, companyId, userId, agentId);
        if (chatLimitReached(open, settings.maxOpen)) {
            throw new PrivateChatError(`You have ${open} open chats with this agent; archive one to start another`, 409, "chat_limit_reached", { limit: settings.maxOpen, open });
        }

        const [thread] = await tx.insert(messageThreads).values({
            companyId,
            type: "direct",
            title: newChatTitle(input.firstMessage, input.attachments ?? []),
            createdByType: "human",
            createdById: userId,
            directAgentId: agentId,
            ownerUserId: userId,
            isPrivate: true,
            isMain: false,
        }).returning();
        // Only the owner, as for the main chat (control-plane ensurePrivateDirectThread).
        await tx.insert(threadParticipants).values([
            { threadId: thread.id, companyId, participantType: "agent", participantId: agentId, role: "member" },
            { threadId: thread.id, companyId, participantType: "human", participantRef: userId, role: "member", lastReadAt: sql`now()` },
        ]);
        const message = await insertPreparedThreadMessage(tx, prepared, thread.id);
        await tx.insert(idempotencyKeys).values({ companyId, endpoint: NEW_CHAT_ENDPOINT, requestHash, responseSnapshot: { threadId: thread.id, messageId: message.id } });
        return { thread, created: true, message };
    });

    if (result.created) await auditThread(companyId, userId, "thread.created", result.thread);
    return result;
}

export type PrivateChatSummary = {
    id: string;
    title: string | null;
    isMain: boolean;
    createdAt: string;
    lastMessageAt: string | null;
    unread: number;
    /** The agent is working in this chat (a running run, or a message it is handling: `acting`). */
    running: boolean;
    /** Messages waiting for the agent in this chat (`queued` or `seen`, shown as "Queued"). */
    queued: number;
    archivedAt: string | null;
    archiveReason: string | null;
};

/**
 * The person's chats with one agent (GET /api/chat/threads): open ones, or
 * archived ones with `archived`. Main first, then by last activity. Owner
 * only; an agent the person may not use answers 404/403.
 */
export async function listPrivateChats(viewer: AgentAccessViewer, agentId: string, options: { archived?: boolean } = {}): Promise<{
    chats: PrivateChatSummary[];
    open: number;
    settings: MultiChatSettings;
    directChatMode: "shared" | "private";
}> {
    await requireFullUse(viewer, agentId);
    const { companyId, userId } = viewer;
    const threads = await db.select().from(messageThreads).where(and(
        eq(messageThreads.companyId, companyId),
        eq(messageThreads.type, "direct"),
        eq(messageThreads.ownerUserId, userId),
        eq(messageThreads.directAgentId, agentId),
        options.archived ? isNotNull(messageThreads.archivedAt) : isNull(messageThreads.archivedAt),
    ));
    const ids = threads.map((t) => t.id);
    const [unread, lastRows, runningRows, waitingRows, open, settings, directChatMode] = await Promise.all([
        unreadCountsForUser(companyId, userId, ids),
        ids.length ? db.select({ threadId: threadMessages.threadId, at: max(threadMessages.createdAt) }).from(threadMessages)
            .where(and(eq(threadMessages.companyId, companyId), inArray(threadMessages.threadId, ids))).groupBy(threadMessages.threadId) : [],
        ids.length ? db.selectDistinct({ threadId: agentRuns.threadId }).from(agentRuns)
            .where(and(eq(agentRuns.companyId, companyId), inArray(agentRuns.threadId, ids), eq(agentRuns.status, "running")))
            .catch(() => [] as { threadId: string | null }[]) : [],
        ids.length ? db.select({ threadId: threadMessages.threadId, state: threadMessages.deliveryState, value: count() }).from(threadMessages)
            .where(and(
                eq(threadMessages.companyId, companyId), inArray(threadMessages.threadId, ids),
                ne(threadMessages.senderType, "agent"), inArray(threadMessages.deliveryState, ["queued", "seen", "acting"]),
            )).groupBy(threadMessages.threadId, threadMessages.deliveryState) : [],
        options.archived ? openChatCount(db, companyId, userId, agentId) : Promise.resolve(threads.length),
        getMultiChatSettings(companyId),
        getDirectChatMode(companyId),
    ]);
    const lastBy = new Map(lastRows.map((r) => [r.threadId, r.at]));
    const running = new Set(runningRows.map((r) => r.threadId));
    const queuedBy = new Map<string, number>();
    for (const row of waitingRows) {
        // Same mapping as the chat bubble: `acting` is being handled; `queued` and
        // `seen` (picked up, not started) both read "Queued".
        if (row.state === "acting") running.add(row.threadId);
        else queuedBy.set(row.threadId, (queuedBy.get(row.threadId) ?? 0) + Number(row.value));
    }
    const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
    const chats = threads.map((t): PrivateChatSummary => ({
        id: t.id,
        title: t.title,
        isMain: t.isMain,
        createdAt: t.createdAt.toISOString(),
        lastMessageAt: iso(lastBy.get(t.id)),
        unread: unread.get(t.id) ?? 0,
        running: running.has(t.id),
        queued: queuedBy.get(t.id) ?? 0,
        archivedAt: iso(t.archivedAt),
        archiveReason: t.archiveReason,
    }));
    const activity = (c: PrivateChatSummary) => Date.parse(c.lastMessageAt ?? c.createdAt);
    chats.sort((a, b) => Number(b.isMain) - Number(a.isMain) || activity(b) - activity(a));
    return { chats, open, settings, directChatMode };
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * An archived chat is read-only, so its open work goes with it: the queued,
 * seen and acting prompts in that chat are cancelled (the same cancel as a
 * Stop, lib/agent-control.ts). When the agent is working in it right now (a
 * running run, or a prompt it picked up) and the runtime can stop one chat
 * (`thread-kill-v1`), a thread-scoped kill follows; an older runtime only
 * knows the agent-wide kill, which would stop the person's other chats too,
 * so there the turn is left to finish and its reply is refused (409
 * chat_archived). Other chats are never touched.
 */
async function stopChatWork(tx: Tx, companyId: string, userId: string, agentId: string, threadId: string, threadKill: boolean) {
    const [busyRun] = await tx.select({ id: agentRuns.id }).from(agentRuns)
        .where(and(eq(agentRuns.companyId, companyId), eq(agentRuns.threadId, threadId), eq(agentRuns.status, "running"))).limit(1);
    const [pickedUp] = await tx.select({ id: threadMessages.id }).from(threadMessages).where(and(
        eq(threadMessages.companyId, companyId), eq(threadMessages.threadId, threadId),
        ne(threadMessages.senderType, "agent"), inArray(threadMessages.deliveryState, ["seen", "acting"]),
    )).limit(1);
    const changed: (typeof threadMessages.$inferSelect)[] = [...await cancelOpenAgentWork(tx, companyId, agentId, threadId)];
    if ((busyRun || pickedUp) && threadKill) {
        const [command] = await tx.insert(threadMessages).values({
            companyId, threadId, targetAgentId: agentId, senderType: "system", senderId: userId,
            text: "Stop requested for this chat; it was archived.",
            deliveryState: "queued",
            metadataJson: { runtimeControl: { action: "kill", scope: "thread" } },
        }).returning();
        changed.push(command);
    }
    return changed;
}

/**
 * PATCH /api/chat/threads/[id]: rename (`title`), archive (`archived: true`)
 * or restore (`archived: false`) one of the person's own chats.
 *
 * - The main chat keeps its fixed title and cannot be archived by its owner.
 * - An archived chat is read-only: it can be restored, not renamed.
 * - Restore: a former main chat whose agent has no live main comes back as
 *   the main chat; otherwise it comes back as an extra chat, which needs the
 *   setting on, private mode and room under the cap.
 */
export async function updatePrivateChat(companyId: string, userId: string, threadId: string, patch: { title?: string; archived?: boolean }): Promise<ThreadRow> {
    const owned = await findOwnedPrivateChat(companyId, userId, threadId);
    if (!owned || !owned.directAgentId) throw notFound();
    const viewer = await viewerForUser(companyId, userId);
    if (!viewer) throw notFound();
    await requireFullUse(viewer, owned.directAgentId);
    const agentId = owned.directAgentId;

    let audit: { action: "thread.archived" | "thread.restored"; reason?: ArchiveReason } | null = null;
    // Archiving stops the chat's work: what the runtime can stop in one chat only.
    const threadKill = patch.archived === true && !owned.archivedAt && !owned.isMain
        ? (await getAgentRuntimeTraits(companyId, agentId)).threadKill
        : false;
    const changedMessages: (typeof threadMessages.$inferSelect)[] = [];
    const updated = await db.transaction(async (tx) => {
        await lockPrivateChats(tx, companyId, agentId, userId);
        // FOR UPDATE: a message being stored in this chat holds a share lock on
        // the row (appendThreadMessage requireLiveThread), so an archive waits
        // for it and then cancels it, or the message sees the archive (409).
        const [thread] = await tx.select().from(messageThreads).where(eq(messageThreads.id, owned.id)).limit(1).for("update");
        if (!thread) throw notFound();

        if (patch.title !== undefined) {
            if (thread.archivedAt) throw new PrivateChatError("This chat is archived", 409, "chat_archived");
            if (thread.isMain) throw new PrivateChatError("The main chat keeps its title", 409, "main_chat_cannot_be_renamed");
            const [row] = await tx.update(messageThreads).set({ title: patch.title }).where(eq(messageThreads.id, thread.id)).returning();
            return row;
        }

        if (patch.archived === true) {
            if (thread.archivedAt) return thread;
            if (thread.isMain) throw new PrivateChatError("The main chat cannot be archived", 409, "main_chat_cannot_be_archived");
            // The agent's objective runs in this chat: archiving would strand it.
            const [objective] = await tx.select({ id: agentObjectives.id }).from(agentObjectives).where(and(
                eq(agentObjectives.companyId, companyId), eq(agentObjectives.threadId, thread.id), isNull(agentObjectives.deletedAt),
                inArray(agentObjectives.status, ["active", "blocked", "paused"]),
            )).limit(1);
            if (objective) throw new PrivateChatError("The agent's objective runs in this chat. Stop or complete it before archiving the chat.", 409, "objective_running");
            changedMessages.push(...await stopChatWork(tx, companyId, userId, agentId, thread.id, threadKill));
            const [row] = await tx.update(messageThreads).set({ archivedAt: new Date(), archiveReason: "manual" })
                .where(eq(messageThreads.id, thread.id)).returning();
            audit = { action: "thread.archived", reason: "manual" };
            return row;
        }

        if (patch.archived === false) {
            if (!thread.archivedAt) return thread;
            const [liveMain] = await tx.select({ id: messageThreads.id }).from(messageThreads).where(and(
                eq(messageThreads.companyId, companyId), eq(messageThreads.type, "direct"),
                eq(messageThreads.ownerUserId, userId), eq(messageThreads.directAgentId, agentId),
                eq(messageThreads.isMain, true), isNull(messageThreads.archivedAt),
            )).limit(1);
            const asMain = thread.isMain && !liveMain;
            if (!asMain) {
                const [settingsRow] = await tx.select({
                    multiChatEnabled: companies.multiChatEnabled,
                    multiChatMaxOpen: companies.multiChatMaxOpen,
                    multiChatIdleArchiveDays: companies.multiChatIdleArchiveDays,
                    directChatMode: companies.directChatMode,
                }).from(companies).where(eq(companies.id, companyId)).limit(1);
                const settings = normalizeMultiChatSettings(settingsRow);
                if (!settings.enabled || settingsRow?.directChatMode !== "private") {
                    throw new PrivateChatError("Restoring chats is turned off for this company", 403, "multi_chat_disabled");
                }
                const open = await openChatCount(tx, companyId, userId, agentId);
                if (chatLimitReached(open, settings.maxOpen)) {
                    throw new PrivateChatError(`You have ${open} open chats with this agent; archive one to restore another`, 409, "chat_limit_reached", { limit: settings.maxOpen, open });
                }
            }
            const [row] = await tx.update(messageThreads).set({ archivedAt: null, archiveReason: null, isMain: asMain, restoredAt: new Date() })
                .where(eq(messageThreads.id, thread.id)).returning();
            audit = { action: "thread.restored" };
            return row;
        }

        return thread;
    });

    for (const message of changedMessages) broadcastMcpEvent(companyId, { type: "thread_message", threadId: message.threadId, message });
    const done = audit as { action: "thread.archived" | "thread.restored"; reason?: ArchiveReason } | null;
    if (done) await auditThread(companyId, userId, done.action, updated, { reason: done.reason });
    return updated;
}
