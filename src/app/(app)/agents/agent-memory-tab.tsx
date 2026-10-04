"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { IconBrain, IconLoader2, IconTrash, IconUser, IconRobot } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { MAX_MEMORY_LENGTH, MEMORY_KINDS, MEMORY_KIND_LABELS, type MemoryKind } from "@/lib/agent-memory";
import { cn } from "@/lib/utils";

type Entry = { id: string; kind: string; content: string; summary: string | null; metadataJson: Record<string, unknown> | null; createdAt: string };

const KIND_STYLE: Record<string, string> = {
    preference: "bg-violet-500/12 text-violet-200 ring-violet-500/25",
    lesson: "bg-amber-500/12 text-amber-200 ring-amber-500/25",
    fact: "bg-cyan-500/12 text-cyan-200 ring-cyan-500/25",
    context: "bg-zinc-500/12 text-zinc-300 ring-zinc-500/25",
};

/**
 * What the agent remembers: short notes it reads at the start of every turn.
 * The agent adds them itself (emperor_remember); people can teach it here and
 * remove anything wrong or stale.
 */
export function AgentMemoryTab({ agentId, agentName }: { agentId: string; agentName: string }) {
    const [entries, setEntries] = useState<Entry[] | null>(null);
    const [content, setContent] = useState("");
    const [kind, setKind] = useState<MemoryKind>("preference");
    const [saving, setSaving] = useState(false);
    const [deleting, setDeleting] = useState<string | null>(null);

    const load = useCallback(async () => {
        const res = await fetch(`/api/agents/${agentId}/memory`, { cache: "no-store" }).catch(() => null);
        const data = res?.ok ? await res.json() : { entries: [] };
        setEntries(data.entries || []);
    }, [agentId]);

    useEffect(() => { void load(); }, [load]);

    const save = async () => {
        if (!content.trim() || saving) return;
        setSaving(true);
        try {
            const res = await fetch(`/api/agents/${agentId}/memory`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content, kind }) });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || "Could not save");
            setContent("");
            toast.success(`${agentName} will remember that`);
            await load();
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "Could not save");
        } finally {
            setSaving(false);
        }
    };

    const forget = async (entryId: string) => {
        setDeleting(entryId);
        const res = await fetch(`/api/agents/${agentId}/memory?entryId=${entryId}`, { method: "DELETE" }).catch(() => null);
        if (res?.ok) setEntries((current) => (current ?? []).filter((e) => e.id !== entryId));
        else toast.error("Could not remove it");
        setDeleting(null);
    };

    return (
        <div className="space-y-4">
            <section className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
                <h3 className="text-sm font-medium text-zinc-200">Teach {agentName} something</h3>
                <p className="text-xs leading-5 text-zinc-500">A preference or rule about how it should work. It reads its memory at the start of every turn. Company facts belong in Knowledge &amp; Rules.</p>
                <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={2} maxLength={MAX_MEMORY_LENGTH}
                    placeholder="Always copy ana@acme.example on client emails."
                    className="w-full resize-y rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-cyan-400/60" />
                <div className="flex flex-wrap items-center gap-1.5">
                    {MEMORY_KINDS.map((k) => (
                        <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}
                            className={cn("rounded-full px-2.5 py-1 text-[11px] ring-1 transition", kind === k ? KIND_STYLE[k] : "text-zinc-500 ring-zinc-800 hover:text-zinc-300")}>
                            {MEMORY_KIND_LABELS[k]}
                        </button>
                    ))}
                    <Button size="sm" className="ml-auto" onClick={() => void save()} disabled={!content.trim() || saving}>
                        {saving && <IconLoader2 className="h-4 w-4 animate-spin" />}Remember this
                    </Button>
                </div>
            </section>
            <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
                <div className="mb-3 flex items-center gap-2">
                    <IconBrain className="h-4 w-4 text-cyan-400" />
                    <h3 className="text-sm font-medium text-zinc-200">What {agentName} remembers</h3>
                    {entries && <span className="text-xs text-zinc-500">{entries.length}</span>}
                </div>
                {entries === null ? (
                    <p className="flex items-center gap-2 text-xs text-zinc-500"><IconLoader2 className="h-3.5 w-3.5 animate-spin" />Loading…</p>
                ) : entries.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-zinc-800 p-6 text-center text-xs leading-5 text-zinc-500">
                        Nothing yet. {agentName} saves preferences and corrections here as you work together, or teach it something on the right.
                    </p>
                ) : (
                    <ul className="max-h-[460px] space-y-2 overflow-y-auto pr-1">
                        {entries.map((entry) => {
                            const fromPerson = entry.metadataJson?.source === "operator";
                            return (
                                <li key={entry.id} className="group rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
                                    <div className="mb-1.5 flex items-center gap-2">
                                        <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1", KIND_STYLE[entry.kind] ?? KIND_STYLE.context)}>
                                            {MEMORY_KIND_LABELS[entry.kind as MemoryKind] ?? entry.kind}
                                        </span>
                                        <span className="flex items-center gap-1 text-[10px] text-zinc-500">
                                            {fromPerson ? <IconUser className="h-3 w-3" /> : <IconRobot className="h-3 w-3" />}
                                            {fromPerson ? "Taught by a person" : "Saved by the agent"} · {new Date(entry.createdAt).toLocaleDateString()}
                                        </span>
                                        <button type="button" onClick={() => void forget(entry.id)} disabled={deleting === entry.id}
                                            className="ml-auto rounded p-1 text-zinc-600 opacity-0 transition hover:bg-zinc-800 hover:text-rose-300 focus:opacity-100 group-hover:opacity-100" aria-label="Forget this">
                                            {deleting === entry.id ? <IconLoader2 className="h-3.5 w-3.5 animate-spin" /> : <IconTrash className="h-3.5 w-3.5" />}
                                        </button>
                                    </div>
                                    {entry.summary && <p className="text-xs font-medium text-zinc-200">{entry.summary}</p>}
                                    <p className="whitespace-pre-wrap text-xs leading-5 text-zinc-400">{entry.content}</p>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </section>
        </div>
    );
}
