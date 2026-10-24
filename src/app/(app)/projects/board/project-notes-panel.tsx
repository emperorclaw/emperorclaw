"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useEffect, useState } from "react";
import { IconBrain, IconLoader2, IconPlus, IconX } from "@tabler/icons-react";
import { RichText } from "@/components/rich-text";

/** Shared notes for one project: what every agent on it should know. */
export function ProjectNotesPanel({ projectName, notes, agentName, canEdit, onAdd, onClose }: {
    projectName: string;
    notes: any[];
    agentName: (id?: string | null) => string;
    canEdit: boolean;
    onAdd: (content: string) => Promise<boolean>;
    onClose: () => void;
}) {
    const [draft, setDraft] = useState("");
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    const save = async () => {
        if (!draft.trim()) return;
        setSaving(true);
        const ok = await onAdd(draft);
        setSaving(false);
        if (ok) setDraft("");
    };

    return (
        <>
            <button type="button" aria-label="Close notes" onClick={onClose} className="fixed inset-0 z-40 bg-black/50 lg:bg-black/20 motion-safe:animate-in motion-safe:fade-in" />
            <aside role="dialog" aria-labelledby="project-notes-title" className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-zinc-800 bg-zinc-950 shadow-[-24px_0_48px_-24px_rgba(0,0,0,0.6)] sm:w-[min(34rem,92vw)] motion-safe:animate-in motion-safe:slide-in-from-right-6 motion-safe:duration-200">
                <div className="flex items-center gap-3 border-b border-zinc-800/80 px-5 py-3">
                    <IconBrain className="h-5 w-5 shrink-0 text-cyan-300" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                        <h2 id="project-notes-title" className="text-base font-semibold text-zinc-50">Project notes</h2>
                        <p className="truncate text-xs text-zinc-500" title={projectName}>{projectName}</p>
                    </div>
                    <button type="button" onClick={onClose} aria-label="Close" className="inline-flex h-8 w-8 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"><IconX className="h-4 w-4" aria-hidden="true" /></button>
                </div>
                <div className="custom-scrollbar min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5">
                    {canEdit && (
                        <div className="space-y-2">
                            <label htmlFor="project-note" className="text-xs font-medium text-zinc-400">Add a note</label>
                            <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/40 focus-within:border-cyan-400/60">
                                <textarea id="project-note" value={draft} onChange={(event) => setDraft(event.target.value)} rows={4} placeholder="Goals, findings or context every agent on this project should know. Markdown works." className="block w-full resize-none bg-transparent p-3 text-sm text-zinc-200 outline-none placeholder:text-zinc-500" />
                                <div className="flex justify-end border-t border-zinc-800/80 px-3 py-1.5">
                                    <button type="button" onClick={() => void save()} disabled={!draft.trim() || saving} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-cyan-400/10 px-3 text-xs font-medium text-cyan-100 transition-colors hover:bg-cyan-400/20 disabled:cursor-not-allowed disabled:opacity-50">
                                        {saving ? <IconLoader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <IconPlus className="h-3.5 w-3.5" aria-hidden="true" />}
                                        Save note
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}
                    {notes.length === 0 ? (
                        <div className="rounded-xl border border-dashed border-zinc-800 px-5 py-8 text-center">
                            <p className="text-sm text-zinc-300">No notes yet for this project.</p>
                            <p className="mt-1 text-xs text-zinc-500">Notes here reach every agent working on the project.</p>
                        </div>
                    ) : (
                        <ol className="space-y-3">
                            {notes.map((memory) => (
                                <li key={memory.id} className="rounded-xl border border-zinc-800/80 bg-zinc-900/30 px-4 py-3">
                                    <p className="mb-2 text-xs text-zinc-500">
                                        {memory.createdByAgentId ? <span className="text-zinc-300">{agentName(memory.createdByAgentId)}</span> : "Note"}
                                        <span> · {new Date(memory.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                                    </p>
                                    <RichText content={memory.content} collapsedHeight={220} />
                                    {Array.isArray(memory.tags) && memory.tags.length > 0 && (
                                        <p className="mt-2 flex flex-wrap gap-1.5">{memory.tags.map((tag: string) => <span key={tag} className="rounded-md bg-zinc-800/70 px-1.5 py-0.5 text-[11px] text-zinc-400">{tag}</span>)}</p>
                                    )}
                                </li>
                            ))}
                        </ol>
                    )}
                </div>
            </aside>
        </>
    );
}
