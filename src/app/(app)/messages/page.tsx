import { redirect } from "next/navigation";
import { getCompanyId, getUserId } from "@/lib/auth";
import { db } from "@/db";
import { agents, messageThreads, threadMessages, threadParticipants } from "@/db/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { MessagingHub } from "@/components/messaging-hub";
import { ensureTeamThread, getThreadMessages } from "@/lib/control-plane";

export const dynamic = "force-dynamic";

type DirectThreadSummary = {
    agentId: string;
    threadId: string | null;
    agentName: string;
    agentRole: string | null;
    avatarUrl: string | null;
    status: string;
    unreadCount: number;
    lastMessageText: string | null;
    lastMessageAt: string | null;
};

export default async function MessagesPage() {
    const companyId = await getCompanyId();
    const userId = await getUserId();
    if (!companyId) redirect("/login");
    if (!userId) redirect("/login");

    const allAgents = await db.select().from(agents).where(
        and(eq(agents.companyId, companyId), isNull(agents.deletedAt))
    );

    const directThreads = await db.select().from(messageThreads).where(
        and(
            eq(messageThreads.companyId, companyId),
            eq(messageThreads.type, "direct"),
            isNull(messageThreads.archivedAt)
        )
    );

    const directThreadIds = directThreads.map((thread) => thread.id);
    const directThreadIdSet = new Set(directThreadIds);
    const directParticipants = directThreadIds.length > 0
        ? await db.select().from(threadParticipants).where(
            and(
                eq(threadParticipants.companyId, companyId),
                inArray(threadParticipants.threadId, directThreadIds)
            )
        )
        : [];
    const directMessages = directThreadIds.length > 0
        ? await db.select().from(threadMessages).where(
            and(
                eq(threadMessages.companyId, companyId),
                inArray(threadMessages.threadId, directThreadIds)
            )
        )
        : [];

    const participantMap = new Map<string, typeof directParticipants>();
    for (const participant of directParticipants) {
        if (!directThreadIdSet.has(participant.threadId)) continue;
        const existing = participantMap.get(participant.threadId) || [];
        existing.push(participant);
        participantMap.set(participant.threadId, existing);
    }

    const messageMap = new Map<string, typeof directMessages>();
    for (const message of directMessages) {
        if (!directThreadIdSet.has(message.threadId)) continue;
        const existing = messageMap.get(message.threadId) || [];
        existing.push(message);
        messageMap.set(message.threadId, existing);
    }

    const directThreadByAgentId = new Map<string, DirectThreadSummary>();
    const userThreads = directThreads.filter((thread) => {
        const participants = participantMap.get(thread.id) || [];
        return participants.some((participant) =>
            participant.participantType === "human" && participant.participantRef === userId
        );
    });

    for (const thread of userThreads) {
        const participants = participantMap.get(thread.id) || [];
        const agentParticipant = participants.find((participant) =>
            participant.participantType === "agent" && participant.participantId
        );
        const humanParticipant = participants.find((participant) =>
            participant.participantType === "human" && participant.participantRef === userId
        );

        if (!agentParticipant?.participantId) continue;

        const agent = allAgents.find((row) => row.id === agentParticipant.participantId);
        if (!agent) continue;

        const messages = (messageMap.get(thread.id) || [])
            .slice()
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        const latestMessage = messages[0] || null;
        const lastReadAt = humanParticipant?.lastReadAt ? new Date(humanParticipant.lastReadAt).getTime() : null;
        const unreadCount = messages.filter((message) => {
            if (message.senderType !== "agent") return false;
            if (!lastReadAt) return true;
            return new Date(message.createdAt).getTime() > lastReadAt;
        }).length;

        const current = directThreadByAgentId.get(agent.id);
        const latestTime = latestMessage ? new Date(latestMessage.createdAt).getTime() : 0;
        const currentTime = current?.lastMessageAt ? new Date(current.lastMessageAt).getTime() : 0;

        if (!current || latestTime >= currentTime) {
            directThreadByAgentId.set(agent.id, {
                agentId: agent.id,
                threadId: thread.id,
                agentName: agent.name,
                agentRole: agent.role,
                avatarUrl: agent.avatarUrl,
                status: agent.status,
                unreadCount,
                lastMessageText: latestMessage?.text || null,
                lastMessageAt: latestMessage ? new Date(latestMessage.createdAt).toISOString() : null,
            });
        }
    }

    const directThreadSummaries: DirectThreadSummary[] = allAgents
        .map((agent) => directThreadByAgentId.get(agent.id) || {
            agentId: agent.id,
            threadId: null,
            agentName: agent.name,
            agentRole: agent.role,
            avatarUrl: agent.avatarUrl,
            status: agent.status,
            unreadCount: 0,
            lastMessageText: null,
            lastMessageAt: null,
        })
        .sort((a, b) => a.agentName.localeCompare(b.agentName));

    const teamThread = await ensureTeamThread(companyId);
    const teamMessages = await getThreadMessages(companyId, teamThread.id, 100);

    return (
        <div className="h-[calc(100vh-8rem)] flex flex-col bg-zinc-950 border border-zinc-800 rounded-2xl overflow-hidden shadow-2xl animate-in fade-in slide-in-from-bottom-2 duration-500">
            <MessagingHub agents={allAgents} directThreads={directThreadSummaries} initialTeamMessages={teamMessages} />
        </div>
    );
}
