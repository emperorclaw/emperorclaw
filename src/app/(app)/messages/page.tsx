import { redirect } from "next/navigation";
import { getCompanyId, getUserId } from "@/lib/auth";
import { db } from "@/db";
import { companyMembers, users } from "@/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import { MessagingHub } from "@/components/messaging-hub";
import { ensureTeamThread, getThreadMessages } from "@/lib/control-plane";
import { loadMemberScope } from "@/lib/member-scope";
import { requireRole } from "@/lib/roles";
import { loadMessagesListing, unreadCountsForUser } from "@/lib/messages-listing";

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
    /** Secondary threads only: "operations" (the agent's shared thread in private mode) or "private" (your own, kept from private mode). */
    kind?: "operations" | "private";
};

export default async function MessagesPage() {
    const companyId = await getCompanyId();
    const userId = await getUserId();
    if (!companyId) redirect("/login");
    if (!userId) redirect("/login");

    // Created (and every member joined to it) before the listing reads it.
    const teamThread = await ensureTeamThread(companyId);
    // A restricted member only sees (and chats with) the agents in their scope.
    const memberScope = await loadMemberScope(userId, companyId);
    const guard = await requireRole("viewer")().catch(() => null);
    // The same selection the nav badge counts (lib/messages-listing.ts).
    const listing = await loadMessagesListing({ companyId, userId, role: guard?.role ?? null, scope: memberScope });
    const allAgents = listing.agents;
    // Work logs too: they are not listed, but open from the agent's panel.
    const extraChats = listing.extraChats ?? [];
    const unreadBy = await unreadCountsForUser(companyId, userId, [...listing.direct.map((d) => d.thread.id), teamThread.id, ...extraChats.map((d) => d.thread.id)]);
    // One sidebar row per agent: its unread is the sum over all of the person's open chats with it.
    const extraUnreadByAgent = new Map<string, number>();
    for (const { agent, thread } of extraChats) {
        extraUnreadByAgent.set(agent.id, (extraUnreadByAgent.get(agent.id) ?? 0) + (unreadBy.get(thread.id) ?? 0));
    }

    const directThreadByAgentId = new Map<string, DirectThreadSummary>();
    // Besides the one conversation per agent in the main list: in private mode
    // the agent's Operations thread; in shared mode your earlier private ones.
    const secondaryThreads: DirectThreadSummary[] = [];
    for (const { agent, thread, kind, latest } of listing.direct) {
        const summary: DirectThreadSummary = {
            agentId: agent.id,
            threadId: thread.id,
            agentName: agent.name,
            agentRole: agent.role,
            avatarUrl: agent.avatarUrl,
            status: agent.status,
            unreadCount: (unreadBy.get(thread.id) ?? 0) + (kind === "primary" ? extraUnreadByAgent.get(agent.id) ?? 0 : 0),
            lastMessageText: latest?.text || null,
            lastMessageAt: latest ? latest.createdAt.toISOString() : null,
        };
        if (kind === "primary") directThreadByAgentId.set(agent.id, summary);
        else secondaryThreads.push({ ...summary, kind });
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

    const teamMessageWindow = await getThreadMessages(companyId, teamThread.id, 26);
    const initialTeamHasMore = teamMessageWindow.length > 25;
    const teamMessages = initialTeamHasMore ? teamMessageWindow.slice(1) : teamMessageWindow;
    const teamUnreadCount = unreadBy.get(teamThread.id) ?? 0;

    const groups = listing.groups;
    const humans = (await db.select({ id: users.id, displayName: users.displayName, email: users.email })
        .from(companyMembers)
        .innerJoin(users, eq(users.id, companyMembers.userId))
        .where(and(eq(companyMembers.companyId, companyId), isNull(users.deletedAt))))
        .map((u) => ({ id: u.id, name: u.displayName || u.email }));

    const t = await getTranslations("messages");
    return (
        <div className="mx-auto flex h-[calc(100dvh-8.25rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] max-w-[1800px] flex-col gap-3 md:h-[calc(100dvh-2.5rem)]">
            <div className="hidden shrink-0 items-end justify-between gap-6 sm:flex">
                <div className="min-w-0">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{t("eyebrow")}</p>
                    <h1 className="mt-0.5 text-2xl font-semibold tracking-tight text-zinc-100">{t("title")}</h1>
                </div>
                <p className="max-w-xl pb-0.5 text-right text-xs leading-5 text-zinc-500">
                    {t("description")}
                </p>
            </div>
            {/* Below md the thread runs edge to edge: no card inside the page padding. */}
            <div className="emperor-panel flex min-h-0 flex-1 overflow-hidden rounded-2xl max-md:-mx-3 max-md:-mt-4 max-md:rounded-none max-md:border-x-0 max-md:border-t-0 max-md:shadow-none">
                <MessagingHub
                    agents={allAgents}
                    directThreads={directThreadSummaries}
                    secondaryDirectThreads={secondaryThreads.sort((a, b) => a.agentName.localeCompare(b.agentName))}
                    initialTeamMessages={teamMessages}
                    initialTeamHasMore={initialTeamHasMore}
                    teamThreadId={teamThread.id}
                    teamUnreadCount={teamUnreadCount}
                    groups={groups.map((g) => ({
                        id: g.id,
                        title: g.title,
                        description: g.description,
                        icon: g.icon,
                        isAgentPair: g.isAgentPair,
                        members: g.members.map((m) => ({ kind: m.kind, id: m.id, name: m.name, role: m.role, avatarUrl: m.avatarUrl ?? null })),
                        unreadCount: g.unreadCount,
                        lastMessageText: g.lastMessageText,
                        lastMessageAt: g.lastMessageAt,
                    }))}
                    humans={humans}
                    currentUserId={userId}
                    extraChatAgents={Object.fromEntries(extraChats.map(({ agent, thread }) => [thread.id, agent.id]))}
                />
            </div>
        </div>
    );
}
