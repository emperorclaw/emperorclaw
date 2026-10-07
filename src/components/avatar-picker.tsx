"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { IconArrowsShuffle, IconLoader2, IconPencil, IconRobot, IconUser } from "@tabler/icons-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { CharacterAvatar } from "@/components/character/character-avatar";
import {
    CHARACTER_ACCESSORIES, CHARACTER_HUES, deriveAppearance, resolveAppearance, resolveAvatarPhoto,
    type CharacterAccessory, type CharacterAppearance, type CharacterKind,
} from "@/lib/character/model";
import { cn } from "@/lib/utils";

const ACCESSORY_LABEL: Record<CharacterAccessory, string> = {
    none: "None",
    glasses: "Glasses",
    headset: "Headset",
    cap: "Cap",
    bow: "Bow",
};

/** Pick the drawn look for an agent: kind, colour, accessory, or shuffle the seed. */
export function AvatarPicker({ agentId, agentName, avatarUrl, avatarAppearance, onSaved, className }: {
    agentId: string;
    agentName: string;
    avatarUrl: string | null;
    avatarAppearance?: unknown;
    onSaved?: (appearance: CharacterAppearance, avatarUrl: string | null) => void;
    className?: string;
}) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [appearance, setAppearance] = useState<CharacterAppearance>(() => resolveAppearance({ id: agentId, avatarUrl, avatarAppearance }));
    const [photo] = useState<string | null>(() => resolveAvatarPhoto({ avatarUrl }));
    const [applyToAll, setApplyToAll] = useState(false);
    const [saving, setSaving] = useState(false);

    const patch = (changes: Partial<CharacterAppearance>) => setAppearance((current) => ({ ...current, ...changes }));

    const save = async () => {
        setSaving(true);
        try {
            const res = await fetch(`/api/agents/${agentId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ avatarAppearance: appearance, avatarUrl: null }),
            });
            if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Could not save");
            if (applyToAll) {
                const all = await fetch("/api/agents/avatar-style", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ kind: appearance.kind, hue: appearance.hue, accessory: appearance.accessory }),
                });
                if (!all.ok) throw new Error((await all.json().catch(() => ({}))).error || "Could not update the other agents");
            }
            onSaved?.(appearance, null);
            toast.success(applyToAll ? "Every agent now shares this look" : "Avatar updated");
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
                <CharacterAvatar agentId={agentId} name={agentName} avatarUrl={photo} avatarAppearance={appearance} size={64} className="rounded-xl ring-0" decorative />
                <span className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100">
                    <IconPencil className="h-4 w-4 text-white" />
                </span>
            </button>
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="sm:max-w-lg">
                    <DialogHeader>
                        <DialogTitle>{agentName}&apos;s avatar</DialogTitle>
                        <DialogDescription>Pick a look. Shuffle for a different character with the same settings.</DialogDescription>
                    </DialogHeader>

                    <div className="flex items-center gap-4">
                        <div className="grid h-24 w-24 shrink-0 place-items-center rounded-2xl border border-zinc-800 bg-zinc-950">
                            <CharacterAvatar agentId={agentId} name={agentName} avatarUrl={photo} avatarAppearance={appearance} size={80} decorative />
                        </div>
                        <div className="min-w-0 flex-1 space-y-2">
                            <div className="flex rounded-xl border border-zinc-800 p-0.5">
                                {([["robot", "Robot", IconRobot], ["human", "Person", IconUser]] as const).map(([value, label, Icon]) => (
                                    <button key={value} type="button" onClick={() => patch({ kind: value as CharacterKind })}
                                        aria-pressed={appearance.kind === value}
                                        className={cn("inline-flex flex-1 items-center justify-center gap-1.5 rounded-[10px] py-1.5 text-xs font-medium transition",
                                            appearance.kind === value ? "bg-cyan-400/15 text-cyan-200 ring-1 ring-inset ring-cyan-400/40" : "text-zinc-400 hover:text-zinc-200")}>
                                        <Icon className="h-4 w-4" />{label}
                                    </button>
                                ))}
                            </div>
                            <div>
                                <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-zinc-500">Colour</div>
                                <div className="flex flex-wrap gap-1.5">
                                    {CHARACTER_HUES.map((hue) => (
                                        <button key={hue} type="button" onClick={() => patch({ hue })} aria-label={`Colour ${hue}`}
                                            aria-pressed={appearance.hue === hue}
                                            className={cn("h-6 w-6 rounded-full ring-offset-2 ring-offset-zinc-950 transition", appearance.hue === hue ? "ring-2 ring-white" : "ring-1 ring-white/15 hover:ring-white/40")}
                                            style={{ background: `hsl(${hue} 62% 55%)` }} />
                                    ))}
                                </div>
                            </div>
                        </div>
                    </div>

                    <div>
                        <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-zinc-500">Accessory</div>
                        <div className="flex flex-wrap gap-1.5">
                            {CHARACTER_ACCESSORIES.filter((a, i) => CHARACTER_ACCESSORIES.indexOf(a) === i).map((accessory) => (
                                <button key={accessory} type="button" onClick={() => patch({ accessory })}
                                    aria-pressed={appearance.accessory === accessory}
                                    className={cn("rounded-lg border px-2.5 py-1 text-xs font-medium transition",
                                        appearance.accessory === accessory ? "border-cyan-400/60 bg-cyan-400/10 text-cyan-200" : "border-zinc-800 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200")}>
                                    {ACCESSORY_LABEL[accessory]}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <Button type="button" variant="outline" size="sm" onClick={() => setAppearance(deriveAppearance(`${agentId}-${Math.random().toString(36).slice(2, 8)}`, appearance.kind))}>
                            <IconArrowsShuffle className="h-4 w-4" />Shuffle
                        </Button>
                        <label className="flex items-center gap-2 text-xs text-zinc-400">
                            <input type="checkbox" checked={applyToAll} onChange={(e) => setApplyToAll(e.target.checked)} className="accent-cyan-400" />
                            Use this look for every agent
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
