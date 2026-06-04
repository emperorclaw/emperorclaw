"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useMemo, useState } from "react";
import { BadgeCheck, Search, ThumbsDown, ThumbsUp } from "lucide-react";
import { cn } from "@/lib/utils";

type ApprovalItem = any;

const taskInput = (task: any) => task?.inputJson && typeof task.inputJson === "object" ? task.inputJson : {};
const getTaskTitle = (task: any) => {
    const input = taskInput(task);
    return typeof input.title === "string" && input.title.trim() ? input.title.trim() : task?.taskType || "Untitled task";
};

export default function ApprovalsClient({ items }: { items: ApprovalItem[] }) {
    const [query, setQuery] = useState("");
    const [decisionByTaskId, setDecisionByTaskId] = useState<Record<string, "approved" | "rejected" | "pending">>({});
    const [busyTaskId, setBusyTaskId] = useState<string | null>(null);

    const filteredItems = useMemo(() => {
        const normalized = query.trim().toLowerCase();
        if (!normalized) return items;
        return items.filter((item) => {
            const haystack = [
                item.task?.taskType,
                getTaskTitle(item.task),
                taskInput(item.task).description,
                item.task?.state,
                item.project?.goal,
                item.customer?.name,
                item.approval?.status,
                item.approval?.rationale,
                item.requester?.name,
            ]
                .filter(Boolean)
                .join(" ")
                .toLowerCase();
            return haystack.includes(normalized);
        });
    }, [items, query]);

    const counts = filteredItems.reduce(
        (acc, item) => {
            acc.pending += decisionByTaskId[item.task.id] ? 0 : 1;
            acc.approved += decisionByTaskId[item.task.id] === "approved" ? 1 : 0;
            acc.rejected += decisionByTaskId[item.task.id] === "rejected" ? 1 : 0;
            return acc;
        },
        { pending: 0, approved: 0, rejected: 0 },
    );

    const handleDecision = async (item: ApprovalItem, decision: "approved" | "rejected") => {
        if (busyTaskId) return;
        setBusyTaskId(item.task.id);

        try {
            let approvalId = item.approval?.id || null;
            if (!approvalId) {
                const createRes = await fetch("/api/approvals", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        projectId: item.project?.id,
                        taskIds: [item.task.id],
                        rationale: item.approval?.rationale || `Approval requested for task ${item.task.id}`,
                    }),
                });
                if (!createRes.ok) {
                    throw new Error("Failed to create approval");
                }
                const created = await createRes.json();
                approvalId = created.approval?.id || null;
            }

            if (!approvalId) {
                throw new Error("Approval id missing");
            }

            const res = await fetch(`/api/approvals/${approvalId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    status: decision,
                    resolutionNote: decision === "approved"
                        ? `Approval granted in Emperor UI for task ${item.task.id}.`
                        : `Approval rejected in Emperor UI for task ${item.task.id}. Please revise and resubmit.`,
                }),
            });

            if (!res.ok) {
                throw new Error("Failed to resolve approval");
            }

            setDecisionByTaskId((prev) => ({ ...prev, [item.task.id]: decision }));
            window.location.reload();
        } catch (error) {
            console.error("Approval action failed", error);
        } finally {
            setBusyTaskId(null);
        }
    };

    return (
        <div className="mx-auto max-w-7xl space-y-8 animate-in fade-in duration-500">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-2">
                    <h1 className="text-3xl font-semibold tracking-tight text-zinc-100">Approvals</h1>
                    <p className="font-medium text-zinc-500">Durable approval records for task completion and operator decisions.</p>
                </div>
                <div className="relative">
                    <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
                    <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search approvals..." className="w-80 rounded-lg border border-zinc-800 bg-zinc-900/50 py-2 pl-9 pr-4 text-sm text-zinc-200 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/60" />
                </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
                <SummaryCard label="Pending" value={counts.pending} hint="Awaiting decision" />
                <SummaryCard label="Approved" value={counts.approved} hint="Resolved in control plane" accent="emerald" />
                <SummaryCard label="Rejected" value={counts.rejected} hint="Sent back for revision" accent="rose" />
            </div>

            <div className="space-y-3">
                {filteredItems.length === 0 ? (
                    <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/50 p-10 text-center text-zinc-500">
                        <BadgeCheck className="mx-auto mb-3 h-10 w-10 text-zinc-700" />
                        No approval items found.
                    </div>
                ) : (
                    filteredItems.map((item) => {
                        const state = decisionByTaskId[item.task.id] || "pending";
                        const isApproved = state === "approved";
                        const isRejected = state === "rejected";
                        return (
                            <div key={`${item.task.id}-${item.approval?.id || "implicit"}`} className="rounded-xl border border-zinc-800/80 bg-zinc-950/60 p-5">
                                <div className="flex flex-wrap items-start justify-between gap-4">
                                    <div className="space-y-3">
                                        <div className="flex flex-wrap items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em]">
                                            <Chip label={`TASK-${item.task.id.substring(0, 8).toUpperCase()}`} />
                                            <Chip label={item.task.state.replace("_", " ")} tone="slate" />
                                            <Chip label={item.project?.goal || "Unknown Project"} tone="indigo" />
                                            <Chip label={item.customer?.name || "Unknown Customer"} tone="zinc" />
                                            {item.approval?.status && <Chip label={item.approval.status} tone={item.approval.status === "pending" ? "amber" : "emerald"} />}
                                        </div>
                                        <div>
                                            <h3 className="text-lg font-medium text-zinc-200">{getTaskTitle(item.task)}</h3>
                                            <div className="mt-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-600">{item.task.taskType}</div>
                                            <p className="mt-1 text-sm text-zinc-500">
                                                {item.approval?.rationale || "No rationale captured yet."}
                                            </p>
                                            <p className="mt-1 text-xs text-zinc-600">
                                                Requester: {item.requester?.name || "Unknown"} · Lead: {item.task.assignedAgentId || "Unassigned"}
                                            </p>
                                        </div>
                                    </div>

                                    <div className="flex flex-wrap items-center gap-2">
                                        <button
                                            onClick={() => handleDecision(item, "approved")}
                                            disabled={busyTaskId === item.task.id || isApproved}
                                            className={cn(
                                                "flex items-center rounded-md border px-3 py-2 text-sm font-medium transition-colors",
                                                isApproved
                                                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                                                    : "border-emerald-500/20 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20",
                                            )}
                                        >
                                            <ThumbsUp className="mr-2 h-4 w-4" />
                                            {isApproved ? "Approved" : "Approve"}
                                        </button>
                                        <button
                                            onClick={() => handleDecision(item, "rejected")}
                                            disabled={busyTaskId === item.task.id || isRejected}
                                            className={cn(
                                                "flex items-center rounded-md border px-3 py-2 text-sm font-medium transition-colors",
                                                isRejected
                                                    ? "border-rose-500/30 bg-rose-500/10 text-rose-300"
                                                    : "border-rose-500/20 bg-rose-500/10 text-rose-400 hover:bg-rose-500/20",
                                            )}
                                        >
                                            <ThumbsDown className="mr-2 h-4 w-4" />
                                            {isRejected ? "Rejected" : "Reject"}
                                        </button>
                                    </div>
                                </div>

                                <div className="mt-4 grid gap-3 text-xs text-zinc-500 md:grid-cols-3">
                                    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
                                        <div className="font-semibold uppercase tracking-[0.16em] text-zinc-500">Approval record</div>
                                        <div className="mt-1">{item.approval?.status || "implicit pending"}</div>
                                    </div>
                                    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
                                        <div className="font-semibold uppercase tracking-[0.16em] text-zinc-500">Execution state</div>
                                        <div className="mt-1">{item.task.state}</div>
                                    </div>
                                    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
                                        <div className="font-semibold uppercase tracking-[0.16em] text-zinc-500">Last decision</div>
                                        <div className="mt-1">{state}</div>
                                    </div>
                                </div>
                            </div>
                        );
                    })
                )}
            </div>
        </div>
    );
}

function SummaryCard({ label, value, hint, accent = "slate" }: { label: string; value: number; hint: string; accent?: "slate" | "emerald" | "rose" | "amber" }) {
    const tone = {
        slate: "border-zinc-800 bg-zinc-950/50",
        emerald: "border-emerald-500/20 bg-emerald-500/10",
        rose: "border-rose-500/20 bg-rose-500/10",
        amber: "border-amber-500/20 bg-amber-500/10",
    }[accent];

    return (
        <div className={`rounded-xl border p-4 ${tone}`}>
            <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-zinc-500">{label}</div>
            <div className="mt-2 text-2xl font-semibold text-zinc-100">{value}</div>
            <div className="mt-1 text-xs text-zinc-500">{hint}</div>
        </div>
    );
}

function Chip({ label, tone = "slate" }: { label: string; tone?: "slate" | "zinc" | "amber" | "emerald" | "indigo" }) {
    const toneClass = {
        slate: "border-zinc-800 bg-zinc-900 text-zinc-400",
        zinc: "border-zinc-800 bg-zinc-950 text-zinc-300",
        amber: "border-amber-500/20 bg-amber-500/10 text-amber-300",
        emerald: "border-emerald-500/20 bg-emerald-500/10 text-emerald-300",
        indigo: "border-indigo-500/20 bg-indigo-500/10 text-indigo-300",
    }[tone];

    return <span className={cn("rounded border px-2 py-1", toneClass)}>{label}</span>;
}
