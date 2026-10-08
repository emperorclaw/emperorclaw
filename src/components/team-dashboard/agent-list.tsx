"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { IconChevronRight, IconMessage, IconRefresh } from "@tabler/icons-react";
import { formatCents, timeAgo, type DashboardMember, type SceneAgent, type SceneStatus } from "@/lib/team-scene";
import { cn } from "@/lib/utils";
import { AgentAvatar, STATUS_COLOR } from "./agent-character";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

const URGENCY: Record<SceneStatus, number> = { blocked: 0, working: 1, waiting: 2, offline: 3, idle: 4 };

export function AgentList({ agents, selectedKey, isActive, onSelect, canAct, members }: {
    agents: SceneAgent[];
    selectedKey: string | null;
    isActive: (agent: SceneAgent) => boolean;
    onSelect: (key: string) => void;
    canAct: boolean;
    members: DashboardMember[];
}) {
    const router = useRouter();
    const [busyKey, setBusyKey] = useState<string | null>(null);
    const rows = agents.filter(isActive).sort((a, b) => URGENCY[a.status] - URGENCY[b.status] || a.member.name.localeCompare(b.member.name));
    if (rows.length === 0) {
        return <p className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">Nobody matches this view. Clear the filter or search to see everyone.</p>;
    }
    const pickable = members.filter((m) => m.kind === "agent");

    const reassign = async (agent: SceneAgent, target: { type: "agent"; id: string }) => {
        const task = agent.member.working[0] ?? agent.member.next[0];
        if (!task) return;
        setBusyKey(agent.member.key);
        try {
            const res = await fetch(`/api/tasks/${task.id}`, {
                method: "PATCH", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ assignee: target }),
            });
            if (!res.ok) throw new Error("Couldn't reassign the task");
            toast.success(`Reassigned to ${pickable.find((a) => a.id === target.id)?.name ?? "agent"}.`);
            router.refresh();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Something went wrong");
        } finally {
            setBusyKey(null);
        }
    };

    return (
        // Layout follows the panel's width (container queries), not the viewport:
        // the list lives beside the attention column, so even a wide screen gives
        // it only ~560px. Secondary columns drop out before anything overlaps.
        <div className="@container overflow-hidden rounded-xl border border-border/70">
            {/* Table (wide panels) */}
            <table className="hidden w-full table-fixed text-sm @min-[560px]:table">
                <thead className="bg-muted/40 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground dark:bg-white/[0.02]">
                    <tr>
                        <th scope="col" className="w-[30%] px-3 py-2">Member</th>
                        <th scope="col" className="w-[22%] px-3 py-2">Status</th>
                        <th scope="col" className="px-3 py-2">Current task</th>
                        <th scope="col" className="hidden w-[16%] px-3 py-2 @min-[820px]:table-cell">Waiting on</th>
                        <th scope="col" className="hidden w-[84px] px-3 py-2 @min-[700px]:table-cell">Last activity</th>
                        <th scope="col" className="hidden w-[76px] px-3 py-2 text-right @min-[760px]:table-cell">Spend today</th>
                        <th scope="col" className="w-[100px] px-2 py-2"><span className="sr-only">Actions</span></th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                    {rows.map((agent) => {
                        const m = agent.member;
                        const selected = m.key === selectedKey;
                        const currentTask = m.working[0]?.title ?? (agent.status === "working" ? agent.activity : null) ?? "—";
                        const waitingOn = m.waiting[0]?.title ?? (agent.status === "blocked" ? agent.activity : null) ?? "—";
                        const taskToReassign = m.working[0] ?? m.next[0];
                        return (
                            <tr key={m.key} onClick={() => onSelect(m.key)} aria-selected={selected}
                                className={cn("cursor-pointer transition-colors hover:bg-muted/50 dark:hover:bg-white/[0.03]", selected && "bg-cyan-500/[0.07]")}>
                                <td className="px-3 py-2.5">
                                    <button type="button" onClick={(e) => { e.stopPropagation(); onSelect(m.key); }} className="flex w-full min-w-0 items-center gap-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">
                                        <AgentAvatar id={m.id} kind={m.kind} name={m.name} avatarUrl={m.avatarUrl} avatarAppearance={m.avatarAppearance} status={agent.status} size={30} />
                                        <span className="min-w-0 flex-1">
                                            <span className="block truncate font-semibold text-foreground" title={m.name}>{m.name}</span>
                                            <span className="block truncate text-xs text-muted-foreground" title={m.role ?? ""}>{m.role || (m.kind === "human" ? "Teammate" : "Agent")}</span>
                                        </span>
                                    </button>
                                </td>
                                <td className="px-3 py-2.5">
                                    <span className="inline-flex max-w-full items-center gap-1.5 text-xs font-medium text-foreground/80" title={agent.behavior.caption}>
                                        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: STATUS_COLOR[agent.status] }} />
                                        <span className="truncate">{agent.behavior.caption}</span>
                                    </span>
                                </td>
                                <td className="truncate px-3 py-2.5 text-muted-foreground" title={currentTask}>{currentTask}</td>
                                <td className="hidden truncate px-3 py-2.5 text-muted-foreground @min-[820px]:table-cell" title={waitingOn}>{waitingOn}</td>
                                <td className="hidden px-3 py-2.5 text-xs tabular-nums text-muted-foreground @min-[700px]:table-cell">{m.lastActivityAt ? timeAgo(m.lastActivityAt, new Date()) : "—"}</td>
                                <td className="hidden px-3 py-2.5 text-right text-xs tabular-nums text-muted-foreground @min-[760px]:table-cell">{formatCents(m.spendTodayCents) ?? "—"}</td>
                                <td className="px-2 py-2.5">
                                    <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                                        {m.kind === "agent" && (
                                            <Link href={`/messages?agent=${m.id}`} aria-label={`Message ${m.name}`} className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
                                                <IconMessage className="h-4 w-4" />
                                            </Link>
                                        )}
                                        {canAct && m.kind === "agent" && taskToReassign && (
                                            <ReassignMenu agent={agent} pickable={pickable} busy={busyKey === m.key} onReassign={reassign} />
                                        )}
                                        <Link href={m.href} aria-label={`Open ${m.name}`} className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
                                            <IconChevronRight className="h-4 w-4" />
                                        </Link>
                                    </div>
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>

            {/* Stacked cards (narrow panels) */}
            <ul className="divide-y divide-border/60 @min-[560px]:hidden">
                {rows.map((agent) => {
                    const m = agent.member;
                    const selected = m.key === selectedKey;
                    const currentTask = m.working[0]?.title ?? (agent.status === "working" ? agent.activity : null) ?? "—";
                    const waitingOn = m.waiting[0]?.title ?? (agent.status === "blocked" ? agent.activity : null) ?? null;
                    return (
                        <li key={m.key} onClick={() => onSelect(m.key)} className={cn("cursor-pointer px-3 py-3 transition-colors hover:bg-muted/50", selected && "bg-cyan-500/[0.07]")}>
                            <div className="flex items-center gap-3">
                                <AgentAvatar id={m.id} kind={m.kind} name={m.name} avatarUrl={m.avatarUrl} avatarAppearance={m.avatarAppearance} status={agent.status} size={36} />
                                <div className="min-w-0 flex-1">
                                    <div className="truncate font-semibold text-foreground">{m.name}</div>
                                    <div className="truncate text-xs text-muted-foreground">{m.role || (m.kind === "human" ? "Teammate" : "Agent")}</div>
                                </div>
                                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground/80">
                                    <span className="h-2 w-2 rounded-full" style={{ background: STATUS_COLOR[agent.status] }} />{agent.behavior.caption}
                                </span>
                            </div>
                            <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                                <span className="min-w-0 truncate" title={currentTask}>{currentTask}</span>
                                <span className="shrink-0 tabular-nums">{formatCents(m.spendTodayCents) ?? "—"}</span>
                            </div>
                            {(waitingOn || m.lastActivityAt) && (
                                <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                                    <span className="min-w-0 truncate">{waitingOn ? `Waiting: ${waitingOn}` : ""}</span>
                                    <span className="shrink-0 tabular-nums">{m.lastActivityAt ? `seen ${timeAgo(m.lastActivityAt, new Date())}` : ""}</span>
                                </div>
                            )}
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}

function ReassignMenu({ agent, pickable, busy, onReassign }: {
    agent: SceneAgent;
    pickable: DashboardMember[];
    busy: boolean;
    onReassign: (a: SceneAgent, target: { type: "agent"; id: string }) => void;
}) {
    const targets = pickable.filter((a) => a.key !== agent.member.key);
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button type="button" disabled={busy} aria-label={`Reassign ${agent.member.name}`} className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50">
                    <IconRefresh className="h-4 w-4" />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-72 w-52 overflow-y-auto">
                {targets.length === 0 ? (
                    <span className="block px-2 py-1.5 text-xs text-muted-foreground">No other agents.</span>
                ) : targets.map((a) => (
                    <DropdownMenuItem key={a.key} onSelect={() => onReassign(agent, { type: "agent", id: a.id })}>
                        <span className="flex min-w-0 items-center gap-2">
                            <span className="truncate">{a.name}</span>
                            {a.role && <span className="truncate text-xs text-muted-foreground">{a.role}</span>}
                        </span>
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
