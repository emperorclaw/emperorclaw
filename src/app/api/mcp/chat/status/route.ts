import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, resolveAgentId } from "@/lib/mcp";
import { broadcastMcpEvent } from "@/lib/pubsub";
import { normalizeExecutionState } from "@/lib/project-workflow";
import { updateAgentThreadParticipant, updateThreadExecutionState } from "@/lib/control-plane";

export async function POST(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;

    try {
        const body = await req.json();
        const { threadId, typing, markRead, agentId, executionState, activity, messageId } = body;

        if (!threadId) return NextResponse.json({ error: "threadId is required" }, { status: 400 });
        if (!agentId) return NextResponse.json({ error: "agentId is required for status updates" }, { status: 400 });

        const resolvedAgentId = await resolveAgentId(companyId, agentId);

        const updates: { lastReadAt?: Date; typingUntil?: Date | null; currentActivity?: string | null } = {};
        if (markRead) updates.lastReadAt = new Date();
        if (typeof typing === 'boolean') {
            updates.typingUntil = typing ? new Date(Date.now() + 5000) : null;
            // Clear stale activity text the instant typing stops, so a leftover
            // "working (42s)" never lingers after the turn actually ends.
            updates.currentActivity = typing && typeof activity === "string" && activity.trim()
                ? activity.trim().slice(0, 200)
                : null;
        }

        if (Object.keys(updates).length > 0) {
            await updateAgentThreadParticipant(companyId, threadId, resolvedAgentId, updates);

            // Broadcast for UI reactivity
            broadcastMcpEvent(companyId, {
                type: "participant_status",
                threadId,
                participantId: resolvedAgentId,
                typing: !!typing,
                lastReadAt: updates.lastReadAt,
                currentActivity: updates.currentActivity,
            });
        }

        const derivedState = normalizeExecutionState(executionState)
            || (typeof typing === "boolean" && typing ? "acting" : null)
            || (markRead ? "seen" : null);

        if (derivedState) {
            const updatedMessages = await updateThreadExecutionState({
                companyId,
                threadId,
                actorType: "agent",
                actorId: resolvedAgentId,
                targetState: derivedState,
                // Scope "resolved" to the specific message that got a reply —
                // batching it thread-wide would mark still-queued messages
                // done before the agent has actually processed them.
                messageId: derivedState === "resolved" && typeof messageId === "string" ? messageId : null,
            });

            for (const updatedMessage of updatedMessages) {
                broadcastMcpEvent(companyId, {
                    type: "thread_message",
                    threadId,
                    message: updatedMessage,
                });
            }
        }

        return NextResponse.json({ ok: true });
    } catch (e: unknown) {
        const message = e instanceof Error ? e.message : "Internal Server Error";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
