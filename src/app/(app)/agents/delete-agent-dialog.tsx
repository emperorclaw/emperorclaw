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
import { useTranslations } from "next-intl";

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
    const t = useTranslations("agents.delete");
    const tc = useTranslations("common");
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
                throw new Error(typeof payload.error === "string" ? payload.error : t("failed"));
            }

            const cleanup = payload.cleanup as { warnings?: string[] } | undefined;
            const warnings = Array.isArray(cleanup?.warnings) ? cleanup.warnings : [];
            if (warnings.length > 0) {
                toast.warning(t("partialCleanup"), {
                    description: warnings.join(" "),
                    duration: 10000,
                });
            }

            const removal = payload.hostRemoval as HostRemoval | undefined;
            if (removal?.status === "queued") {
                toast.success(t("deleted", { name: agentName }), {
                    description: removal.needsUpdate
                        ? t("removedAfterUpdate", { host: removal.hostName })
                        : removal.hostOnline
                            ? t("removingFromHost", { host: removal.hostName })
                            : t("hostOffline", { host: removal.hostName }),
                });
            } else if (removal?.status === "admin_required") {
                toast.warning(t("deleted", { name: agentName }), { description: t("adminRequired") });
            }

            setOpen(false);
            setConfirmation("");
            onDeleted?.();
            router.refresh();
            if (redirectToAgents) router.push("/agents");
        } catch (deleteError) {
            setError(deleteError instanceof Error ? deleteError.message : t("failed"));
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
                        {t("button")}
                    </Button>
                )}
            </DialogTrigger>
            <DialogContent className="sm:max-w-[480px] bg-zinc-950 border-zinc-800 text-zinc-200">
                <DialogHeader>
                    <DialogTitle className="text-zinc-100">{t("title", { name: agentName })}</DialogTitle>
                    <DialogDescription className="text-zinc-500">
                        {t("description")}
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4">
                    <div className="rounded-lg border border-rose-500/25 bg-rose-500/10 p-3 text-sm leading-6 text-rose-100/90">
                        {t("whatIsDeleted")}
                    </div>
                    {host && host.canRemove && (
                        <label className="flex items-start gap-2 text-sm text-zinc-200">
                            <input type="checkbox" checked={removeFromHost} onChange={(event) => setRemoveFromHost(event.target.checked)}
                                className="mt-1 h-4 w-4 accent-rose-500" />
                            <span>
                                {t("alsoRemove", { host: host.name })}
                                <span className="block text-xs text-zinc-500">{t("alsoRemoveHint")}</span>
                            </span>
                        </label>
                    )}
                    {host && !host.canRemove && (
                        <p className="text-xs text-zinc-500">{t("adminRemoves", { host: host.name })}</p>
                    )}
                    <label className="block space-y-2">
                        <span className="text-xs font-bold uppercase tracking-wider text-zinc-500">
                            {t("typeName")}
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
                        {tc("cancel")}
                    </Button>
                    <Button type="button" variant="destructive" onClick={handleDelete} disabled={!canDelete}>
                        {isDeleting ? t("deleting") : t("confirm")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
