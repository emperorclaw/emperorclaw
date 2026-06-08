import Link from "next/link";
import { redirect } from "next/navigation";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { ArrowLeft, Bot, Cable, Clock3, KeyRound, MemoryStick, ScrollText, type LucideIcon } from "lucide-react";
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
import { getCompanyId } from "@/lib/auth";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { listAgentIntegrationsForAgent } from "@/lib/agent-integrations";
import { isMissingSchemaError } from "@/lib/schema-compat";
import { ManageIntegrationsDialog } from "../manage-integrations-dialog";
import { AgentDirectChat } from "@/components/agent-direct-chat";

export const dynamic = "force-dynamic";

type MemorySnapshot = typeof agentMemorySnapshots.$inferSelect;
type MemoryEntry = typeof agentMemoryEntries.$inferSelect;
type AgentSession = typeof agentSessions.$inferSelect;
type ActionRun = typeof actionRuns.$inferSelect;
type ThreadParticipant = typeof threadParticipants.$inferSelect;
type MessageThread = typeof messageThreads.$inferSelect;
type ThreadMessage = typeof threadMessages.$inferSelect;

export default async function AgentDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const companyId = await getCompanyId();
    if (!companyId) redirect("/login");

    const { id } = await params;
    const [agent] = await db.select().from(agents).where(
        and(eq(agents.id, id), eq(agents.companyId, companyId), isNull(agents.deletedAt))
    ).limit(1);

    if (!agent) {
        redirect("/agents");
    }

    let latestSnapshot: MemorySnapshot | null = null;
    let memoryEntries: MemoryEntry[] = [];
    let sessions: AgentSession[] = [];
    let runs: ActionRun[] = [];
    let participants: ThreadParticipant[] = [];
    let threads: MessageThread[] = [];
    let lastMessages: ThreadMessage[] = [];

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

        participants = await db.select().from(threadParticipants).where(
            and(eq(threadParticipants.companyId, companyId), eq(threadParticipants.participantType, "agent"), eq(threadParticipants.participantId, id))
        );

        const threadIds = participants.map(participant => participant.threadId);
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

    const integrations = await listAgentIntegrationsForAgent(companyId, id);

    const latestMessageByThread = lastMessages.reduce((acc, message) => {
        if (!acc[message.threadId]) acc[message.threadId] = message;
        return acc;
    }, {} as Record<string, ThreadMessage>);

    return (
        <div className="max-w-6xl mx-auto space-y-8 animate-in fade-in duration-500">
            <div className="flex items-start justify-between gap-6">
                <div className="space-y-3">
                    <Link href="/agents" className="inline-flex items-center text-sm text-zinc-500 hover:text-zinc-300 transition-colors">
                        <ArrowLeft className="w-4 h-4 mr-2" />
                        Back to Agent Fleet
                    </Link>
                    <div className="flex items-center gap-4">
                        <div className="w-16 h-16 rounded-2xl bg-zinc-900 border border-zinc-800 overflow-hidden">
                            <img
                                src={agent.avatarUrl || `https://api.dicebear.com/9.x/pixel-art/svg?seed=${encodeURIComponent(agent.id)}`}
                                className="w-full h-full object-cover"
                                alt=""
                            />
                        </div>
                        <div>
                            <div className="flex items-center gap-3">
                                <h1 className="text-3xl font-semibold tracking-tight text-zinc-100">{agent.name}</h1>
                                <span className="px-2 py-0.5 rounded text-[10px] uppercase tracking-wider font-semibold bg-zinc-800 text-zinc-400">
                                    {agent.role || "operator"}
                                </span>
                            </div>
                            <p className="text-sm text-zinc-500 font-medium">
                                Durable session, memory, message, and machine-local runtime state for this Hermes/OpenClaw agent.
                            </p>
                        </div>
                    </div>
                </div>

                <div className="grid grid-cols-2 gap-3 min-w-[280px]">
                    <MetricCard icon={Clock3} label="Last Session" value={sessions[0] ? sessions[0].status : "none"} />
                    <MetricCard icon={Cable} label="Threads" value={threads.length.toString()} />
                    <MetricCard icon={MemoryStick} label="Memory Entries" value={memoryEntries.length.toString()} />
                    <MetricCard icon={KeyRound} label="Integrations" value={integrations.length.toString()} />
                </div>
            </div>

            <Tabs defaultValue="memory" className="space-y-6">
                <TabsList className="bg-zinc-900 border border-zinc-800">
                    <TabsTrigger value="memory">Memory</TabsTrigger>
                    <TabsTrigger value="chat">Direct Chat</TabsTrigger>
                    <TabsTrigger value="threads">Threads</TabsTrigger>
                    <TabsTrigger value="runs">Runs</TabsTrigger>
                    <TabsTrigger value="integrations">Runtime Integrations</TabsTrigger>
                </TabsList>

                <TabsContent value="memory">
                    <div className="grid grid-cols-1 lg:grid-cols-[1.2fr_0.8fr] gap-6">
                        <section className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
                            <div className="flex items-center gap-2 mb-4">
                                <MemoryStick className="w-5 h-5 text-indigo-400" />
                                <h2 className="text-lg font-medium text-zinc-200">Latest Snapshot</h2>
                            </div>
                            <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-4 font-mono text-sm text-zinc-300 whitespace-pre-wrap min-h-[220px]">
                                {latestSnapshot?.content || agent.memory || "No snapshot recorded yet."}
                            </div>
                        </section>

                        <section className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
                            <div className="flex items-center gap-2 mb-4">
                                <ScrollText className="w-5 h-5 text-indigo-400" />
                                <h2 className="text-lg font-medium text-zinc-200">Memory Timeline</h2>
                            </div>
                            <div className="space-y-3 max-h-[520px] overflow-y-auto pr-2">
                                {memoryEntries.length === 0 ? (
                                    <EmptyState text="No append-only memory entries recorded yet." />
                                ) : memoryEntries.map(entry => (
                                    <div key={entry.id} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-4">
                                        <div className="flex items-center justify-between gap-3 mb-2">
                                            <span className="text-[10px] uppercase tracking-wider font-bold text-indigo-400">{entry.kind}</span>
                                            <span className="text-[11px] text-zinc-600">{new Date(entry.createdAt).toLocaleString()}</span>
                                        </div>
                                        {entry.summary && <div className="text-sm text-zinc-200 mb-2">{entry.summary}</div>}
                                        <div className="text-xs text-zinc-400 whitespace-pre-wrap">{entry.content}</div>
                                    </div>
                                ))}
                            </div>
                        </section>
                    </div>
                </TabsContent>

                <TabsContent value="chat">
                    <AgentDirectChat agentId={id} agentName={agent.name} />
                </TabsContent>

                <TabsContent value="threads">
                    <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
                        <div className="flex items-center gap-2 mb-4">
                            <Cable className="w-5 h-5 text-indigo-400" />
                            <h2 className="text-lg font-medium text-zinc-200">Message Threads</h2>
                        </div>
                        <div className="space-y-3">
                            {threads.length === 0 ? (
                                <EmptyState text="No direct or task threads recorded for this agent yet." />
                            ) : threads.map(thread => {
                                const lastMessage = latestMessageByThread[thread.id];
                                return (
                                    <div key={thread.id} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-4">
                                        <div className="flex items-center justify-between gap-3 mb-2">
                                            <div className="flex items-center gap-2">
                                                <span className="text-[10px] uppercase tracking-wider font-bold text-indigo-400">{thread.type}</span>
                                                <span className="text-sm text-zinc-200">{thread.title || "Untitled thread"}</span>
                                            </div>
                                            <span className="text-[11px] text-zinc-600">{new Date(thread.createdAt).toLocaleString()}</span>
                                        </div>
                                        <div className="text-xs text-zinc-500">
                                            {lastMessage ? lastMessage.text : "No messages yet."}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </TabsContent>

                <TabsContent value="runs">
                    <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
                        <div className="flex items-center gap-2 mb-4">
                            <Bot className="w-5 h-5 text-indigo-400" />
                            <h2 className="text-lg font-medium text-zinc-200">Execution Runs</h2>
                        </div>
                        <div className="space-y-3">
                            {runs.length === 0 && sessions.length === 0 ? (
                                <EmptyState text="No execution runs or sessions have been recorded yet." />
                            ) : (
                                <>
                                    {sessions.map(session => (
                                        <div key={session.id} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-4">
                                            <div className="flex items-center justify-between gap-3 mb-2">
                                                <span className="text-[10px] uppercase tracking-wider font-bold text-emerald-400">session</span>
                                                <span className="text-[11px] text-zinc-600">{new Date(session.startedAt).toLocaleString()}</span>
                                            </div>
                                            <div className="text-sm text-zinc-200">{session.status}</div>
                                            <div className="text-xs text-zinc-500 mt-1 font-mono">{session.openclawSessionId}</div>
                                            {session.summary && <div className="text-xs text-zinc-400 mt-2">{session.summary}</div>}
                                        </div>
                                    ))}
                                    {runs.map(run => (
                                        <div key={run.id} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-4">
                                            <div className="flex items-center justify-between gap-3 mb-2">
                                                <span className="text-[10px] uppercase tracking-wider font-bold text-indigo-400">{run.kind}</span>
                                                <span className="text-[11px] text-zinc-600">{new Date(run.startedAt).toLocaleString()}</span>
                                            </div>
                                            <div className="text-sm text-zinc-200">{run.status}</div>
                                            {run.summary && <div className="text-xs text-zinc-400 mt-2">{run.summary}</div>}
                                        </div>
                                    ))}
                                </>
                            )}
                        </div>
                    </div>
                </TabsContent>

                <TabsContent value="integrations">
                    <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
                        <div className="flex items-start justify-between gap-4 mb-4">
                            <div>
                                <div className="flex items-center gap-2">
                                    <KeyRound className="w-5 h-5 text-indigo-400" />
                                    <h2 className="text-lg font-medium text-zinc-200">Runtime Integrations</h2>
                                </div>
                                <p className="text-xs text-zinc-500 mt-1">
                                    Keep only machine-local or truly agent-bound payloads here. Customer and project mailboxes, identities, and templates should live in Knowledge & Rules.
                                </p>
                            </div>
                            <div className="w-full max-w-[220px]">
                                <ManageIntegrationsDialog agentId={id} />
                            </div>
                        </div>
                        <div className="space-y-3">
                            {integrations.length === 0 ? (
                                <EmptyState text="No runtime integrations configured for this agent." />
                            ) : integrations.map(integration => (
                                <div key={integration.id} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-4">
                                    <div className="flex items-center justify-between gap-3 mb-2">
                                        <div className="flex items-center gap-2">
                                            <span className="text-sm text-zinc-200">{integration.name}</span>
                                            <span className="text-[10px] uppercase tracking-wider font-bold text-indigo-400">{integration.provider}</span>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded border border-zinc-700 text-zinc-400">
                                                {integration.ownership}
                                            </span>
                                            <span className="text-[11px] text-zinc-600">
                                                {integration.lastUsedAt ? `Used ${new Date(integration.lastUsedAt).toLocaleString()}` : "Never used"}
                                            </span>
                                        </div>
                                    </div>
                                    <div className="text-xs text-zinc-400">
                                        {integration.lastFailureReason ? `Last failure: ${integration.lastFailureReason}` : "No recent failures recorded."}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </TabsContent>
            </Tabs>
        </div>
    );
}

function MetricCard({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
    return (
        <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-4">
            <div className="flex items-center gap-2 text-zinc-500 text-xs uppercase tracking-wider font-bold mb-2">
                <Icon className="w-4 h-4 text-indigo-400" />
                <span>{label}</span>
            </div>
            <div className="text-lg font-semibold text-zinc-100">{value}</div>
        </div>
    );
}

function EmptyState({ text }: { text: string }) {
    return <div className="rounded-lg border border-dashed border-zinc-800 bg-zinc-950/40 p-6 text-sm text-zinc-500 text-center">{text}</div>;
}
