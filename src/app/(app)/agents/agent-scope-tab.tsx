"use client";

import { useEffect, useMemo, useState } from "react";
import { IconShieldLock, IconDeviceFloppy, IconUsers, IconSearch, IconEye, IconMessage, IconArrowForwardUp } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { useViewerPermissions } from "@/lib/use-viewer-permissions";
import { cn } from "@/lib/utils";

type AgentScope = {
    mode?: "all" | "restricted";
    customerIds?: string[];
    projectIds?: string[];
    /** Agents it can work with; absent = all agents. */
    agentIds?: string[];
};

type Props = {
    agentId: string;
    agentName?: string;
    initialScope: AgentScope | undefined;
};

type RosterAgent = { id: string; name: string; status?: string | null };

function toggleId(id: string, ids: string[], setIds: (ids: string[]) => void) {
    setIds(ids.includes(id) ? ids.filter((existing) => existing !== id) : [...ids, id]);
}

const EFFECTS = [
    { icon: IconEye, label: "Sees them in its roster" },
    { icon: IconMessage, label: "Can message and @mention them" },
    { icon: IconArrowForwardUp, label: "Can hand work to them" },
];

export function AgentScopeTab({ agentId, agentName, initialScope }: Props) {
    const [mode, setMode] = useState<"all" | "restricted">(initialScope?.mode === "restricted" ? "restricted" : "all");
    const [customerIds, setCustomerIds] = useState<string[]>(initialScope?.customerIds ?? []);
    const [projectIds, setProjectIds] = useState<string[]>(initialScope?.projectIds ?? []);
    const [agentMode, setAgentMode] = useState<"all" | "only">(Array.isArray(initialScope?.agentIds) ? "only" : "all");
    const [agentIds, setAgentIds] = useState<string[]>(initialScope?.agentIds ?? []);
    const [agentQuery, setAgentQuery] = useState("");
    const [customers, setCustomers] = useState<{ id: string; name: string }[]>([]);
    const [projects, setProjects] = useState<{ id: string; goal: string; customerId: string | null }[]>([]);
    const [roster, setRoster] = useState<RosterAgent[]>([]);
    const [saving, setSaving] = useState(false);
    // Only owners/admins may change an agent's scope (the API refuses others).
    const { canAdmin, loaded } = useViewerPermissions();
    const readOnly = !canAdmin;
    const self = agentName || "This agent";

    useEffect(() => {
        fetch("/api/customers").then((r) => r.json()).then((d) => setCustomers(d.customers || [])).catch(() => {});
        fetch("/api/projects").then((r) => r.json()).then((d) => setProjects(d.projects || [])).catch(() => {});
        fetch("/api/agents").then((r) => r.json()).then((d) => setRoster(d.agents || [])).catch(() => {});
    }, []);

    const others = useMemo(() => roster.filter((a) => a.id !== agentId).sort((a, b) => a.name.localeCompare(b.name)), [roster, agentId]);
    const filtered = useMemo(() => {
        const q = agentQuery.trim().toLowerCase();
        return q ? others.filter((a) => a.name.toLowerCase().includes(q)) : others;
    }, [others, agentQuery]);
    const selectedCount = agentIds.filter((id) => others.some((a) => a.id === id)).length;

    const handleSave = async () => {
        setSaving(true);
        try {
            const res = await fetch(`/api/agents/${agentId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    scopeJson: { mode, customerIds, projectIds, agentIds: agentMode === "only" ? agentIds : null },
                }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(typeof data.error === "string" ? data.error : "Failed to save scope");
            }
            toast.success("Scope saved");
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Failed to save scope");
        } finally {
            setSaving(false);
        }
    };

    const isLockedOut = mode === "restricted" && customerIds.length === 0 && projectIds.length === 0;

    return (
        <div className="max-w-xl space-y-6">
            {loaded && readOnly && (
                <p className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-400">
                    Only owners and admins can change this agent&apos;s scope.
                </p>
            )}

            <section className="space-y-4">
                <div className="flex items-center gap-2 text-zinc-300">
                    <IconShieldLock className="h-4 w-4 text-cyan-400" />
                    <span className="text-sm font-medium">Data scope</span>
                </div>
                <p className="text-xs text-zinc-500">
                    Restrict which customers and projects this agent can read or act on — tasks,
                    artifacts, and Knowledge &amp; Rules under them. Team chat stays visible regardless of scope.
                </p>
                <label className="flex items-center gap-3 cursor-pointer">
                    <input
                        type="checkbox"
                        disabled={readOnly}
                        checked={mode === "restricted"}
                        onChange={(e) => setMode(e.target.checked ? "restricted" : "all")}
                        className="rounded border-zinc-700 bg-zinc-900 text-cyan-400 focus:ring-cyan-400"
                    />
                    <span className="text-sm text-zinc-200">Restricted</span>
                    <span className="text-xs text-zinc-500">(unchecked = sees everything)</span>
                </label>

                {mode === "restricted" && (
                    <>
                        {isLockedOut && (
                            <div className="rounded-lg border border-amber-700/40 bg-amber-900/20 px-3 py-2 text-xs text-amber-300">
                                No customers or projects selected — this agent will see nothing until you add at least one.
                            </div>
                        )}
                        <div>
                            <h4 className="text-sm font-medium text-zinc-300 mb-2">Customers</h4>
                            <div className="max-h-40 overflow-y-auto space-y-1 rounded-lg border border-zinc-800 bg-zinc-900/50 p-2">
                                {customers.length === 0 && <p className="text-xs text-zinc-600 p-2">No customers</p>}
                                {customers.map((c) => (
                                    <label key={c.id} className="flex items-center gap-2 cursor-pointer px-2 py-1 rounded hover:bg-zinc-800/50">
                                        <input
                                            type="checkbox"
                                            disabled={readOnly}
                                            checked={customerIds.includes(c.id)}
                                            onChange={() => toggleId(c.id, customerIds, setCustomerIds)}
                                            className="rounded border-zinc-700 bg-zinc-900 text-cyan-400"
                                        />
                                        <span className="text-sm text-zinc-300">{c.name}</span>
                                    </label>
                                ))}
                            </div>
                        </div>
                        <div>
                            <h4 className="text-sm font-medium text-zinc-300 mb-2">Projects</h4>
                            <div className="max-h-40 overflow-y-auto space-y-1 rounded-lg border border-zinc-800 bg-zinc-900/50 p-2">
                                {projects.length === 0 && <p className="text-xs text-zinc-600 p-2">No projects</p>}
                                {projects.map((p) => (
                                    <label key={p.id} className="flex items-center gap-2 cursor-pointer px-2 py-1 rounded hover:bg-zinc-800/50">
                                        <input
                                            type="checkbox"
                                            disabled={readOnly}
                                            checked={projectIds.includes(p.id)}
                                            onChange={() => toggleId(p.id, projectIds, setProjectIds)}
                                            className="rounded border-zinc-700 bg-zinc-900 text-cyan-400"
                                        />
                                        <span className="text-sm text-zinc-300">{p.goal}</span>
                                    </label>
                                ))}
                            </div>
                        </div>
                    </>
                )}
            </section>

            <section className="space-y-4 border-t border-zinc-800 pt-6" aria-labelledby="scope-agents-heading">
                <div className="flex items-center gap-2 text-zinc-300">
                    <IconUsers className="h-4 w-4 text-cyan-400" />
                    <h3 id="scope-agents-heading" className="text-sm font-medium">Agents it can work with</h3>
                </div>
                <p className="text-xs text-zinc-500">
                    Choose which other agents {self} can reach. This works one way: it limits only {self},
                    not the agents you leave out. They can still message it, and it always sees itself.
                </p>
                <ul className="grid gap-1.5 sm:grid-cols-3">
                    {EFFECTS.map(({ icon: Icon, label }) => (
                        <li key={label} className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/40 px-2.5 py-2 text-[11px] leading-4 text-zinc-400">
                            <Icon className="h-3.5 w-3.5 shrink-0 text-cyan-400/80" aria-hidden />
                            {label}
                        </li>
                    ))}
                </ul>

                <div role="radiogroup" aria-label="Agents it can work with" className="inline-flex w-full rounded-lg border border-zinc-800 bg-zinc-900/60 p-1 sm:w-auto">
                    {([
                        { value: "all", label: "All agents" },
                        { value: "only", label: "Only these" },
                    ] as const).map((option) => (
                        <button
                            key={option.value}
                            type="button"
                            role="radio"
                            aria-checked={agentMode === option.value}
                            disabled={readOnly}
                            onClick={() => setAgentMode(option.value)}
                            className={cn(
                                "min-h-9 flex-1 rounded-md px-4 text-xs font-medium transition sm:flex-none",
                                agentMode === option.value ? "bg-cyan-500/15 text-cyan-200 ring-1 ring-cyan-500/40" : "text-zinc-400 hover:text-zinc-200",
                                readOnly && "cursor-not-allowed opacity-60",
                            )}
                        >
                            {option.label}
                        </button>
                    ))}
                </div>

                {agentMode === "all" ? (
                    <p className="text-xs text-zinc-500">{self} can see, message and hand work to every agent in the company, including new ones.</p>
                ) : (
                    <div className="space-y-2">
                        {selectedCount === 0 && (
                            <div className="rounded-lg border border-amber-700/40 bg-amber-900/20 px-3 py-2 text-xs text-amber-300" role="status">
                                {`No agents selected — ${self} will work alone: it won't see, message or hand work to any other agent.`}
                            </div>
                        )}
                        <div className="relative">
                            <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" aria-hidden />
                            <input
                                type="search"
                                value={agentQuery}
                                onChange={(e) => setAgentQuery(e.target.value)}
                                placeholder="Search agents"
                                aria-label="Search agents"
                                className="min-h-10 w-full rounded-lg border border-zinc-800 bg-zinc-950 pl-9 pr-3 text-sm text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-cyan-400/60"
                            />
                        </div>
                        <div className="flex items-center justify-between text-[11px] text-zinc-500">
                            <span>{selectedCount} of {others.length} selected</span>
                            {!readOnly && others.length > 0 && (
                                <span className="flex gap-3">
                                    <button type="button" className="hover:text-zinc-300" onClick={() => setAgentIds(others.map((a) => a.id))}>Select all</button>
                                    <button type="button" className="hover:text-zinc-300" onClick={() => setAgentIds([])}>Clear</button>
                                </span>
                            )}
                        </div>
                        <div className="max-h-56 overflow-y-auto space-y-1 rounded-lg border border-zinc-800 bg-zinc-900/50 p-2">
                            {others.length === 0 && <p className="p-2 text-xs text-zinc-600">No other agents yet</p>}
                            {others.length > 0 && filtered.length === 0 && <p className="p-2 text-xs text-zinc-600">No agent matches “{agentQuery}”</p>}
                            {filtered.map((a) => (
                                <label key={a.id} className="flex min-h-10 cursor-pointer items-center gap-3 rounded px-2 py-1 hover:bg-zinc-800/50">
                                    <input
                                        type="checkbox"
                                        disabled={readOnly}
                                        checked={agentIds.includes(a.id)}
                                        onChange={() => toggleId(a.id, agentIds, setAgentIds)}
                                        className="rounded border-zinc-700 bg-zinc-900 text-cyan-400"
                                    />
                                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-[10px] font-semibold text-zinc-300" aria-hidden>
                                        {a.name.slice(0, 1).toUpperCase()}
                                    </span>
                                    <span className="truncate text-sm text-zinc-300">{a.name}</span>
                                </label>
                            ))}
                        </div>
                    </div>
                )}
            </section>

            <Button
                size="sm"
                variant="outline"
                onClick={handleSave}
                disabled={saving || readOnly}
                className="h-9 text-xs border-zinc-700 text-zinc-300 hover:bg-zinc-800"
            >
                <IconDeviceFloppy className="h-3.5 w-3.5 mr-1" />
                {saving ? "Saving..." : "Save scope"}
            </Button>
        </div>
    );
}
