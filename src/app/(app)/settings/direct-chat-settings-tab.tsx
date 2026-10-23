"use client";

import { useCallback, useEffect, useState } from "react";
import { IconCheck, IconLock, IconUsers } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import type { DirectChatMode } from "@/lib/direct-chat-mode";

const OPTIONS: { mode: DirectChatMode; label: string; description: string; icon: typeof IconUsers }[] = [
    {
        mode: "shared",
        label: "Shared with the whole team",
        description: "Each agent has one direct chat that every member sees and can reply in.",
        icon: IconUsers,
    },
    {
        mode: "private",
        label: "Private per person",
        description: "Each person gets their own chat with each agent; nobody else can read it.",
        icon: IconLock,
    },
];

/** Direct chats with agents: shared per agent, or private per person. Owners and admins change it. */
export function DirectChatSettingsTab({ isAdmin }: { isAdmin: boolean }) {
    const [mode, setMode] = useState<DirectChatMode | null>(null);
    const [loadError, setLoadError] = useState(false);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoadError(false);
        try {
            const res = await fetch("/api/settings/direct-chats");
            if (!res.ok) throw new Error("Could not load direct chat settings");
            const data = await res.json();
            setMode(data.mode === "private" ? "private" : "shared");
        } catch {
            setLoadError(true);
        }
    }, []);
    useEffect(() => { void load(); }, [load]);

    const save = async (next: DirectChatMode) => {
        if (!mode || saving || !isAdmin || next === mode) return;
        const previous = mode;
        setSaving(true);
        setSaved(false);
        setError(null);
        setMode(next);
        try {
            const res = await fetch("/api/settings/direct-chats", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: next }) });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || "Could not save direct chat settings");
            setSaved(true);
            setTimeout(() => setSaved(false), 1500);
        } catch (err) {
            setMode(previous);
            setError(err instanceof Error ? err.message : "Could not save direct chat settings");
        } finally {
            setSaving(false);
        }
    };

    if (loadError && !mode) return <div className="emperor-panel rounded-2xl p-6" role="alert"><p className="text-sm text-destructive">Could not load direct chat settings.</p><button type="button" onClick={() => void load()} className="mt-3 min-h-11 rounded-lg border border-border px-4 text-sm">Retry</button></div>;
    if (!mode) return <div className="emperor-panel h-40 animate-pulse rounded-3xl" />;

    return (
        <section className="grid gap-4">
            <article className="emperor-panel rounded-2xl p-4 sm:rounded-2xl sm:p-6">
                <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                        <h2 className="text-base font-semibold text-foreground">Direct chats with agents</h2>
                        <p className="text-xs text-muted-foreground">Who can see a conversation someone has with an agent.</p>
                    </div>
                    {saved && <span className="inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400"><IconCheck className="h-3.5 w-3.5" />Saved</span>}
                </div>

                <div role="radiogroup" aria-label="Direct chats with agents" className="mt-5 grid gap-3 sm:grid-cols-2">
                    {OPTIONS.map((option) => {
                        const selected = option.mode === mode;
                        const Icon = option.icon;
                        return (
                            <button
                                key={option.mode}
                                type="button"
                                role="radio"
                                aria-checked={selected}
                                disabled={!isAdmin || saving}
                                onClick={() => void save(option.mode)}
                                className={cn(
                                    "flex min-h-11 items-start gap-3 rounded-xl border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60 disabled:cursor-not-allowed",
                                    selected ? "border-cyan-400/40 bg-cyan-400/10" : "border-border hover:border-cyan-400/30",
                                    !isAdmin && !selected && "opacity-60",
                                )}
                            >
                                <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", selected ? "text-primary" : "text-muted-foreground")} />
                                <span className="min-w-0">
                                    <span className="block text-sm font-medium text-foreground">{option.label}</span>
                                    <span className="mt-1 block text-xs text-muted-foreground">{option.description}</span>
                                </span>
                            </button>
                        );
                    })}
                </div>

                <p className="mt-4 text-xs text-muted-foreground">
                    Switching to private does not split existing conversations: each agent&apos;s current shared chat stays visible to everyone as its &quot;Operations&quot; thread, where system updates also land.
                    Switching back to shared keeps private chats private; new chats use the shared thread.
                    {!isAdmin && " Only owners and admins can change this."}
                </p>
                {error && <p role="alert" className="mt-3 text-xs text-destructive">{error}</p>}
            </article>
        </section>
    );
}
