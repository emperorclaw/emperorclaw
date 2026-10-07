import Link from "next/link";
import { IconChevronRight } from "@tabler/icons-react";
import { STATUS_LABEL, ZONES, type SceneAgent } from "@/lib/team-scene";
import { cn } from "@/lib/utils";
import { AgentAvatar, STATUS_COLOR } from "./agent-character";

export function AgentList({ agents, selectedKey, isActive, onSelect }: { agents: SceneAgent[]; selectedKey: string | null; isActive: (agent: SceneAgent) => boolean; onSelect: (key: string) => void }) {
    const rows = agents.filter(isActive);
    if (rows.length === 0) {
        return <p className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">Nobody matches this view. Clear the filter or search to see everyone.</p>;
    }
    return (
        <div className="overflow-hidden rounded-xl border border-border/70">
            <table className="w-full table-fixed text-sm">
                <thead className="bg-muted/40 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground dark:bg-white/[0.02]">
                    <tr>
                        <th scope="col" className="w-[38%] px-3 py-2 sm:w-[28%]">Member</th>
                        <th scope="col" className="hidden w-[16%] px-3 py-2 sm:table-cell">Status</th>
                        <th scope="col" className="px-3 py-2">Doing now</th>
                        <th scope="col" className="hidden w-[14%] px-3 py-2 lg:table-cell">Area</th>
                        <th scope="col" className="hidden w-[13%] px-3 py-2 text-right md:table-cell">Open · done</th>
                        <th scope="col" className="w-10 px-2 py-2"><span className="sr-only">Open</span></th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                    {rows.map((agent) => {
                        const m = agent.member;
                        const selected = m.key === selectedKey;
                        return (
                            <tr key={m.key} onClick={() => onSelect(m.key)} aria-selected={selected}
                                className={cn("cursor-pointer transition-colors hover:bg-muted/50 dark:hover:bg-white/[0.03]", selected && "bg-cyan-500/[0.07]")}>
                                <td className="px-3 py-2.5">
                                    <button type="button" onClick={(e) => { e.stopPropagation(); onSelect(m.key); }} className="flex min-w-0 items-center gap-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">
                                        <AgentAvatar id={m.id} kind={m.kind} name={m.name} avatarUrl={m.avatarUrl} status={agent.status} size={30} />
                                        <span className="min-w-0">
                                            <span className="block truncate font-semibold text-foreground">{m.name}</span>
                                            <span className="block truncate text-xs text-muted-foreground">{m.role || (m.kind === "human" ? "Teammate" : "Agent")}</span>
                                        </span>
                                    </button>
                                </td>
                                <td className="hidden px-3 py-2.5 sm:table-cell">
                                    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground/80">
                                        <span className="h-2 w-2 rounded-full" style={{ background: STATUS_COLOR[agent.status] }} />{STATUS_LABEL[agent.status]}
                                    </span>
                                </td>
                                <td className="truncate px-3 py-2.5 text-muted-foreground">{agent.activity}</td>
                                <td className="hidden truncate px-3 py-2.5 text-muted-foreground lg:table-cell">{ZONES[agent.zone].label}</td>
                                <td className="hidden px-3 py-2.5 text-right tabular-nums text-muted-foreground md:table-cell">{m.working.length + m.waiting.length + m.next.length} · {m.doneToday}</td>
                                <td className="px-2 py-2.5">
                                    <Link href={m.href} onClick={(e) => e.stopPropagation()} aria-label={`Open ${m.name}`} className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
                                        <IconChevronRight className="h-4 w-4" />
                                    </Link>
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}
