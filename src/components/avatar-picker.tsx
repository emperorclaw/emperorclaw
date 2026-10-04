"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { IconArrowsShuffle, IconLoader2, IconPencil } from "@tabler/icons-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AVATAR_STYLES, DEFAULT_AVATAR_STYLE, dicebearUrl, isAvatarStyle, parseDicebearUrl, type AvatarStyle } from "@/lib/avatar";
import { cn } from "@/lib/utils";

/** Click the avatar to pick a DiceBear style, reshuffle it, or give the whole team that style. */
export function AvatarPicker({ agentId, agentName, avatarUrl, onSaved, className }: {
    agentId: string;
    agentName: string;
    avatarUrl: string | null;
    onSaved?: (avatarUrl: string) => void;
    className?: string;
}) {
    const router = useRouter();
    const current = parseDicebearUrl(avatarUrl);
    const [open, setOpen] = useState(false);
    const [style, setStyle] = useState<AvatarStyle>(current && isAvatarStyle(current.style) ? current.style : DEFAULT_AVATAR_STYLE);
    const [seed, setSeed] = useState(current?.seed ?? agentId);
    const [applyToAll, setApplyToAll] = useState(false);
    const [saving, setSaving] = useState(false);
    const shown = avatarUrl || dicebearUrl(DEFAULT_AVATAR_STYLE, agentId);

    const save = async () => {
        setSaving(true);
        try {
            const url = dicebearUrl(style, seed);
            const res = await fetch(`/api/agents/${agentId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ avatarUrl: url }) });
            if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Could not save");
            if (applyToAll) {
                const all = await fetch("/api/agents/avatar-style", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ style }) });
                if (!all.ok) throw new Error((await all.json().catch(() => ({}))).error || "Could not update the other agents");
            }
            onSaved?.(url);
            toast.success(applyToAll ? "Every agent now uses this style" : "Avatar updated");
            setOpen(false);
            router.refresh();
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "Could not save");
        } finally {
            setSaving(false);
        }
    };

    return (
        <>
            <button type="button" onClick={() => setOpen(true)} aria-label={`Change ${agentName}'s avatar`}
                className={cn("group relative shrink-0 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900", className)}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={shown} alt="" className="h-full w-full object-cover" />
                <span className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100">
                    <IconPencil className="h-4 w-4 text-white" />
                </span>
            </button>
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="sm:max-w-lg">
                    <DialogHeader>
                        <DialogTitle>{agentName}&apos;s avatar</DialogTitle>
                        <DialogDescription>Pick a style. Shuffle for a different picture in the same style.</DialogDescription>
                    </DialogHeader>
                    <div className="grid grid-cols-4 gap-2">
                        {AVATAR_STYLES.map((s) => (
                            <button key={s.id} type="button" aria-pressed={style === s.id} onClick={() => setStyle(s.id)}
                                className={cn("rounded-xl border p-2 text-center transition", style === s.id ? "border-cyan-400/60 bg-cyan-400/10" : "border-zinc-800 hover:border-zinc-600")}>
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={dicebearUrl(s.id, seed)} alt="" loading="lazy" className="mx-auto h-12 w-12 rounded-lg bg-zinc-900" />
                                <span className="mt-1 block truncate text-[10px] text-zinc-400">{s.label}</span>
                            </button>
                        ))}
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <Button type="button" variant="outline" size="sm" onClick={() => setSeed(`${agentId}-${Math.random().toString(36).slice(2, 8)}`)}>
                            <IconArrowsShuffle className="h-4 w-4" />Shuffle
                        </Button>
                        <label className="flex items-center gap-2 text-xs text-zinc-400">
                            <input type="checkbox" checked={applyToAll} onChange={(e) => setApplyToAll(e.target.checked)} className="accent-cyan-400" />
                            Use this style for every agent
                        </label>
                    </div>
                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
                        <Button type="button" onClick={() => void save()} disabled={saving}>{saving && <IconLoader2 className="h-4 w-4 animate-spin" />}Save</Button>
                    </div>
                </DialogContent>
            </Dialog>
        </>
    );
}
