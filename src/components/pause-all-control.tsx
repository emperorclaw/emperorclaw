"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { IconPlayerPauseFilled, IconPlayerPlayFilled } from "@tabler/icons-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type Mode = "pause" | "resume";

/**
 * Home's company-wide brake. Everyone sees the banner when every agent is
 * paused (so an idle team never looks broken); only owners and admins get
 * the buttons, and each action asks first.
 */
export function PauseAllControl({ total, paused, canManage }: { total: number; paused: number; canManage: boolean }) {
    const router = useRouter();
    const [confirm, setConfirm] = useState<Mode | null>(null);
    const [busy, setBusy] = useState(false);
    if (total === 0) return null;
    const allPaused = paused === total;
    const running = total - paused;

    async function apply(mode: Mode) {
        setBusy(true);
        try {
            const res = await fetch("/api/agents/pause-all", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ paused: mode === "pause" }),
            });
            const data = await res.json().catch(() => ({})) as { error?: string; changed?: string[] };
            if (!res.ok) throw new Error(data.error || "Could not update the agents.");
            const n = data.changed?.length ?? 0;
            toast.success(mode === "pause"
                ? `Paused ${n} agent${n === 1 ? "" : "s"}. Nothing will run until you resume.`
                : `Resumed ${n} agent${n === 1 ? "" : "s"}. They pick up their work again.`);
            setConfirm(null);
            router.refresh();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Could not update the agents.");
        } finally {
            setBusy(false);
        }
    }

    return (
        <>
            {allPaused ? (
                <div role="status" className="flex flex-wrap items-center gap-3 rounded-2xl border border-amber-500/35 bg-amber-500/10 px-4 py-3">
                    <IconPlayerPauseFilled className="h-5 w-5 shrink-0 text-amber-700 dark:text-amber-300" aria-hidden />
                    <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-foreground">All agents are paused — nothing will run.</p>
                        <p className="text-xs text-muted-foreground">
                            {canManage ? "No agent starts new work until you resume them." : "No agent starts new work. Ask an owner or admin to resume them."}
                        </p>
                    </div>
                    {canManage && (
                        <Button size="sm" onClick={() => setConfirm("resume")}>
                            <IconPlayerPlayFilled className="h-4 w-4" aria-hidden />Resume all
                        </Button>
                    )}
                </div>
            ) : canManage ? (
                <div className="flex flex-wrap items-center justify-end gap-2 text-xs text-muted-foreground">
                    {paused > 0 && <span>{paused} of {total} agents paused</span>}
                    {paused > 0 && (
                        <Button size="xs" variant="outline" onClick={() => setConfirm("resume")}>
                            <IconPlayerPlayFilled className="h-3 w-3" aria-hidden />Resume all
                        </Button>
                    )}
                    <Button size="xs" variant="outline" onClick={() => setConfirm("pause")}>
                        <IconPlayerPauseFilled className="h-3 w-3" aria-hidden />Pause all agents
                    </Button>
                </div>
            ) : null}

            <Dialog open={confirm !== null} onOpenChange={(open) => { if (!open && !busy) setConfirm(null); }}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>{confirm === "pause" ? `Pause all ${running} running agent${running === 1 ? "" : "s"}?` : `Resume ${paused} paused agent${paused === 1 ? "" : "s"}?`}</DialogTitle>
                        <DialogDescription>
                            {confirm === "pause"
                                ? "Their runtimes stop starting new work until you resume them. Each agent's pause is recorded in Activity."
                                : "They start taking work again. Agents paused because their monthly budget ran out resume too, and pause again at their next usage report if they are still over budget."}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setConfirm(null)} disabled={busy}>Cancel</Button>
                        <Button variant={confirm === "pause" ? "destructive" : "default"} onClick={() => confirm && void apply(confirm)} disabled={busy}>
                            {busy ? "Working…" : confirm === "pause" ? "Pause all" : "Resume all"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
