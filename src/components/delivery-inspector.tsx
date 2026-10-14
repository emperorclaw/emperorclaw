"use client";

import { memo, useCallback, useState } from "react";
import {
    IconRoute,
    IconCircleCheck,
    IconCircleX,
    IconLoader2,
    IconRefresh,
} from "@tabler/icons-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RunStatusChip } from "@/components/run-status-chip";
import { agentAvatarSrc } from "@/lib/avatar";
import { cn } from "@/lib/utils";
import {
    NO_DELIVERY_VERDICT_COPY,
    deliveryVerdictCopy,
    formatRunDuration,
    formatRunTokens,
    triggerKindLabel,
} from "@/lib/run-ledger-copy";

/**
 * A message's stored delivery verdicts and the runs they triggered, behind a
 * discreet "Delivery" action. Lazy: the panel fetches `GET
 * /api/messages/[id]/delivery` only when first opened, so the chat poll never
 * pays for a panel nobody is reading. The panel lives in a portal, so it never
 * changes the virtualized message row's height.
 */

interface DeliveryRun {
    id: string;
    agentId: string | null;
    status: string;
    triggerKind: string | null;
    startedAt: string;
    durationMs: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    costCents: number | null;
    toolCalls: number | null;
    error: string | null;
}

interface DeliveryVerdict {
    agentId: string;
    agentName: string | null;
    addressed: boolean;
    routeReason: string;
    agentStreak: number;
    maxTurns: number;
    decidedAt: string;
}

interface DeliveryView {
    verdicts: DeliveryVerdict[];
    runs: DeliveryRun[];
}

function RunLine({ run }: { run: DeliveryRun }) {
    return (
        <div className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 p-2">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <RunStatusChip status={run.status} />
                <span className="text-[11px] tabular-nums text-zinc-400">{formatRunDuration(run.durationMs)}</span>
                <span className="text-[11px] tabular-nums text-zinc-400">{formatRunTokens(run.inputTokens, run.outputTokens)}</span>
                {run.toolCalls !== null && (
                    <span className="text-[11px] text-zinc-500">
                        {run.toolCalls} {run.toolCalls === 1 ? "tool" : "tools"}
                    </span>
                )}
                <span className="text-[11px] text-zinc-500">{triggerKindLabel(run.triggerKind)}</span>
            </div>
            {run.error && <p className="mt-1 break-words text-[11px] text-rose-300">{run.error}</p>}
        </div>
    );
}

function DeliveryInspectorImpl({ messageId, tone = "dark" }: { messageId: string; tone?: "dark" | "light" }) {
    const [open, setOpen] = useState(false);
    const [data, setData] = useState<DeliveryView | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(`/api/messages/${encodeURIComponent(messageId)}/delivery`);
            if (!res.ok) throw new Error(res.status === 404 ? "Message not found" : "Could not load delivery");
            const json = (await res.json()) as Partial<DeliveryView>;
            setData({ verdicts: json.verdicts ?? [], runs: json.runs ?? [] });
        } catch (e) {
            setError(e instanceof Error ? e.message : "Could not load delivery");
        } finally {
            setLoading(false);
        }
    }, [messageId]);

    const onOpenChange = (next: boolean) => {
        setOpen(next);
        if (next && data === null && !loading) void load();
    };

    return (
        <Popover open={open} onOpenChange={onOpenChange}>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    aria-label="Show delivery details for this message"
                    className={cn(
                        "inline-flex items-center gap-1 rounded-md text-[10px] font-medium uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-0",
                        tone === "light"
                            ? "text-emerald-950/70 hover:text-emerald-950 focus-visible:ring-emerald-950/60"
                            : "text-zinc-600 hover:text-cyan-300 focus-visible:ring-cyan-400/60",
                    )}
                >
                    <IconRoute className="h-3 w-3" aria-hidden="true" />
                    Delivery
                </button>
            </PopoverTrigger>
            <PopoverContent aria-label="Delivery details" align="start" className="w-[22rem] p-0">
                <div className="flex items-center justify-between gap-2 border-b border-zinc-800 px-3 py-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-300">Delivery</h3>
                    <button
                        type="button"
                        onClick={() => void load()}
                        disabled={loading}
                        aria-label="Refresh delivery details"
                        className="inline-flex h-6 w-6 items-center justify-center rounded-md text-zinc-500 transition-colors hover:text-cyan-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60 disabled:opacity-50"
                    >
                        <IconRefresh className={cn("h-3.5 w-3.5", loading && "animate-spin motion-reduce:animate-none")} aria-hidden="true" />
                    </button>
                </div>
                <div className="max-h-[60vh] overflow-y-auto p-3">
                    {loading && data === null && (
                        <p className="flex items-center gap-2 text-[11px] text-zinc-500">
                            <IconLoader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                            Loading delivery…
                        </p>
                    )}
                    {error && (
                        <p className="text-[11px] text-amber-400" role="alert">{error}</p>
                    )}
                    {data && <DeliveryBody data={data} />}
                </div>
            </PopoverContent>
        </Popover>
    );
}

/**
 * Memoized: a chat row re-renders on every poll, and without this each
 * re-render would walk every visible bubble's trigger and its popover state.
 * The state lives here, in the child, so only the row that actually changed
 * re-renders.
 */
export const DeliveryInspector = memo(DeliveryInspectorImpl);

function DeliveryBody({ data }: { data: DeliveryView }) {
    const runsByAgent = new Map<string, DeliveryRun[]>();
    for (const run of data.runs) {
        if (!run.agentId) continue;
        const list = runsByAgent.get(run.agentId) ?? [];
        list.push(run);
        runsByAgent.set(run.agentId, list);
    }
    const verdictAgentIds = new Set(data.verdicts.map((v) => v.agentId));
    const orphanRuns = data.runs.filter((run) => !run.agentId || !verdictAgentIds.has(run.agentId));

    return (
        <div className="space-y-2.5">
            {data.verdicts.map((verdict) => {
                const copy = deliveryVerdictCopy(verdict);
                const runs = runsByAgent.get(verdict.agentId) ?? [];
                return (
                    <div key={verdict.agentId} className="rounded-xl border border-zinc-800/80 bg-zinc-900/30 p-2.5">
                        <div className="flex items-center gap-2">
                            <img
                                src={agentAvatarSrc({ id: verdict.agentId })}
                                alt=""
                                className="h-6 w-6 shrink-0 rounded-full border border-zinc-700 object-cover"
                            />
                            <span className="truncate text-xs font-medium text-zinc-200">{verdict.agentName || "Agent"}</span>
                        </div>
                        <p className={cn(
                            "mt-1.5 flex items-start gap-1.5 text-[11px]",
                            copy.outcome === "delivered" ? "text-emerald-300" : "text-rose-300",
                        )}>
                            {copy.outcome === "delivered"
                                ? <IconCircleCheck className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                : <IconCircleX className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
                            <span className="min-w-0">{copy.label}</span>
                        </p>
                        {runs.length > 0 && (
                            <div className="mt-2 space-y-1.5">
                                {runs.map((run) => <RunLine key={run.id} run={run} />)}
                            </div>
                        )}
                    </div>
                );
            })}

            {orphanRuns.length > 0 && (
                <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/30 p-2.5">
                    <p className="text-[11px] font-medium text-zinc-400">Triggered runs</p>
                    <div className="mt-2 space-y-1.5">
                        {orphanRuns.map((run) => <RunLine key={run.id} run={run} />)}
                    </div>
                </div>
            )}

            {data.verdicts.length === 0 && data.runs.length === 0 && (
                <p className="text-[11px] leading-relaxed text-zinc-500">{NO_DELIVERY_VERDICT_COPY}</p>
            )}
        </div>
    );
}
