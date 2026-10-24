import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { verifyMcpToken, resolveAgentId } from "@/lib/mcp";
import { db } from "@/db";
import { messageThreads } from "@/db/schema";
import { appendThreadMessage, currentAgentStreak, getThreadMessages } from "@/lib/control-plane";
import { broadcastMcpEvent } from "@/lib/pubsub";
import { GROUP_THREAD_TYPE, isAgentGroupMember, isAgentPairThread, pairThreadCounterpart } from "@/lib/groups";
import { agentLoopHardCap, agentPairLoopHardCap, stripReservedMetadata, unreachableMentionsOf } from "@/lib/message-routing";
import { applyStoredObjectiveStatus } from "@/lib/objective-status";
import { agentTokenMayUseThread, isPrivateDirectThread } from "@/lib/direct-chat-mode";
import { mcpAccessForAgent, mcpMayReachAgent, mcpMayUseThread } from "@/lib/mcp-access";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { id: threadId } = await params;
    const { searchParams } = new URL(req.url);
    const limit = Math.min(parseInt(searchParams.get("limit") || "100", 10), 500);
    const sinceParam = searchParams.get("since");
    const beforeParam = searchParams.get("before");
    const since = sinceParam ? new Date(sinceParam) : null;
    const before = beforeParam ? new Date(beforeParam) : null;

    const [thread] = await db.select().from(messageThreads).where(
        and(eq(messageThreads.id, threadId), eq(messageThreads.companyId, companyId))
    ).limit(1);

    // A person's private direct thread: only a token bound to its agent. A
    // project/task thread: only when that project is in the bound agent's scope.
    if (!thread || !agentTokenMayUseThread(thread, auth.companyToken!.agentId)
        || !(await mcpMayUseThread(companyId, await mcpAccessForAgent(companyId, auth.companyToken!.agentId), thread))) {
        return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    }

    // Groups (and agent pair threads) are members-only: a bound agent token may
    // read messages only of the groups it participates in, never snoop another's.
    if (thread.type === GROUP_THREAD_TYPE) {
        const boundAgentId = auth.companyToken!.agentId || null;
        if (boundAgentId && !(await isAgentGroupMember(companyId, thread.id, boundAgentId))) {
            return NextResponse.json({ error: "Access denied: this agent is not a member of that group" }, { status: 403 });
        }
    }

    const messages = await getThreadMessages(
        companyId,
        threadId,
        limit + 1,
        since && !isNaN(since.getTime()) ? since : null,
        before && !isNaN(before.getTime()) ? before : null
    );
    const hasMore = !since && messages.length > limit;
    return NextResponse.json({ thread, messages: hasMore ? messages.slice(1) : messages, hasMore });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { id: threadId } = await params;

    try {
        const [thread] = await db.select().from(messageThreads).where(
            and(eq(messageThreads.id, threadId), eq(messageThreads.companyId, companyId))
        ).limit(1);

        if (!thread || !agentTokenMayUseThread(thread, auth.companyToken!.agentId)
            || !(await mcpMayUseThread(companyId, await mcpAccessForAgent(companyId, auth.companyToken!.agentId), thread))) {
            return NextResponse.json({ error: "Thread not found" }, { status: 404 });
        }

        const body = await req.json();
        const { text, senderType = "agent", senderId, targetAgentId, metadataJson, mirrorToLegacyChat = false } = body;

        if (!text) {
            return NextResponse.json({ error: "text is required" }, { status: 400 });
        }

        // MCP callers authenticate with a company token, not a user session, so
        // they must never post as a human or system sender — otherwise an agent
        // could forge a human message (and the human audit trail that follows it)
        // or stamp server-only flags like a task wake onto its own message.
        if (senderType === "human" || senderType === "system") {
            return NextResponse.json({ error: "MCP callers cannot post as a human or system sender" }, { status: 403 });
        }

        // A bound token always posts as its own agent: naming another agent
        // as the sender would let one agent speak for (and wake work as) another.
        const boundAgentId = auth.companyToken!.agentId || null;
        const resolvedSenderId = senderType === "agent" && senderId
            ? await resolveAgentId(companyId, senderId)
            : senderId || (senderType === "agent" ? boundAgentId : null);
        if (boundAgentId && senderType === "agent" && resolvedSenderId !== boundAgentId) {
            return NextResponse.json({ error: "Access denied: this token is bound to a different agent" }, { status: 403 });
        }
        if (isPrivateDirectThread(thread) && resolvedSenderId && resolvedSenderId !== thread.directAgentId) {
            return NextResponse.json({ error: "Access denied: this token is bound to a different agent" }, { status: 403 });
        }
        const isGroup = thread.type === GROUP_THREAD_TYPE;
        const isAgentPair = isGroup && isAgentPairThread(thread);
        // Groups are members-only: whoever posts (the token's bound agent, or
        // the named sender) must belong to it, and nothing is single-targeted.
        if (isGroup) {
            if (thread.archivedAt) return NextResponse.json({ error: "Access denied: that group is archived" }, { status: 403 });
            const poster = auth.companyToken!.agentId || (senderType === "agent" ? resolvedSenderId : null);
            if (!poster || !(await isAgentGroupMember(companyId, thread.id, poster))) {
                return NextResponse.json({ error: "Access denied: only group members can post in a group" }, { status: 403 });
            }
            if (resolvedSenderId && resolvedSenderId !== poster) {
                return NextResponse.json({ error: "Access denied: this token is bound to a different agent" }, { status: 403 });
            }
        }
        if (senderType === "agent" && thread.type !== "direct" && (await currentAgentStreak(companyId, thread.id)) >= (isAgentPair ? agentPairLoopHardCap() : agentLoopHardCap())) {
            return NextResponse.json({ error: "Loop guard: too many agent messages in a row in this thread; retry after five minutes of inactivity or ask a person to write" }, { status: 429 });
        }
        const resolvedTargetAgentId = targetAgentId && !isGroup
            ? await resolveAgentId(companyId, targetAgentId)
            : null;
        // A pair-thread reply carries no targetAgentId, but old runtimes only
        // understand `targeted`: infer the counterpart so they still route it.
        const effectiveTargetAgentId = isAgentPair && !resolvedTargetAgentId && resolvedSenderId
            ? await pairThreadCounterpart(companyId, thread.id, resolvedSenderId)
            : resolvedTargetAgentId;
        // The sender's "Agents it can work with" list (one-way): no message or
        // pair handoff to an agent outside it.
        if (senderType === "agent" && resolvedSenderId && effectiveTargetAgentId && effectiveTargetAgentId !== resolvedSenderId) {
            const senderAccess = await mcpAccessForAgent(companyId, resolvedSenderId);
            if (!mcpMayReachAgent(senderAccess, effectiveTargetAgentId)) {
                return NextResponse.json({ error: "You can't reach that agent: it is outside your scope" }, { status: 403 });
            }
        }
        const shouldMirrorToLegacyChat = !isGroup && (mirrorToLegacyChat || thread.type === "team");

        const message = await appendThreadMessage({
            companyId,
            threadId,
            senderType,
            senderId: resolvedSenderId,
            targetAgentId: effectiveTargetAgentId,
            text,
            metadataJson: stripReservedMetadata(metadataJson),
            mirrorToLegacyChat: shouldMirrorToLegacyChat,
        });

        // The marker was already sanitized inside appendThreadMessage, so the
        // stored/streamed text never shows it. Apply the authorized action after
        // persistence (outside any lock the append held).
        if (senderType === "agent" && resolvedSenderId) {
            await applyStoredObjectiveStatus(companyId, message.id)
                .catch((error) => console.error("Objective status marker failed:", error));
        }

        await broadcastMcpEvent(companyId, { type: "thread_message", thread, message });

        const unreachable = unreachableMentionsOf(message.metadataJson);
        return NextResponse.json(unreachable.size > 0
            ? { message, notice: "Posted, but some mentioned agents are outside your scope; the mention did not notify them.", unreachableAgentIds: [...unreachable] }
            : { message }, { status: 201 });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Internal Server Error";
        const status = message.startsWith("Agent not found") ? 404 : 500;
        return NextResponse.json({ error: message }, { status });
    }
}
