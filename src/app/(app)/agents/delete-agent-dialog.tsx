"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
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

export function DeleteAgentDialog({
    agentId,
    agentName,
    redirectToAgents = false,
}: {
    agentId: string;
    agentName: string;
    redirectToAgents?: boolean;
}) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [confirmation, setConfirmation] = useState("");
    const [isDeleting, setIsDeleting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const canDelete = confirmation.trim() === agentName && !isDeleting;

    async function handleDelete() {
        if (!canDelete) return;
        setIsDeleting(true);
        setError(null);

        try {
            const response = await fetch(`/api/agents/${agentId}`, {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ confirmName: confirmation.trim() }),
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(typeof payload.error === "string" ? payload.error : "Agent deletion failed.");
            }

            setOpen(false);
            setConfirmation("");
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
                <Button type="button" variant="destructive" size="sm" className="bg-rose-600/90 hover:bg-rose-500">
                    <Trash2 className="w-4 h-4" />
                    Delete Agent
                </Button>
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
