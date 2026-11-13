import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { artifacts, threadMessages, threadParticipants } from "@/db/schema";
import { getUserId } from "@/lib/auth";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { appendThreadMessage, ensureDirectThread, ensureTeamThread, getDirectThreadForUser, getThreadMessages, type ThreadMessageAttachment } from "@/lib/control-plane";
import { resolveAgentId } from "@/lib/mcp";
import { broadcastMcpEvent } from "@/lib/pubsub";

import { parseObjectiveCommand, replyObjectiveStatus, requestAgentObjective } from "@/lib/agent-objective";
import { AuthError } from "@/lib/roles";
import { parseAgentControlCommand, validateAgentControl } from "@/lib/agent-control-command";
import { DirectThreadNotAllowedError, canStopAgentEverywhere, chatRuntimeInfo, requestAgentControl } from "@/lib/agent-control";
import { getGroupThread, GroupError, joinGroupAsHuman, isAgentPairThread, isCompanyOwnerOrAdmin } from "@/lib/groups";
import { parseEventsSince } from "@/lib/run-events";
import { loadChatRunState } from "@/lib/run-ledger-reads";
import { companyRouteAccess } from "@/lib/company-access";
import { agentUseFor, mentionedAgentsNotUsable, type AgentAccessViewer } from "@/lib/agent-access-server";
import { requireGroupInScope } from "@/lib/group-route";
import { createPrivateChat, findOwnedPrivateChat, PrivateChatError } from "@/lib/private-chats";
import { ChatArchivedError, isValidClientKey, NEW_CHAT_RATE_LIMIT } from "@/lib/multi-chat";

type ThreadMessageLike = {
    fromUserId?: string | null;
    senderId?: string | null;
    [key: string]: unknown;
};

function serializeMessage(message: ThreadMessageLike) {
    return {
        ...message,
        fromUserId: message.fromUserId || message.senderId || null,
    };
}

/** 404 for an agent outside the person's scope, 403 for one an admin sees only as metadata. */
async function agentUseDenied(viewer: AgentAccessViewer, agentId: string): Promise<NextResponse | null> {
    const use = await agentUseFor(viewer, agentId);
    if (use === "full") return null;
    return use === "metadata"
        ? NextResponse.json({ error: "This agent is limited to other people" }, { status: 403 })
        : NextResponse.json({ error: "Agent not found" }, { status: 404 });
}

function normalizedPrompt(text: string) {
    return text.trim().replace(/\s+/g, " ");
}

/**
 * An agent's direct thread for this person: their own (private mode) or the
 * shared one, or — with `directThreadId` — a specific direct thread of that
 * agent they take part in, such as its Operations thread in private mode.
 */
async function directThreadFor(companyId: string, agentId: string, userId: string | null, directThreadId: unknown, options: { read?: boolean } = {}) {
    if (typeof directThreadId !== "string" || !directThreadId) return ensureDirectThread(companyId, agentId, userId);
    const thread = userId ? await getDirectThreadForUser(companyId, agentId, directThreadId, userId) : null;
    if (thread) return thread;
    // One of the person's own archived chats: readable, never writable.
    const archived = userId ? await findOwnedPrivateChat(companyId, userId, directThreadId, agentId) : null;
    if (archived?.archivedAt) {
        if (options.read) return archived;
        throw new ChatArchivedError();
    }
    throw new GroupError("Conversation not found", 404);
}

/**
 * `newChat: { clientKey }`: start an extra private chat with the agent with
 * its first message, atomically (lib/private-chats.ts). A retry with the same
 * key returns the chat and its first message instead of posting twice; only a
 * real creation counts against the new-chat rate limit.
 */
async function startNewChat(companyId: string, userId: string, agentId: string, newChat: unknown, text: string, attachments: ThreadMessageAttachment[]) {
    const clientKey = newChat && typeof newChat === "object" ? (newChat as { clientKey?: unknown }).clientKey : undefined;
    if (!isValidClientKey(clientKey)) return NextResponse.json({ error: "newChat.clientKey must be 8-128 letters, digits or _.:-" }, { status: 400 });
    const { thread, created, message } = await createPrivateChat({
        companyId, userId, agentId, firstMessage: text, attachments, clientKey,
        rateLimit: { key: `chat:new:${companyId}:${userId}`, ...NEW_CHAT_RATE_LIMIT },
    });
    if (!created) return NextResponse.json({ thread, message: serializeMessage(message), deduplicated: true, created: false });
    broadcastMcpEvent(companyId, { type: "thread_message", thread, message });
    return NextResponse.json({ thread, message: serializeMessage(message), created });
}

function chatErrorResponse(error: unknown): NextResponse | null {
    if (error instanceof PrivateChatError) {
        const retryAfterMs = error.code === "rate_limited" ? Number(error.extra.retryAfterMs) : NaN;
        const { retryAfterMs: _omit, ...body } = error.body() as Record<string, unknown>;
        void _omit;
        return NextResponse.json(body, {
            status: error.status,
            ...(Number.isFinite(retryAfterMs) ? { headers: { "Retry-After": Math.ceil(retryAfterMs / 1000).toString() } } : {}),
        });
    }
    if (error instanceof ChatArchivedError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    return null;
}

export async function GET(req: NextRequest) {
    const access = await companyRouteAccess("viewer");
    if (access.response) return access.response;
    const companyId = access.ctx.companyId;

    try {
        const { searchParams } = new URL(req.url);
        const since = searchParams.get("since");
        const before = searchParams.get("before");
        const limit = Math.min(parseInt(searchParams.get("limit") || "25", 10), 200);
        const targetAgentId = searchParams.get("targetAgentId");
        const groupId = searchParams.get("threadId");
        const directThreadId = searchParams.get("directThreadId");
        const sinceDate = since ? new Date(since) : null;
        const beforeDate = before ? new Date(before) : null;
        // A restricted member only reads chats with agents in their scope, and
        // nobody reads the chats of an agent limited to other people (0.20).
        if (targetAgentId) {
            const denied = await agentUseDenied(access.ctx, await resolveAgentId(companyId, targetAgentId));
            if (denied) return denied;
        }
        if (groupId && access.ctx.scope) await requireGroupInScope(companyId, groupId, access.ctx.userId, access.ctx.scope);

        // `threadId` selects a group; without it this is the team channel or,
        // with targetAgentId, an agent's direct thread — exactly as before.
        const thread = groupId
            ? await getGroupThread(companyId, groupId)
            : targetAgentId
                ? await directThreadFor(companyId, directThreadId ? await resolveAgentId(companyId, targetAgentId) : targetAgentId, await getUserId(), directThreadId, { read: true })
                : await ensureTeamThread(companyId);

        // An agent pair thread is a private handoff: only owners/admins may read
        // it from the human UI, and then read-only.
        if (groupId && isAgentPairThread(thread)) {
            const viewerId = await getUserId();
            if (!viewerId || !(await isCompanyOwnerOrAdmin(companyId, viewerId))) {
                return NextResponse.json({ error: "Access denied" }, { status: 403 });
            }
        }

        const messages = await getThreadMessages(
            companyId,
            thread.id,
            limit + 1,
            sinceDate && !isNaN(sinceDate.getTime()) ? sinceDate : null,
            beforeDate && !isNaN(beforeDate.getTime()) ? beforeDate : null
        );
        const hasMore = !sinceDate && messages.length > limit;
        const pagedMessages = hasMore ? messages.slice(1) : messages;

        const participants = await db.select().from(threadParticipants).where(
            and(eq(threadParticipants.companyId, companyId), eq(threadParticipants.threadId, thread.id))
        );

        // 0.9 live runs (§4.7): the caller already passed the thread's access
        // check above, so its runs and steps are visible to them as-is.
        const { liveRuns, replyRuns } = await loadChatRunState(companyId, thread.id, {
            since: parseEventsSince(searchParams.get("eventsSince")),
            replyMessageIds: pagedMessages
                .filter((message) => (message as { senderType?: string }).senderType === "agent")
                .map((message) => String((message as { id?: unknown }).id ?? "")),
        });

        // Direct chats: what Stop will do here (`thread`, or `agent` when the runtime can only stop
        // all of the agent's chats) and how many chats the runtime answers at once (null: unknown).
        // `canStopAll`: whether this person may stop the agent in every chat (scope "agent").
        const runtime = !groupId && targetAgentId && thread.directAgentId
            ? {
                ...await chatRuntimeInfo(companyId, thread.directAgentId, thread),
                canStopAll: await canStopAgentEverywhere(access.ctx, thread.directAgentId),
            }
            : undefined;

        return NextResponse.json({ thread, messages: pagedMessages.map(serializeMessage), participants, hasMore, liveRuns, replyRuns, ...(runtime ? { runtime } : {}) });
    } catch (error: unknown) {
        if (error instanceof AuthError) return NextResponse.json({error:error.message},{status:error.statusCode});
        const chatError = chatErrorResponse(error);
        if (chatError) return chatError;
        if (error instanceof GroupError) return NextResponse.json({ error: error.message }, { status: error.status });
        const isAgentNotFound = error instanceof Error && error.message.startsWith("Agent not found");
        const status = isAgentNotFound ? 404 : error instanceof Error && error.message.startsWith("Runtime controls") ? 400 : 500;
        console.error("[/api/chat] GET error:", error);
        return NextResponse.json({ error: isAgentNotFound ? "Agent not found" : error instanceof Error && error.message.startsWith("Runtime controls") ? error.message : "Internal Server Error" }, { status });
    }
}

export async function POST(req: NextRequest) {
    const access = await companyRouteAccess("member");
    if (access.response) return access.response;
    const companyId = access.ctx.companyId;
    const userId = access.ctx.userId;

    try {
        const { text, targetAgentId, attachments, threadId: groupId, directThreadId, newChat } = await req.json();
        if (text !== undefined && typeof text !== "string") return NextResponse.json({ error: "Text must be a string" }, { status: 400 });
        if (groupId !== undefined && typeof groupId !== "string") return NextResponse.json({ error: "threadId must be a string" }, { status: 400 });
        if (newChat !== undefined && (typeof targetAgentId !== "string" || !targetAgentId || groupId || directThreadId)) {
            return NextResponse.json({ error: "newChat needs targetAgentId, without threadId or directThreadId" }, { status: 400 });
        }
        // A restricted member only talks to (and controls) agents in their
        // scope; an agent limited to other people is theirs alone (0.20).
        if (typeof targetAgentId === "string" && targetAgentId) {
            const denied = await agentUseDenied(access.ctx, await resolveAgentId(companyId, targetAgentId));
            if (denied) return denied;
        }
        // Nor can a mention wake an agent they may not use.
        const unusable = typeof text === "string" ? await mentionedAgentsNotUsable(access.ctx, text) : [];
        if (unusable.length > 0) {
            return NextResponse.json({ error: `You can't mention ${unusable.map((a) => a.name).join(", ")}: that agent is limited to other people` }, { status: 403 });
        }
        if (typeof groupId === "string" && groupId && access.ctx.scope) {
            try {
                await requireGroupInScope(companyId, groupId, userId, access.ctx.scope);
            } catch (error) {
                if (error instanceof GroupError) return NextResponse.json({ error: error.message }, { status: error.status });
                throw error;
            }
        }
        const goalCommand = typeof text === "string" ? parseObjectiveCommand(text) : null;
        if (newChat !== undefined && (goalCommand || (typeof text === "string" && parseAgentControlCommand(text)))) {
            return NextResponse.json({ error: "Start a new chat with a message, then use commands in it" }, { status: 400 });
        }
        if (goalCommand) {
            if (Array.isArray(attachments) && attachments.length) return NextResponse.json({error:"Send attachments as a normal message before setting an objective"},{status:400});
            if (goalCommand.action === "unsupported") return NextResponse.json({error:"Supported commands: /goal <objective>, status, pause, resume, stop. Describe the outcome and how to verify it in the objective."},{status:400});
            if (!targetAgentId || groupId) return NextResponse.json({error:"Use /goal in an agent's direct chat"},{status:400});
            const id = await resolveAgentId(companyId,targetAgentId);
            // The objective runs in the chat it was started from (D12): one of the
            // person's own private chats. Other direct threads (Operations) and no
            // thread id keep the main chat.
            const current = typeof directThreadId === "string" && directThreadId ? await directThreadFor(companyId, id, userId, directThreadId) : null;
            const goalThread = current && current.ownerUserId === userId ? current : null;
            try { return NextResponse.json(goalCommand.action === "status" ? await replyObjectiveStatus(companyId,userId,id,{ thread: goalThread }) : await requestAgentObjective(companyId,userId,id,goalCommand as { action: "start" | "pause" | "resume" | "stop" | "update" | "block" | "complete"; objective?: string },{ thread: goalThread })); }
            catch(e) { return NextResponse.json({error:e instanceof Error?e.message:"Objective request failed"},{status:400}); }
        }
        const command = typeof text === "string" ? parseAgentControlCommand(text) : null;
        if (command) {
            if (!targetAgentId || groupId) return NextResponse.json({ error: "Use runtime commands in an agent’s direct chat" }, { status: 400 });
            const error = validateAgentControl(command.action, command.prompt);
            if (error) return NextResponse.json({ error }, { status: 400 });
            if (Array.isArray(attachments) && attachments.length) return NextResponse.json({ error: "Send attachments as a normal message" }, { status: 400 });
            const agentId = await resolveAgentId(companyId, targetAgentId);
            try {
                return NextResponse.json(await requestAgentControl(companyId, userId, agentId, command.action, command.prompt,
                    typeof directThreadId === "string" && directThreadId ? directThreadId : null));
            } catch (e) {
                if (e instanceof DirectThreadNotAllowedError) return NextResponse.json({ error: e.message }, { status: 404 });
                throw e;
            }
        }

        // Resolve attachment artifact ids to compact company-scoped refs.
        // Unknown/deleted ids are silently dropped — only real company
        // artifacts travel with the message.
        let resolvedAttachments: ThreadMessageAttachment[] = [];
        const attachmentIds = Array.isArray(attachments)
            ? attachments.filter((a: unknown): a is string => typeof a === "string")
            : [];
        if (attachmentIds.length > 0) {
            const rows = await db.select({
                id: artifacts.id,
                title: artifacts.title,
                originalFilename: artifacts.originalFilename,
                contentType: artifacts.contentType,
                sizeBytes: artifacts.sizeBytes,
            }).from(artifacts).where(and(
                eq(artifacts.companyId, companyId),
                inArray(artifacts.id, attachmentIds),
                isNull(artifacts.deletedAt),
            ));
            resolvedAttachments = rows.map((row) => ({
                id: row.id as string,
                name: row.originalFilename || row.title || "file",
                contentType: row.contentType,
                sizeBytes: row.sizeBytes,
            }));
        }

        if (!text && resolvedAttachments.length === 0) {
            return NextResponse.json({ error: "Text or attachment is required" }, { status: 400 });
        }

        if (newChat !== undefined) {
            return await startNewChat(companyId, userId, await resolveAgentId(companyId, targetAgentId), newChat, text || "", resolvedAttachments);
        }

        // A group message has no single target: agents in the group answer
        // when @mentioned, like the team channel.
        const resolvedTargetAgentId = targetAgentId && !groupId
            ? await resolveAgentId(companyId, targetAgentId)
            : null;
        const thread = groupId
            ? await getGroupThread(companyId, groupId)
            : resolvedTargetAgentId
                ? await directThreadFor(companyId, resolvedTargetAgentId, userId, directThreadId)
                : await ensureTeamThread(companyId);
        // Pair threads are read-only from the human side: nobody posts into a
        // private agent handoff.
        if (groupId && isAgentPairThread(thread)) {
            return NextResponse.json({ error: "Read-only: you cannot post to an agent pair thread" }, { status: 403 });
        }
        // Posting in a group makes you a member of it.
        if (groupId) await joinGroupAsHuman(companyId, thread.id, userId);

        // A double-click, a network retry, or two browser tabs must not turn one
        // request into two expensive agent turns.  Attachments are intentionally
        // excluded: two files with the same caption can be distinct requests.
        if (resolvedTargetAgentId && resolvedAttachments.length === 0 && text) {
            const prompt = normalizedPrompt(text);
            const outstanding = await db.select().from(threadMessages).where(and(
                eq(threadMessages.companyId, companyId),
                eq(threadMessages.threadId, thread.id),
                eq(threadMessages.senderType, "human"),
                eq(threadMessages.senderId, userId),
                inArray(threadMessages.deliveryState, ["queued", "seen", "acting"]),
                ne(threadMessages.text, ""),
            )).orderBy(threadMessages.createdAt).limit(100);
            const duplicate = outstanding.find((message) => normalizedPrompt(message.text) === prompt);
            if (duplicate) {
                return NextResponse.json({ thread, message: serializeMessage(duplicate), deduplicated: true });
            }
        }
        const message = await appendThreadMessage({
            companyId,
            threadId: thread.id,
            senderType: "human",
            senderId: userId,
            targetAgentId: resolvedTargetAgentId,
            text: text || "",
            attachments: resolvedAttachments,
            mirrorToLegacyChat: !resolvedTargetAgentId && !groupId,
            // A person's private chat may be archived between the lookup above
            // and this insert: re-checked under a lock on the thread row (409).
            requireLiveThread: Boolean(resolvedTargetAgentId) && thread.isPrivate,
        });

        broadcastMcpEvent(companyId, {
            type: "thread_message",
            thread,
            message,
        });

        return NextResponse.json({ thread, message: serializeMessage(message) });
    } catch (error: unknown) {
        if (error instanceof AuthError) return NextResponse.json({error:error.message},{status:error.statusCode});
        const chatError = chatErrorResponse(error);
        if (chatError) return chatError;
        if (error instanceof GroupError) return NextResponse.json({ error: error.message }, { status: error.status });
        const isAgentNotFound = error instanceof Error && error.message.startsWith("Agent not found");
        const status = isAgentNotFound ? 404 : error instanceof Error && error.message.startsWith("Runtime controls") ? 400 : 500;
        console.error("[/api/chat] POST error:", error);
        return NextResponse.json({ error: isAgentNotFound ? "Agent not found" : error instanceof Error && error.message.startsWith("Runtime controls") ? error.message : "Internal Server Error" }, { status });
    }
}
