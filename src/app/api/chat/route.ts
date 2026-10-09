import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { artifacts, threadMessages, threadParticipants } from "@/db/schema";
import { getCompanyId, getUserId } from "@/lib/auth";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { appendThreadMessage, ensureDirectThread, ensureTeamThread, getThreadMessages, type ThreadMessageAttachment } from "@/lib/control-plane";
import { resolveAgentId } from "@/lib/mcp";
import { broadcastMcpEvent } from "@/lib/pubsub";

import { parseObjectiveCommand, replyObjectiveStatus, requestAgentObjective } from "@/lib/agent-objective";
import { requireRole, AuthError } from "@/lib/roles";
import { parseAgentControlCommand, validateAgentControl } from "@/lib/agent-control-command";
import { requestAgentControl } from "@/lib/agent-control";
import { getGroupThread, GroupError, joinGroupAsHuman, isAgentPairThread, isCompanyOwnerOrAdmin } from "@/lib/groups";

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

function normalizedPrompt(text: string) {
    return text.trim().replace(/\s+/g, " ");
}

export async function GET(req: NextRequest) {
    const companyId = await getCompanyId();
    if (!companyId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const { searchParams } = new URL(req.url);
        const since = searchParams.get("since");
        const before = searchParams.get("before");
        const limit = Math.min(parseInt(searchParams.get("limit") || "25", 10), 200);
        const targetAgentId = searchParams.get("targetAgentId");
        const groupId = searchParams.get("threadId");
        const sinceDate = since ? new Date(since) : null;
        const beforeDate = before ? new Date(before) : null;

        // `threadId` selects a group; without it this is the team channel or,
        // with targetAgentId, an agent's direct thread — exactly as before.
        const thread = groupId
            ? await getGroupThread(companyId, groupId)
            : targetAgentId
                ? await ensureDirectThread(companyId, targetAgentId, await getUserId())
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

        return NextResponse.json({ thread, messages: pagedMessages.map(serializeMessage), participants, hasMore });
    } catch (error: unknown) {
        if (error instanceof AuthError) return NextResponse.json({error:error.message},{status:error.statusCode});
        if (error instanceof GroupError) return NextResponse.json({ error: error.message }, { status: error.status });
        const isAgentNotFound = error instanceof Error && error.message.startsWith("Agent not found");
        const status = isAgentNotFound ? 404 : error instanceof Error && error.message.startsWith("Runtime controls") ? 400 : 500;
        console.error("[/api/chat] GET error:", error);
        return NextResponse.json({ error: isAgentNotFound ? "Agent not found" : error instanceof Error && error.message.startsWith("Runtime controls") ? error.message : "Internal Server Error" }, { status });
    }
}

export async function POST(req: NextRequest) {
    const companyId = await getCompanyId();
    const userId = await getUserId();
    if (!companyId || !userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const { text, targetAgentId, attachments, threadId: groupId } = await req.json();
        if (text !== undefined && typeof text !== "string") return NextResponse.json({ error: "Text must be a string" }, { status: 400 });
        if (groupId !== undefined && typeof groupId !== "string") return NextResponse.json({ error: "threadId must be a string" }, { status: 400 });
        const goalCommand = typeof text === "string" ? parseObjectiveCommand(text) : null;
        if (goalCommand) {
            await requireRole("member")();
            if (Array.isArray(attachments) && attachments.length) return NextResponse.json({error:"Send attachments as a normal message before setting an objective"},{status:400});
            if (goalCommand.action === "unsupported") return NextResponse.json({error:"Supported commands: /goal <objective>, status, pause, resume, stop. Describe the outcome and how to verify it in the objective."},{status:400});
            if (!targetAgentId || groupId) return NextResponse.json({error:"Use /goal in an agent's direct chat"},{status:400});
            const id = await resolveAgentId(companyId,targetAgentId);
            try { return NextResponse.json(goalCommand.action === "status" ? await replyObjectiveStatus(companyId,userId,id) : await requestAgentObjective(companyId,userId,id,goalCommand as { action: "start" | "pause" | "resume" | "stop" | "update" | "block" | "complete"; objective?: string })); }
            catch(e) { return NextResponse.json({error:e instanceof Error?e.message:"Objective request failed"},{status:400}); }
        }
        const command = typeof text === "string" ? parseAgentControlCommand(text) : null;
        if (command) {
            await requireRole("member")();
            if (!targetAgentId || groupId) return NextResponse.json({ error: "Use runtime commands in an agent’s direct chat" }, { status: 400 });
            const error = validateAgentControl(command.action, command.prompt);
            if (error) return NextResponse.json({ error }, { status: 400 });
            if (Array.isArray(attachments) && attachments.length) return NextResponse.json({ error: "Send attachments as a normal message" }, { status: 400 });
            const agentId = await resolveAgentId(companyId, targetAgentId);
            return NextResponse.json(await requestAgentControl(companyId, userId, agentId, command.action, command.prompt));
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

        // A group message has no single target: agents in the group answer
        // when @mentioned, like the team channel.
        const resolvedTargetAgentId = targetAgentId && !groupId
            ? await resolveAgentId(companyId, targetAgentId)
            : null;
        const thread = groupId
            ? await getGroupThread(companyId, groupId)
            : resolvedTargetAgentId
                ? await ensureDirectThread(companyId, resolvedTargetAgentId, userId)
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
        });

        broadcastMcpEvent(companyId, {
            type: "thread_message",
            thread,
            message,
        });

        return NextResponse.json({ thread, message: serializeMessage(message) });
    } catch (error: unknown) {
        if (error instanceof AuthError) return NextResponse.json({error:error.message},{status:error.statusCode});
        if (error instanceof GroupError) return NextResponse.json({ error: error.message }, { status: error.status });
        const isAgentNotFound = error instanceof Error && error.message.startsWith("Agent not found");
        const status = isAgentNotFound ? 404 : error instanceof Error && error.message.startsWith("Runtime controls") ? 400 : 500;
        console.error("[/api/chat] POST error:", error);
        return NextResponse.json({ error: isAgentNotFound ? "Agent not found" : error instanceof Error && error.message.startsWith("Runtime controls") ? error.message : "Internal Server Error" }, { status });
    }
}
