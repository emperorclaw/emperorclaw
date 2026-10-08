"use client";

import { useState } from "react";
import { IconRadar } from "@tabler/icons-react";
import { requiresHumanAction, STATUS_LABEL, timeAgo, type SceneAgent } from "@/lib/team-scene";
import { cn } from "@/lib/utils";
import { AgentAvatar, STATUS_COLOR } from "./agent-character";

/** Avatar-first counterpart to the desk display's pulse, with no invented progress. */
export function TeamPulse({ agents, selectedKey, onSelect, now }: {
    agents: SceneAgent[];
    selectedKey: string | null;
    onSelect: (key: string) => void;
    now: Date;
}) {
    const [page, setPage] = useState(0);
    const pageCount = Math.max(1, Math.ceil(agents.length / 24));
    const currentPage = Math.min(page, pageCount - 1);
    const visible = agents.slice(currentPage * 24, (currentPage + 1) * 24);
    return (
        <div>
            <div className="mb-4 flex items-start gap-2 rounded-xl border border-border bg-muted/25 p-3 text-sm text-muted-foreground">
                <IconRadar className="mt-0.5 h-5 w-5 shrink-0" stroke={1.6} />
                <p>One identity across your workspace and desk display. Work state stays separate from connection and pending actions.</p>
            </div>
            {agents.length === 0 ? <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No agents match. Clear your filters to see the team.</p> : (
                <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 2xl:grid-cols-4">
                    {visible.map((agent) => {
                        const member = agent.member;
                        const actions = agent.notices?.filter(requiresHumanAction).length ?? 0;
                        const connected = Boolean(member.activity) || member.runtimeOnline === true;
                        return (
                            <li key={member.key} className="min-w-0">
                                <button type="button" aria-pressed={selectedKey === member.key} onClick={() => onSelect(member.key)}
                                    aria-label={`${member.name}: ${agent.behavior.caption}${actions ? `, ${actions} pending actions` : ""}`}
                                    className={cn("relative flex h-full min-h-44 w-full flex-col items-center rounded-xl border border-border bg-muted/20 px-3 py-4 text-center transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400", selectedKey === member.key && "border-cyan-500/60 bg-cyan-500/[0.06] ring-1 ring-cyan-500/30")}>
                                    {actions > 0 && <span className="absolute right-2 top-2 rounded-md bg-amber-500/15 px-1.5 py-0.5 text-xs font-semibold text-amber-700 dark:text-amber-300">{actions} action{actions === 1 ? "" : "s"}</span>}
                                    <span className="mb-2 rounded-[38%] border-2 p-1.5" style={{ borderColor: STATUS_COLOR[agent.status] }}>
                                        <AgentAvatar id={member.id} kind={member.kind} name={member.name} avatarUrl={member.avatarUrl} avatarAppearance={member.avatarAppearance} size={48} />
                                    </span>
                                    <span className="w-full truncate text-sm font-semibold text-foreground" title={member.name}>{member.name}</span>
                                    <span className="mt-1 line-clamp-2 text-xs text-foreground/80">{agent.behavior.caption}</span>
                                    <span className="mt-2 text-xs text-muted-foreground">{connected ? "Connected" : member.lastActivityAt ? `Last seen ${timeAgo(member.lastActivityAt, now)}` : "Connection unconfirmed"}</span>
                                </button>
                            </li>
                        );
                    })}
                </ul>
            )}
            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-3 text-xs text-muted-foreground" aria-label="Work state legend">
                {(["working", "waiting", "idle", "offline"] as const).map((status) => <span key={status} className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: STATUS_COLOR[status] }} />{STATUS_LABEL[status]}</span>)}
                <span>Amber badges = pending actions</span>
            </div>
            {pageCount > 1 && <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>{currentPage * 24 + 1}–{Math.min((currentPage + 1) * 24, agents.length)} of {agents.length} agents</span>
                <div className="flex gap-2"><button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} className="min-h-11 rounded-lg border border-border px-3 disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-cyan-400">Previous</button><button type="button" disabled={currentPage >= pageCount - 1} onClick={() => setPage(currentPage + 1)} className="min-h-11 rounded-lg border border-border px-3 disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-cyan-400">Next</button></div>
            </div>}
        </div>
    );
}
