"use client";

import { useEffect, useRef, useState } from "react";
import { IconAlertTriangle, IconCircleCheck, IconLoader2 } from "@tabler/icons-react";
import { cn } from "@/lib/utils";

type JobView = {
    id: string;
    command: string;
    status: string;
    error: string | null;
    result: { ok?: boolean; summary?: string | null; logTail?: string | null; exitCode?: number | null; units?: string[] } | null;
    progressTruncated?: boolean;
};
type JobEvent = { seq: number; step: string | null; line: string | null };

const TERMINAL = new Set(["succeeded", "failed", "timed_out", "canceled", "lost"]);
const POLL_MS = 1500;

const STATUS_LABEL: Record<string, string> = {
    queued: "Waiting for the host",
    sent: "Sent to the host",
    running: "Running",
    succeeded: "Done",
    failed: "Failed",
    timed_out: "Timed out",
    canceled: "Canceled",
    lost: "Lost (the host went away)",
};

/**
 * Live progress of a runtime host job: polls GET /api/runtime-host-jobs/[id]
 * while it runs (queued -> sent -> running -> done), shows the latest step and
 * the log lines the host streamed, then the result.
 */
export function JobProgress({ jobId, onDone, className }: { jobId: string; onDone?: (job: JobView) => void; className?: string }) {
    const [job, setJob] = useState<JobView | null>(null);
    const [events, setEvents] = useState<JobEvent[]>([]);
    const [error, setError] = useState<string | null>(null);
    const afterSeq = useRef(0);
    const doneRef = useRef(onDone);
    doneRef.current = onDone;

    useEffect(() => {
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        afterSeq.current = 0;
        setEvents([]);
        const tick = async () => {
            try {
                const res = await fetch(`/api/runtime-host-jobs/${encodeURIComponent(jobId)}?afterSeq=${afterSeq.current}`, { cache: "no-store" });
                if (!res.ok) throw new Error(res.status === 404 ? "Job not found" : "Could not load the job");
                const data = await res.json() as { job: JobView; events: JobEvent[] };
                if (stopped) return;
                setError(null);
                setJob(data.job);
                if (data.events.length > 0) {
                    afterSeq.current = data.events[data.events.length - 1].seq;
                    setEvents((prev) => [...prev, ...data.events].slice(-200));
                }
                if (TERMINAL.has(data.job.status)) {
                    doneRef.current?.(data.job);
                    return;
                }
            } catch (err) {
                if (stopped) return;
                setError(err instanceof Error ? err.message : "Could not load the job");
            }
            if (!stopped) timer = setTimeout(() => void tick(), POLL_MS);
        };
        void tick();
        return () => {
            stopped = true;
            if (timer) clearTimeout(timer);
        };
    }, [jobId]);

    const status = job?.status ?? "queued";
    const finished = TERMINAL.has(status);
    const ok = status === "succeeded";
    const lastStep = [...events].reverse().find((e) => e.step)?.step ?? null;
    const lines = events.filter((e) => e.line).slice(-8);

    return (
        <div className={cn("min-w-0 max-w-full overflow-hidden rounded-xl border border-border bg-muted/30 p-3 text-xs", className)} aria-live="polite">
            <div className="flex items-center gap-2">
                {!finished && <IconLoader2 className="h-4 w-4 animate-spin text-primary" aria-hidden="true" />}
                {finished && ok && <IconCircleCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />}
                {finished && !ok && <IconAlertTriangle className="h-4 w-4 text-destructive" aria-hidden="true" />}
                <span className="font-medium text-foreground">{STATUS_LABEL[status] ?? status}</span>
                {lastStep && !finished && <span className="min-w-0 flex-1 truncate text-muted-foreground">{lastStep}</span>}
            </div>
            {status === "queued" && (
                <p className="mt-1 text-muted-foreground">It starts as soon as the host is online and free.</p>
            )}
            {lines.length > 0 && (
                <pre className="mt-2 max-h-40 overflow-auto max-w-full whitespace-pre-wrap break-all rounded-lg bg-background/60 p-2 font-mono text-[11px] leading-5 text-muted-foreground">
                    {lines.map((e) => e.line).join("\n")}
                </pre>
            )}
            {finished && job?.result?.summary && <p className="mt-2 break-words text-foreground">{job.result.summary}</p>}
            {finished && (job?.result?.units?.length ?? 0) > 0 && (
                <p className="mt-1 text-muted-foreground">Restarted on the host: {job!.result!.units!.join(", ")}</p>
            )}
            {job?.progressTruncated && <p className="mt-1 text-muted-foreground">Only the first lines of this job&apos;s output were kept.</p>}
            {finished && !ok && job?.error && job.error !== job.result?.summary && <p className="mt-1 text-destructive">{job.error}</p>}
            {finished && !ok && job?.result?.logTail && (
                <details className="mt-2">
                    <summary className="cursor-pointer text-muted-foreground">Log tail</summary>
                    <pre className="mt-1 max-h-48 overflow-auto max-w-full whitespace-pre-wrap break-all rounded-lg bg-background/60 p-2 font-mono text-[11px] leading-5 text-muted-foreground">{job.result.logTail}</pre>
                </details>
            )}
            {error && <p role="alert" className="mt-1 text-destructive">{error}</p>}
        </div>
    );
}
