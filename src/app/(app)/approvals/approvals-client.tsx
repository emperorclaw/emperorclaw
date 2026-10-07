"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { IconArrowRight, IconCheck, IconClockHour4, IconRosetteDiscountCheck, IconSearch, IconX } from "@tabler/icons-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { agentAvatarSrc } from "@/lib/avatar";
import { cn } from "@/lib/utils";

export type ApprovalItem = {
    key: string;
    approvalId: string | null;
    status: "pending" | "approved" | "rejected";
    actionType: string;
    rationale: string | null;
    resolutionNote: string | null;
    requestedAt: string;
    resolvedAt: string | null;
    resolverName: string | null;
    requester: { id: string; name: string; avatarUrl: string | null } | null;
    task: { id: string; projectId: string; title: string; description: string | null; state: string; assignee: string | null };
    projectName: string | null;
    customerName: string | null;
};

const ACTION_LABEL: Record<string, string> = {
    task_done: "Close the task",
    send_email: "Send an email",
    spend: "Spend money",
    publish: "Publish",
    delete: "Delete",
};

function ago(iso: string): string {
    const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`;
    return `${Math.round(minutes / 1440)}d ago`;
}

function taskHref(item: ApprovalItem) {
    return `/projects?project=${item.task.projectId}&task=${item.task.id}`;
}

function Avatar({ requester }: { requester: ApprovalItem["requester"] }) {
    if (!requester) return <span className="h-8 w-8 shrink-0 rounded-full bg-zinc-800" />;
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={agentAvatarSrc(requester)} alt="" className="h-8 w-8 shrink-0 rounded-full border border-zinc-800 bg-zinc-900 object-cover" />;
}

function PendingCard({ item, onDecide, busy }: { item: ApprovalItem; onDecide: (item: ApprovalItem, decision: "approved" | "rejected", note: string) => void; busy: boolean }) {
    const [note, setNote] = useState("");
    const [rejecting, setRejecting] = useState(false);
    const action = ACTION_LABEL[item.actionType] ?? item.actionType.replace(/_/g, " ");
    return (
        <article className="emperor-panel rounded-2xl p-4 sm:p-5">
            <div className="flex items-start gap-3">
                <Avatar requester={item.requester} />
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500">
                        <span className="font-medium text-zinc-300">{item.requester?.name ?? "An agent"}</span>
                        <span>asks to</span>
                        <span className="rounded-md border border-amber-500/25 bg-amber-500/10 px-1.5 py-0.5 font-medium text-amber-200">{action}</span>
                        <span className="inline-flex items-center gap-1"><IconClockHour4 className="h-3 w-3" />{ago(item.requestedAt)}</span>
                    </div>
                    <Link href={taskHref(item)} className="group mt-1.5 inline-flex max-w-full items-center gap-1.5 text-base font-semibold text-zinc-100 hover:text-zinc-50">
                        <span className="truncate">{item.task.title}</span>
                        <IconArrowRight className="h-4 w-4 shrink-0 text-zinc-600 transition-transform group-hover:translate-x-0.5 group-hover:text-zinc-300" />
                    </Link>
                    <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-zinc-500">
                        {item.projectName && <span>{item.projectName}</span>}
                        {item.customerName && <span>· {item.customerName}</span>}
                        <span>· {item.task.assignee ? `Owner: ${item.task.assignee}` : "No owner"}</span>
                        <span>· {item.task.state.replace(/_/g, " ")}</span>
                    </div>
                    <div className="mt-3 rounded-xl border border-zinc-800 bg-zinc-950/50 px-3.5 py-2.5 text-sm text-zinc-300">
                        {item.rationale
                            ? <MarkdownRenderer content={item.rationale} className="[&_.markdown-content>div:last-child]:mb-0" />
                            : <span className="text-zinc-500">{item.approvalId ? "No reason given." : "This task requires approval before it can be closed; no request has been made yet."}</span>}
                    </div>
                    {item.task.description && (
                        <details className="mt-2 text-xs text-zinc-500">
                            <summary className="cursor-pointer select-none hover:text-zinc-300">Task description</summary>
                            <p className="mt-1.5 whitespace-pre-wrap leading-relaxed">{item.task.description}</p>
                        </details>
                    )}
                </div>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-zinc-800/80 pt-3.5">
                <input
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder={rejecting ? "What should change? (sent to the agent)" : "Note for the agent (optional)"}
                    aria-label="Note for the agent"
                    className={cn("h-9 min-w-0 flex-1 rounded-lg border bg-zinc-900 px-3 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-cyan-400/60", rejecting ? "border-rose-500/40" : "border-zinc-700")}
                />
                {rejecting ? (
                    <>
                        <button type="button" disabled={busy || !note.trim()} onClick={() => onDecide(item, "rejected", note)} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-rose-500/20 px-3 text-sm font-medium text-rose-200 hover:bg-rose-500/30 disabled:opacity-50">
                            <IconX className="h-4 w-4" />Send back
                        </button>
                        <button type="button" onClick={() => setRejecting(false)} className="h-9 rounded-lg px-2 text-sm text-zinc-500 hover:text-zinc-200">Cancel</button>
                    </>
                ) : (
                    <>
                        <button type="button" disabled={busy} onClick={() => setRejecting(true)} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-zinc-700 px-3 text-sm text-zinc-300 hover:border-rose-500/40 hover:text-rose-200 disabled:opacity-50">
                            <IconX className="h-4 w-4" />Reject
                        </button>
                        <button type="button" disabled={busy} onClick={() => onDecide(item, "approved", note)} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-emerald-500 px-3.5 text-sm font-semibold text-emerald-950 hover:bg-emerald-400 disabled:opacity-50">
                            <IconCheck className="h-4 w-4" />Approve
                        </button>
                    </>
                )}
            </div>
        </article>
    );
}

function ResolvedRow({ item }: { item: ApprovalItem }) {
    const approved = item.status === "approved";
    return (
        <li>
            <Link href={taskHref(item)} className="flex items-center gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-zinc-900">
                <span className={cn("grid h-6 w-6 shrink-0 place-items-center rounded-full", approved ? "bg-emerald-500/15 text-emerald-300" : "bg-rose-500/15 text-rose-300")}>
                    {approved ? <IconCheck className="h-3.5 w-3.5" /> : <IconX className="h-3.5 w-3.5" />}
                </span>
                <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-zinc-200">{item.task.title}</span>
                    <span className="block truncate text-xs text-zinc-500">
                        {approved ? "Approved" : "Rejected"}{item.resolverName ? ` by ${item.resolverName}` : ""}{item.resolutionNote ? ` — "${item.resolutionNote}"` : ""}
                    </span>
                </span>
                <span className="shrink-0 text-[11px] text-zinc-600">{item.resolvedAt ? ago(item.resolvedAt) : ""}</span>
            </Link>
        </li>
    );
}

/** What agents are waiting on you to decide, with what you need to decide it. */
export default function ApprovalsClient({ items }: { items: ApprovalItem[] }) {
    const router = useRouter();
    const [query, setQuery] = useState("");
    const [busyKey, setBusyKey] = useState<string | null>(null);

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return items;
        return items.filter((i) => [i.task.title, i.task.description, i.rationale, i.projectName, i.customerName, i.requester?.name, i.task.assignee]
            .filter(Boolean).join(" ").toLowerCase().includes(q));
    }, [items, query]);
    const pending = filtered.filter((i) => i.status === "pending").sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
    const resolved = filtered.filter((i) => i.status !== "pending").sort((a, b) => (b.resolvedAt ?? "").localeCompare(a.resolvedAt ?? "")).slice(0, 30);

    const decide = async (item: ApprovalItem, decision: "approved" | "rejected", note: string) => {
        setBusyKey(item.key);
        try {
            let approvalId = item.approvalId;
            if (!approvalId) {
                const created = await fetch("/api/approvals", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ projectId: item.task.projectId, taskIds: [item.task.id], rationale: "Approval decided directly in Emperor." }),
                });
                if (!created.ok) throw new Error("Couldn't create the approval");
                approvalId = (await created.json()).approval?.id ?? null;
            }
            if (!approvalId) throw new Error("Approval id missing");
            const res = await fetch(`/api/approvals/${approvalId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ status: decision, resolutionNote: note.trim() || null }),
            });
            if (!res.ok) throw new Error("Couldn't record the decision");
            toast.success(decision === "approved" ? `Approved. ${item.requester?.name ?? "The agent"} has been told.` : `Sent back to ${item.requester?.name ?? "the agent"} with your note.`);
            router.refresh();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Something went wrong");
        } finally {
            setBusyKey(null);
        }
    };

    return (
        <div className="mx-auto max-w-[1800px] space-y-6 animate-in fade-in duration-500">
            <PageHeader
                eyebrow="Approvals"
                title="Decision Queue"
                description="Agents ask before they spend, send anything outside the company, publish, delete, or close work that needs sign-off. Your decision and note go straight back to the agent."
                actions={
                    <div className="relative">
                        <IconSearch className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
                        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search approvals…" aria-label="Search approvals" className="w-full rounded-xl border border-zinc-800 bg-zinc-950/80 py-2 pl-9 pr-4 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-cyan-400/60 sm:w-72" />
                    </div>
                }
            />

            <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
            <section className="min-w-0 space-y-3">
                <h2 className="text-sm font-semibold text-zinc-300">Waiting on you <span className="ml-1 rounded-full bg-zinc-800 px-2 py-0.5 text-xs tabular-nums text-zinc-400">{pending.length}</span></h2>
                {pending.length === 0 ? (
                    <div className="emperor-panel rounded-2xl p-10 text-center text-sm text-zinc-500">
                        <IconRosetteDiscountCheck className="mx-auto mb-3 h-10 w-10 text-zinc-700" />
                        Nothing is waiting on you.
                    </div>
                ) : pending.map((item) => <PendingCard key={item.key} item={item} onDecide={decide} busy={busyKey === item.key} />)}
            </section>

            <section className="emperor-panel h-fit rounded-2xl p-4">
                <h2 className="mb-1 px-2 text-sm font-semibold text-zinc-300">Recently decided</h2>
                {resolved.length > 0
                    ? <ul className="divide-y divide-zinc-800/70">{resolved.map((item) => <ResolvedRow key={item.key} item={item} />)}</ul>
                    : <p className="px-2 py-4 text-xs text-zinc-500">Decisions you make show up here.</p>}
            </section>
            </div>
        </div>
    );
}
