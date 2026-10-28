"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { IconCircleCheck, IconFlask, IconLoader2, IconTrash } from "@tabler/icons-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/**
 * Onboarding offer: "Add a sample client to explore". Rendered only when the
 * server said the workspace may have one (owner/admin, no customers yet).
 */
export function SampleClientOffer() {
    const router = useRouter();
    const [state, setState] = useState<"idle" | "adding" | "added">("idle");

    async function add() {
        setState("adding");
        try {
            const res = await fetch("/api/onboarding/sample-client", { method: "POST" });
            const data = await res.json().catch(() => ({})) as { error?: string };
            if (!res.ok) throw new Error(data.error || "Could not add the sample client.");
            setState("added");
            router.refresh();
        } catch (error) {
            setState("idle");
            toast.error(error instanceof Error ? error.message : "Could not add the sample client.");
        }
    }

    return (
        <div className="flex w-full flex-wrap items-center gap-3 rounded-2xl border border-dashed border-border bg-muted/30 p-4 text-left">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                {state === "added" ? <IconCircleCheck className="h-5 w-5 text-emerald-700 dark:text-emerald-300" aria-hidden /> : <IconFlask className="h-5 w-5" aria-hidden />}
            </span>
            <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">{state === "added" ? "Sample: Harbor Dental is ready to explore" : "Add a sample client to explore"}</p>
                <p className="text-xs leading-5 text-muted-foreground">
                    {state === "added"
                        ? <>A customer, a project with three tasks, and a note. <Link href="/projects" className="text-primary hover:underline">See it on the board</Link>; remove it any time in Settings.</>
                        : "A labelled practice client with one project, three tasks in different states and a note. Nothing runs on it, and Settings removes it in one click."}
                </p>
            </div>
            {state !== "added" && (
                <Button size="sm" variant="outline" onClick={() => void add()} disabled={state === "adding"}>
                    {state === "adding" && <IconLoader2 className="h-4 w-4 animate-spin" aria-hidden />}
                    {state === "adding" ? "Adding…" : "Add sample client"}
                </Button>
            )}
        </div>
    );
}

/** Settings: shown to owners/admins only while sample rows exist. */
export function SampleDataCard() {
    const router = useRouter();
    const [hasSample, setHasSample] = useState(false);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        let cancelled = false;
        fetch("/api/onboarding/sample-client", { cache: "no-store" })
            .then((res) => res.ok ? res.json() : null)
            .then((data: { hasSample?: boolean } | null) => { if (!cancelled) setHasSample(Boolean(data?.hasSample)); })
            .catch(() => undefined);
        return () => { cancelled = true; };
    }, []);

    if (!hasSample) return null;

    async function remove() {
        setBusy(true);
        try {
            const res = await fetch("/api/onboarding/sample-client", { method: "DELETE" });
            const data = await res.json().catch(() => ({})) as { error?: string; removed?: { keptProjects?: number; keptCustomers?: number } };
            if (!res.ok) throw new Error(data.error || "Could not remove the sample data.");
            const kept = (data.removed?.keptProjects ?? 0) + (data.removed?.keptCustomers ?? 0);
            toast.success(kept > 0 ? "Sample data removed. Work you added to the sample project was kept." : "Sample data removed.");
            setHasSample(false);
            router.refresh();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Could not remove the sample data.");
        } finally {
            setBusy(false);
        }
    }

    return (
        <section aria-label="Sample data" className="flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-card p-4">
            <IconFlask className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">This workspace has sample data</p>
                <p className="text-xs leading-5 text-muted-foreground">Sample: Harbor Dental, its project, three tasks and a note, added during setup. Removing deletes only those rows; anything you added yourself stays.</p>
            </div>
            <Button size="sm" variant="outline" onClick={() => void remove()} disabled={busy}>
                {busy ? <IconLoader2 className="h-4 w-4 animate-spin" aria-hidden /> : <IconTrash className="h-4 w-4" aria-hidden />}{busy ? "Removing…" : "Remove sample data"}
            </Button>
        </section>
    );
}
