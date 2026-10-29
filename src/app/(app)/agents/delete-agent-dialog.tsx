"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { IconTrash } from "@tabler/icons-react";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

type HostRemoval =
    | { status: "queued"; hostName: string; hostOnline: boolean; needsUpdate: boolean }
    | { status: "not_on_host" | "host_gone" | "admin_required" | "skipped" };

export function DeleteAgentDialog({
    agentId,
    agentName,
    redirectToAgents = false,
    host = null,
    trigger,
    onDeleted,
}: {
    agentId: string;
    agentName: string;
    redirectToAgents?: boolean;
    /** The runtime host it runs on (0.22): owners/admins may also remove its profile there (default on). */
    host?: { name: string; canRemove: boolean } | null;
    /** A custom trigger (the default is the "Delete Agent" button). */
    trigger?: ReactNode;
    onDeleted?: () => void;
}) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [confirmation, setConfirmation] = useState("");
    const [isDeleting, setIsDeleting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [removeFromHost, setRemoveFromHost] = useState(true);

    const canDelete = confirmation.trim() === agentName && !isDeleting;

    async function handleDelete() {
        if (!canDelete) return;
        setIsDeleting(true);
        setError(null);

        try {
            const response = await fetch(`/api/agents/${agentId}`, {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ confirmName: confirmation.trim(), ...(host?.canRemove ? { removeFromHost } : {}) }),
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(typeof payload.error === "string" ? payload.error : "Agent deletion failed.");
            }

            const cleanup = payload.cleanup as { warnings?: string[] } | undefined;
            const warnings = Array.isArray(cleanup?.warnings) ? cleanup.warnings : [];
            if (warnings.length > 0) {
                toast.warning("Agent deleted, but its runtime was not fully cleaned up", {
                    description: warnings.join(" "),
                    duration: 10000,
                });
            }

            const removal = payload.hostRemoval as HostRemoval | undefined;
            if (removal?.status === "queued") {
                toast.success(`${agentName} deleted`, {
                    description: removal.needsUpdate
                        ? `Its profile is removed from ${removal.hostName} once that host is updated to 0.22.`
                        : removal.hostOnline
                            ? `Removing its profile from ${removal.hostName}.`
                            : `${removal.hostName} is offline: its profile is removed when it is back.`,
                });
            } else if (removal?.status === "admin_required") {
                toast.warning(`${agentName} deleted`, { description: "Its profile is still on its host: an owner or admin can remove it (emperor-hermes remove)." });
            }

            setOpen(false);
            setConfirmation("");
            onDeleted?.();
            router.refresh();
            if (redirectToAgents) router.push("/agents");
        } catch (deleteError) {
            setError(deleteError instanceof Error ? deleteError.message : "Agent deletion failed.");
        } finally {
            setIsDeleting(false);
        }
    }

    return (
        <Dialog open={open} onOpenChange={(nextOpen) => {
            setOpen(nextOpen);
            if (!nextOpen) {
                setConfirmation("");
                setError(null);
            }
        }}>
            <DialogTrigger asChild>
                {trigger ?? (
                    <Button type="button" variant="destructive" size="sm" className="bg-rose-600/90 hover:bg-rose-500">
                        <IconTrash className="w-4 h-4" />
                        Delete Agent
                    </Button>
                )}
            </DialogTrigger>
            <DialogContent className="sm:max-w-[480px] bg-zinc-950 border-zinc-800 text-zinc-200">
                <DialogHeader>
                    <DialogTitle className="text-zinc-100">Delete {agentName}?</DialogTitle>
                    <DialogDescription className="text-zinc-500">
                        This removes the Emperor agent profile from normal views and deletes its runtime data.
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4">
                    <div className="rounded-lg border border-rose-500/25 bg-rose-500/10 p-3 text-sm leading-6 text-rose-100/90">
                        Deleted: memory entries, snapshots, sessions, action runs, direct chat threads, access logs, and runtime integrations.
                        Detached: assigned tasks, project lead links, approvals, Storage files, Knowledge & Rules, and shared history.
                    </div>
                    {host && host.canRemove && (
                        <label className="flex items-start gap-2 text-sm text-zinc-200">
                            <input type="checkbox" checked={removeFromHost} onChange={(event) => setRemoveFromHost(event.target.checked)}
                                className="mt-1 h-4 w-4 accent-rose-500" />
                            <span>
                                Also remove it from {host.name}
                                <span className="block text-xs text-zinc-500">Its Hermes profile and services there are deleted (when the host is online; it waits if not). Its token stops working right away either way.</span>
                            </span>
                        </label>
                    )}
                    {host && !host.canRemove && (
                        <p className="text-xs text-zinc-500">It runs on {host.name}: an owner or admin removes its profile there.</p>
                    )}
                    <label className="block space-y-2">
                        <span className="text-xs font-bold uppercase tracking-wider text-zinc-500">
                            Type the agent name to confirm
                        </span>
                        <input
                            value={confirmation}
                            onChange={(event) => setConfirmation(event.target.value)}
                            placeholder={agentName}
                            className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:ring-1 focus:ring-rose-500"
                        />
                    </label>
                    {error && (
                        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
                            {error}
                        </div>
                    )}
                </div>

                <DialogFooter>
                    <Button type="button" variant="outline" onClick={() => setOpen(false)} className="border-zinc-800 text-zinc-300 hover:bg-zinc-800">
                        Cancel
                    </Button>
                    <Button type="button" variant="destructive" onClick={handleDelete} disabled={!canDelete}>
                        {isDeleting ? "Deleting..." : "Delete agent and data"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
