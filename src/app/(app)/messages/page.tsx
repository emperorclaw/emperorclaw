import { redirect } from "next/navigation";
import { getCompanyId, getUserId } from "@/lib/auth";
import { db } from "@/db";
import { agents, messageThreads, threadMessages, threadParticipants } from "@/db/schema";
import { and, count, eq, gt, inArray, isNull } from "drizzle-orm";
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
    const participantMap = new Map<string, typeof directParticipants>();
    for (const participant of directParticipants) {
        if (!directThreadIdSet.has(participant.threadId)) continue;
        const existing = participantMap.get(participant.threadId) || [];
        existing.push(participant);
        participantMap.set(participant.threadId, existing);
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

        const [latestMessage] = await getThreadMessages(companyId, thread.id, 1);
        const unreadConditions = [
            eq(threadMessages.companyId, companyId),
            eq(threadMessages.threadId, thread.id),
            eq(threadMessages.senderType, "agent"),
        ];
        if (humanParticipant?.lastReadAt) {
            unreadConditions.push(gt(threadMessages.createdAt, humanParticipant.lastReadAt));
        }
        const [unreadRow] = await db.select({ value: count() }).from(threadMessages).where(and(...unreadConditions));
        const unreadCount = unreadRow?.value || 0;

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
    const teamMessageWindow = await getThreadMessages(companyId, teamThread.id, 26);
    const initialTeamHasMore = teamMessageWindow.length > 25;
    const teamMessages = initialTeamHasMore ? teamMessageWindow.slice(1) : teamMessageWindow;

    return (
        <div className="mx-auto flex h-[calc(100dvh-2rem)] max-w-[1800px] flex-col gap-3 animate-in fade-in slide-in-from-bottom-2 duration-500 sm:h-[calc(100dvh-2.5rem)]">
            <div className="hidden shrink-0 items-end justify-between gap-6 sm:flex">
                <div className="min-w-0">
                    <p className="text-[10px] font-bold uppercase tracking-[0.24em] text-cyan-300">Messages</p>
                    <h1 className="mt-0.5 text-2xl font-semibold tracking-tight text-zinc-100">Team & Direct Messages</h1>
                </div>
                <p className="max-w-xl pb-0.5 text-right text-xs leading-5 text-zinc-500">
                    Coordinate with the team or open a private agent thread.
                </p>
            </div>
            <div className="flex min-h-0 flex-1 overflow-hidden rounded-2xl emperor-panel sm:rounded-[2rem]">
                <MessagingHub
                    agents={allAgents}
                    directThreads={directThreadSummaries}
                    initialTeamMessages={teamMessages}
                    initialTeamHasMore={initialTeamHasMore}
                    teamThreadId={teamThread.id}
                />
            </div>
        </div>
    );
}
