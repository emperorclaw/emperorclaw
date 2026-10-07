"use client";

import { useMemo, useState } from "react";
import { IconCheck, IconRobot, IconSearch, IconTrash, IconUser, IconUsersGroup } from "@tabler/icons-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { agentAvatarSrc } from "@/lib/avatar";
import { GROUP_ICONS, GroupIcon } from "@/components/group-icon";

export type GroupDialogAgent = { id: string; name: string; role: string | null; avatarUrl: string | null; status: string };
export type GroupDialogHuman = { id: string; name: string };
export type GroupDialogGroup = {
    id: string;
    title: string;
    description: string | null;
    icon?: string | null;
    members: { kind: "agent" | "human"; id: string; name: string; role: string }[];
};

const TEMPLATES = [
    { title: "Development team", icon: "💻", description: "Build, review, and test features. Devs implement, the tester verifies, and blockers are raised here." },
    { title: "Marketing", icon: "📣", description: "Campaigns, content, and launch coordination." },
    { title: "Support", icon: "🛟", description: "Customer issues, escalations, and follow-ups." },
];

function avatarFor(agent: GroupDialogAgent) {
    return agentAvatarSrc(agent);
}

/**
 * Create a group, or manage an existing one (rename, purpose, members,
 * archive). Members are picked from the company's agents and humans; you are
 * added automatically when you create a group.
 */
export function GroupDialog({
    open,
    onOpenChange,
    agents,
    humans,
    currentUserId,
    group,
    onSaved,
    onArchived,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    agents: GroupDialogAgent[];
    humans: GroupDialogHuman[];
    currentUserId: string | null;
    group?: GroupDialogGroup | null;
    onSaved: (groupId: string) => void;
    onArchived?: (groupId: string) => void;
}) {
    const editing = Boolean(group);
    const initialAgents = useMemo(() => new Set(group?.members.filter((m) => m.kind === "agent").map((m) => m.id) ?? []), [group]);
    const initialHumans = useMemo(() => new Set(group?.members.filter((m) => m.kind === "human").map((m) => m.id) ?? []), [group]);

    const [title, setTitle] = useState(group?.title ?? "");
    const [description, setDescription] = useState(group?.description ?? "");
    const [icon, setIcon] = useState<string | null>(group?.icon ?? null);
    const [agentIds, setAgentIds] = useState<Set<string>>(new Set(initialAgents));
    const [humanIds, setHumanIds] = useState<Set<string>>(new Set(initialHumans));
    const [query, setQuery] = useState("");
    const [saving, setSaving] = useState(false);
    const [confirmArchive, setConfirmArchive] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const q = query.trim().toLowerCase();
    const visibleAgents = agents.filter((a) => !q || a.name.toLowerCase().includes(q) || (a.role || "").toLowerCase().includes(q));
    const visibleHumans = humans.filter((h) => h.id !== currentUserId && (!q || h.name.toLowerCase().includes(q)));

    const toggle = (set: Set<string>, setter: (s: Set<string>) => void, id: string) => {
        const next = new Set(set);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        setter(next);
    };

    const call = async (url: string, method: string, body?: unknown) => {
        const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Something went wrong");
        return data;
    };

    const save = async () => {
        if (!title.trim()) {
            setError("Give the group a name.");
            return;
        }
        setSaving(true);
        setError(null);
        try {
            if (!group) {
                const data = await call("/api/groups", "POST", {
                    title,
                    description,
                    icon,
                    agentIds: [...agentIds],
                    humanUserIds: [...humanIds],
                });
                onSaved(data.group.id);
            } else {
                if (title.trim() !== group.title || (description.trim() || null) !== (group.description || null) || (icon ?? null) !== (group.icon ?? null)) {
                    await call(`/api/groups/${group.id}`, "PATCH", { title, description, icon: icon ?? "" });
                }
                const addAgents = [...agentIds].filter((id) => !initialAgents.has(id));
                const addHumans = [...humanIds].filter((id) => !initialHumans.has(id));
                if (addAgents.length || addHumans.length) {
                    await call(`/api/groups/${group.id}/members`, "POST", { agentIds: addAgents, humanUserIds: addHumans });
                }
                for (const id of [...initialAgents].filter((id) => !agentIds.has(id))) {
                    await call(`/api/groups/${group.id}/members`, "DELETE", { kind: "agent", id });
                }
                for (const id of [...initialHumans].filter((id) => !humanIds.has(id))) {
                    await call(`/api/groups/${group.id}/members`, "DELETE", { kind: "human", id });
                }
                onSaved(group.id);
            }
            onOpenChange(false);
        } catch (e) {
            setError(e instanceof Error ? e.message : "Could not save the group");
        } finally {
            setSaving(false);
        }
    };

    const archive = async () => {
        if (!group) return;
        setSaving(true);
        try {
            await call(`/api/groups/${group.id}`, "DELETE");
            onArchived?.(group.id);
            onOpenChange(false);
        } catch (e) {
            setError(e instanceof Error ? e.message : "Could not archive the group");
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="flex max-h-[90dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
                <div className="border-b border-zinc-800 px-5 pb-4 pt-5">
                    <DialogTitle className="flex items-center gap-2 text-base">
                        <IconUsersGroup className="h-5 w-5 text-cyan-300" />
                        {editing ? "Manage group" : "New group"}
                    </DialogTitle>
                    <DialogDescription className="mt-1 text-xs">
                        Like the team channel, but only its members see it. Agents in the group reply when you @mention them.
                    </DialogDescription>
                </div>

                <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
                    {!editing && (
                        <div className="flex flex-wrap gap-1.5">
                            {TEMPLATES.map((t) => (
                                <button
                                    key={t.title}
                                    type="button"
                                    onClick={() => { setTitle(t.title); setDescription(t.description); setIcon(t.icon); }}
                                    className="rounded-full border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 transition-colors hover:border-cyan-400/50 hover:bg-cyan-400/10 hover:text-cyan-100"
                                >
                                    {t.title}
                                </button>
                            ))}
                        </div>
                    )}
                    <div>
                        <span className="text-xs font-medium text-zinc-400">Icon</span>
                        <div className="mt-1 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Group icon">
                            <button type="button" role="radio" aria-checked={!icon} onClick={() => setIcon(null)} title="Default"
                                className={cn("grid h-9 w-9 place-items-center rounded-lg border transition-colors", !icon ? "border-cyan-400/60 bg-cyan-400/10 text-cyan-200" : "border-zinc-800 text-zinc-500 hover:border-zinc-600")}>
                                <GroupIcon className="h-4 w-4" />
                            </button>
                            {GROUP_ICONS.map((emoji) => (
                                <button key={emoji} type="button" role="radio" aria-checked={icon === emoji} onClick={() => setIcon(emoji)}
                                    className={cn("grid h-9 w-9 place-items-center rounded-lg border text-lg transition-colors", icon === emoji ? "border-cyan-400/60 bg-cyan-400/10" : "border-zinc-800 hover:border-zinc-600")}>
                                    {emoji}
                                </button>
                            ))}
                        </div>
                    </div>
                    <label className="block">
                        <span className="text-xs font-medium text-zinc-400">Name</span>
                        <input
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            maxLength={80}
                            placeholder="Development team"
                            className="mt-1 h-10 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-cyan-400/60"
                        />
                    </label>
                    <label className="block">
                        <span className="text-xs font-medium text-zinc-400">Purpose <span className="text-zinc-600">(agents read this every turn)</span></span>
                        <textarea
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            maxLength={600}
                            rows={2}
                            placeholder="What this group works on, and how members should use it."
                            className="mt-1 w-full resize-none rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-cyan-400/60"
                        />
                    </label>

                    <div>
                        <div className="mb-1.5 flex items-center justify-between">
                            <span className="text-xs font-medium text-zinc-400">Members</span>
                            <span className="text-[11px] text-zinc-500">{agentIds.size} agent{agentIds.size === 1 ? "" : "s"} · {humanIds.size + (editing ? 0 : 1)} human{humanIds.size + (editing ? 0 : 1) === 1 ? "" : "s"}</span>
                        </div>
                        <div className="relative mb-2">
                            <IconSearch className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
                            <input
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                placeholder="Find agents or people"
                                aria-label="Find members"
                                className="h-9 w-full rounded-lg border border-zinc-800 bg-zinc-950 pl-9 pr-3 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-cyan-400/60"
                            />
                        </div>
                        <div className="max-h-64 space-y-0.5 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950/60 p-1">
                            {visibleAgents.map((agent) => {
                                const selected = agentIds.has(agent.id);
                                return (
                                    <button
                                        key={agent.id}
                                        type="button"
                                        role="checkbox"
                                        aria-checked={selected}
                                        onClick={() => toggle(agentIds, setAgentIds, agent.id)}
                                        className={cn("flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors", selected ? "bg-cyan-400/10" : "hover:bg-zinc-900")}
                                    >
                                        {/* eslint-disable-next-line @next/next/no-img-element */}
                                        <img src={avatarFor(agent)} alt="" className="h-7 w-7 shrink-0 rounded-lg border border-zinc-800 object-cover" />
                                        <span className="min-w-0 flex-1">
                                            <span className="block truncate text-sm text-zinc-100">{agent.name}</span>
                                            <span className="block truncate text-[11px] text-zinc-500">{agent.role || "Agent"}</span>
                                        </span>
                                        <IconRobot className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
                                        <span className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded-md border", selected ? "border-cyan-400 bg-cyan-400 text-cyan-950" : "border-zinc-700")}>
                                            {selected && <IconCheck className="h-3.5 w-3.5" />}
                                        </span>
                                    </button>
                                );
                            })}
                            {visibleHumans.map((human) => {
                                const selected = humanIds.has(human.id);
                                return (
                                    <button
                                        key={human.id}
                                        type="button"
                                        role="checkbox"
                                        aria-checked={selected}
                                        onClick={() => toggle(humanIds, setHumanIds, human.id)}
                                        className={cn("flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors", selected ? "bg-cyan-400/10" : "hover:bg-zinc-900")}
                                    >
                                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-800 text-zinc-400">
                                            <IconUser className="h-4 w-4" />
                                        </span>
                                        <span className="min-w-0 flex-1 truncate text-sm text-zinc-100">{human.name}</span>
                                        <span className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded-md border", selected ? "border-cyan-400 bg-cyan-400 text-cyan-950" : "border-zinc-700")}>
                                            {selected && <IconCheck className="h-3.5 w-3.5" />}
                                        </span>
                                    </button>
                                );
                            })}
                            {visibleAgents.length + visibleHumans.length === 0 && (
                                <div className="px-3 py-6 text-center text-xs text-zinc-500">Nobody matches “{query}”.</div>
                            )}
                        </div>
                        {!editing && <p className="mt-1.5 text-[11px] text-zinc-500">You are added automatically. Anyone in the company can open the group; people become members when they post.</p>}
                    </div>
                    {error && <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{error}</div>}
                </div>

                <div className="flex items-center gap-2 border-t border-zinc-800 px-5 py-3">
                    {editing && (
                        confirmArchive ? (
                            <span className="flex items-center gap-2 text-xs text-zinc-400">
                                Archive this group?
                                <button type="button" onClick={archive} disabled={saving} className="rounded-md bg-rose-500/15 px-2 py-1 font-medium text-rose-200 hover:bg-rose-500/25">Archive</button>
                                <button type="button" onClick={() => setConfirmArchive(false)} className="rounded-md px-2 py-1 text-zinc-400 hover:text-zinc-200">Keep</button>
                            </span>
                        ) : (
                            <button type="button" onClick={() => setConfirmArchive(true)} className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-zinc-500 hover:bg-rose-500/10 hover:text-rose-300">
                                <IconTrash className="h-3.5 w-3.5" /> Archive
                            </button>
                        )
                    )}
                    <span className="flex-1" />
                    <button type="button" onClick={() => onOpenChange(false)} className="rounded-lg px-3 py-2 text-sm text-zinc-400 hover:text-zinc-100">Cancel</button>
                    <button
                        type="button"
                        onClick={save}
                        disabled={saving || !title.trim()}
                        className="rounded-lg bg-cyan-400 px-4 py-2 text-sm font-semibold text-cyan-950 transition-colors hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {saving ? "Saving…" : editing ? "Save" : "Create group"}
                    </button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
