"use client";

import { useEffect, useState } from "react";
import { IconShieldLock, IconDeviceFloppy } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

type AgentScope = {
    mode?: "all" | "restricted";
    customerIds?: string[];
    projectIds?: string[];
};

type Props = {
    agentId: string;
    initialScope: AgentScope | undefined;
};

function toggleId(id: string, ids: string[], setIds: (ids: string[]) => void) {
    setIds(ids.includes(id) ? ids.filter((existing) => existing !== id) : [...ids, id]);
}

export function AgentScopeTab({ agentId, initialScope }: Props) {
    const [mode, setMode] = useState<"all" | "restricted">(initialScope?.mode === "restricted" ? "restricted" : "all");
    const [customerIds, setCustomerIds] = useState<string[]>(initialScope?.customerIds ?? []);
    const [projectIds, setProjectIds] = useState<string[]>(initialScope?.projectIds ?? []);
    const [customers, setCustomers] = useState<{ id: string; name: string }[]>([]);
    const [projects, setProjects] = useState<{ id: string; goal: string; customerId: string | null }[]>([]);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        fetch("/api/customers").then((r) => r.json()).then((d) => setCustomers(d.customers || [])).catch(() => {});
        fetch("/api/projects").then((r) => r.json()).then((d) => setProjects(d.projects || [])).catch(() => {});
    }, []);

    const handleSave = async () => {
        setSaving(true);
        try {
            const res = await fetch(`/api/agents/${agentId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ scopeJson: { mode, customerIds, projectIds } }),
            });
            if (!res.ok) throw new Error("Failed to save");
            toast.success("Scope saved");
        } catch {
            toast.error("Failed to save scope");
        } finally {
            setSaving(false);
        }
    };

    const isLockedOut = mode === "restricted" && customerIds.length === 0 && projectIds.length === 0;

    return (
        <div className="max-w-xl space-y-4">
            <div className="flex items-center gap-2 text-zinc-300">
                <IconShieldLock className="h-4 w-4 text-cyan-400" />
                <span className="text-sm font-medium">Data scope</span>
            </div>
            <p className="text-xs text-zinc-500">
                Restrict which customers and projects this agent can read or act on — tasks,
                artifacts, and Knowledge &amp; Rules under them. Team chat and the agent roster
                are always visible regardless of scope.
            </p>

            <label className="flex items-center gap-3 cursor-pointer">
                <input
                    type="checkbox"
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

            <Button
                size="sm"
                variant="outline"
                onClick={handleSave}
                disabled={saving}
                className="h-8 text-xs border-zinc-700 text-zinc-300 hover:bg-zinc-800"
            >
                <IconDeviceFloppy className="h-3.5 w-3.5 mr-1" />
                {saving ? "Saving..." : "Save"}
            </Button>
        </div>
    );
}
