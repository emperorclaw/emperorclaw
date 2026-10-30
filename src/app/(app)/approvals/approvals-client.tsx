"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { IconArchive, IconArrowRight, IconCheck, IconClockHour4, IconRosetteDiscountCheck, IconSearch, IconX } from "@tabler/icons-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { agentAvatarSrc } from "@/lib/avatar";
import { approvalAgeDays, isStaleApproval } from "@/lib/approval-status";
import { ACTION_CATALOG } from "@/lib/action-policy";
import { cn } from "@/lib/utils";

export type ApprovalItem = {
    key: string;
    approvalId: string | null;
    status: "pending" | "approved" | "rejected" | "dismissed" | "expired";
    actionType: string;
    rationale: string | null;
    resolutionNote: string | null;
    requestedAt: string;
    resolvedAt: string | null;
    resolverName: string | null;
    requester: { id: string; name: string; avatarUrl: string | null } | null;
    /** Null for an agent asking to run one action (an "ask first" permission), which has `action` instead. */
    task: { id: string; projectId: string; title: string; description: string | null; state: string; assignee: string | null } | null;
    /** The action and its key arguments (already redacted) for an "ask first" permission. */
    action: { key: string; label: string; args: { field: string; value: string }[] } | null;
    /** Every live task this approval covers (deciding it resolves them all); the card's task is the first. */
    linkedTasks: { id: string; projectId: string; title: string }[];
    projectName: string | null;
    customerName: string | null;
};

const ACTION_TYPES = new Set(["task_done", "send_email", "spend", "publish", "delete"]);
const CATALOG_KEYS = new Set(ACTION_CATALOG.map((entry) => entry.key));
const TASK_STATES = new Set(["inbox", "queued", "in_progress", "review", "blocked", "done", "failed", "dead_letter"]);

function useAgo() {
    const t = useTranslations("time");
    return (iso: string): string => {
        const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
        if (minutes < 1) return t("justNow");
        if (minutes < 60) return t("minutesAgo", { count: minutes });
        if (minutes < 60 * 24) return t("hoursAgo", { count: Math.round(minutes / 60) });
        return t("daysAgo", { count: Math.round(minutes / 1440) });
    };
}

/** The action an approval is for: the catalog's label for an "ask first" action, else the approval type. */
function useActionLabel() {
    const t = useTranslations("approvals.actions");
    const tCatalog = useTranslations("agents.actions.catalog");
    return (item: ApprovalItem): string => {
        if (item.action) return CATALOG_KEYS.has(item.action.key) ? tCatalog(item.action.key as "send_email") : item.action.label;
        return ACTION_TYPES.has(item.actionType) ? t(item.actionType as "spend") : item.actionType.replace(/_/g, " ");
    };
}

function taskHref(task: NonNullable<ApprovalItem["task"]>) {
    return `/projects?project=${task.projectId}&task=${task.id}`;
}

/** The arguments an agent wants to run an action with, as a short field / value list. */
function ActionArgs({ args }: { args: { field: string; value: string }[] }) {
    const t = useTranslations("approvals");
    if (args.length === 0) return <span className="text-muted-foreground">{t("noDetails")}</span>;
    return (
        <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1">
            {args.map((arg, i) => (
                <div key={`${arg.field}-${i}`} className="contents">
                    <dt className="truncate font-mono text-xs leading-5 text-muted-foreground">{arg.field}</dt>
                    <dd className="min-w-0 whitespace-pre-wrap break-words text-sm text-foreground">{arg.value}</dd>
                </div>
            ))}
        </dl>
    );
}

function Avatar({ requester }: { requester: ApprovalItem["requester"] }) {
    if (!requester) return <span className="h-8 w-8 shrink-0 rounded-full bg-zinc-800" />;
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={agentAvatarSrc(requester)} alt="" className="h-8 w-8 shrink-0 rounded-full border border-zinc-800 bg-zinc-900 object-cover" />;
}

type Decision = "approved" | "rejected" | "dismissed";

function PendingCard({ item, onDecide, busy }: { item: ApprovalItem; onDecide: (item: ApprovalItem, decision: Decision, note: string) => void; busy: boolean }) {
    const [note, setNote] = useState("");
    const [rejecting, setRejecting] = useState(false);
    const [confirming, setConfirming] = useState(false);
    const [confirmDays, setConfirmDays] = useState(0);
    const t = useTranslations("approvals");
    const tStates = useTranslations("tasks.states");
    const ago = useAgo();
    const action = useActionLabel()(item);
    const requestedAtMs = new Date(item.requestedAt).getTime();
    const requester = item.requester?.name ?? t("theAgent");
    // The clock is read in the click handler, never during render (React purity).
    const approve = () => {
        const now = Date.now();
        if (isStaleApproval(requestedAtMs, now)) {
            setConfirmDays(approvalAgeDays(requestedAtMs, now));
            setConfirming(true);
        } else {
            onDecide(item, "approved", note);
        }
    };
    return (
        <article className="emperor-panel rounded-2xl p-4 sm:p-5">
            <div className="flex items-start gap-3">
                <Avatar requester={item.requester} />
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500">
                        <span className="font-medium text-zinc-300">{item.requester?.name ?? t("anAgent")}</span>
                        <span>{t("asksTo")}</span>
                        <span className="rounded-md border border-amber-500/25 bg-amber-500/10 px-1.5 py-0.5 font-medium text-amber-200">{action}</span>
                        <span className="inline-flex items-center gap-1"><IconClockHour4 className="h-3 w-3" />{ago(item.requestedAt)}</span>
                    </div>
                    {item.task ? (
                        <Link href={taskHref(item.task)} className="group mt-1.5 inline-flex max-w-full items-center gap-1.5 text-base font-semibold text-zinc-100 hover:text-zinc-50">
                            <span className="truncate">{item.task.title}</span>
                            <IconArrowRight className="h-4 w-4 shrink-0 text-zinc-600 transition-transform group-hover:translate-x-0.5 group-hover:text-zinc-300" />
                        </Link>
                    ) : (
                        <p className="mt-1.5 text-base font-semibold text-foreground">{t("once", { action })}</p>
                    )}
                    {item.linkedTasks.length > 1 && (
                        <div className="mt-1.5 text-xs text-zinc-400">
                            <p className="font-medium text-amber-200">{t("covers", { count: item.linkedTasks.length })}</p>
                            <ul className="mt-1 space-y-0.5">
                                {item.linkedTasks.map((linked) => (
                                    <li key={linked.id} className="truncate">
                                        <Link href={`/projects?project=${linked.projectId}&task=${linked.id}`} className="hover:text-zinc-200">· {linked.title}</Link>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                    {item.task ? (
                        <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-zinc-500">
                            {item.projectName && <span>{item.projectName}</span>}
                            {item.customerName && <span>· {item.customerName}</span>}
                            <span>· {item.task.assignee ? t("owner", { name: item.task.assignee }) : t("noOwner")}</span>
                            <span>· {TASK_STATES.has(item.task.state) ? tStates(item.task.state as "inbox") : item.task.state.replace(/_/g, " ")}</span>
                        </div>
                    ) : (
                        <p className="mt-0.5 text-xs text-muted-foreground">
                            {t("askFirstHint")}
                        </p>
                    )}
                    {item.action ? (
                        <div className="mt-3 rounded-xl border border-border bg-muted/40 px-3.5 py-2.5">
                            <ActionArgs args={item.action.args} />
                        </div>
                    ) : (
                        <div className="mt-3 rounded-xl border border-zinc-800 bg-zinc-950/50 px-3.5 py-2.5 text-sm text-zinc-300">
                            {item.rationale
                                ? <MarkdownRenderer content={item.rationale} className="[&_.markdown-content>div:last-child]:mb-0" />
                                : <span className="text-zinc-500">{item.approvalId ? t("noReason") : t("noRequestYet")}</span>}
                        </div>
                    )}
                    {item.task?.description && (
                        <details className="mt-2 text-xs text-zinc-500">
                            <summary className="cursor-pointer select-none hover:text-zinc-300">{t("taskDescription")}</summary>
                            <p className="mt-1.5 whitespace-pre-wrap leading-relaxed">{item.task.description}</p>
                        </details>
                    )}
                </div>
            </div>
            {confirming ? (
                <div role="alertdialog" aria-label={t("staleLabel")} className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3.5">
                    <p className="text-sm text-amber-100">{t("staleQuestion", { days: confirmDays, name: requester })}</p>
                    <div className="mt-2.5 flex flex-wrap items-center gap-2">
                        <button type="button" disabled={busy} onClick={() => onDecide(item, "approved", note)} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-emerald-500 px-3.5 text-sm font-semibold text-emerald-950 hover:bg-emerald-400 disabled:opacity-50">
                            <IconCheck className="h-4 w-4" />{t("approveAnyway")}
                        </button>
                        <button type="button" disabled={busy} onClick={() => onDecide(item, "dismissed", note)} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-zinc-700 px-3 text-sm text-zinc-300 hover:border-zinc-500 hover:text-zinc-100 disabled:opacity-50">
                            <IconArchive className="h-4 w-4" />{t("dismissInstead")}
                        </button>
                        <button type="button" onClick={() => setConfirming(false)} className="h-9 rounded-lg px-2 text-sm text-zinc-500 hover:text-zinc-200">{t("cancel")}</button>
                    </div>
                </div>
            ) : (
                <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-zinc-800/80 pt-3.5">
                    <input
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        placeholder={rejecting ? t("rejectPlaceholder") : t("notePlaceholder")}
                        aria-label={t("noteLabel")}
                        className={cn("h-9 min-w-0 flex-1 rounded-lg border bg-zinc-900 px-3 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-cyan-400/60", rejecting ? "border-rose-500/40" : "border-zinc-700")}
                    />
                    {rejecting ? (
                        <>
                            <button type="button" disabled={busy || !note.trim()} onClick={() => onDecide(item, "rejected", note)} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-rose-500/20 px-3 text-sm font-medium text-rose-200 hover:bg-rose-500/30 disabled:opacity-50">
                                <IconX className="h-4 w-4" />{t("sendBack")}
                            </button>
                            <button type="button" onClick={() => setRejecting(false)} className="h-9 rounded-lg px-2 text-sm text-zinc-500 hover:text-zinc-200">{t("cancel")}</button>
                        </>
                    ) : (
                        <>
                            <button type="button" disabled={busy} onClick={() => setRejecting(true)} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-zinc-700 px-3 text-sm text-zinc-300 hover:border-rose-500/40 hover:text-rose-200 disabled:opacity-50">
                                <IconX className="h-4 w-4" />{t("reject")}
                            </button>
                            <button type="button" disabled={busy} onClick={() => onDecide(item, "dismissed", note)} title={t("dismissTitle")} aria-label={t("dismissLabel")} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-zinc-700 px-3 text-sm text-zinc-300 hover:border-zinc-500 hover:text-zinc-100 disabled:opacity-50">
                                <IconArchive className="h-4 w-4" />{t("dismiss")}
                            </button>
                            <button type="button" disabled={busy} onClick={approve} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-emerald-500 px-3.5 text-sm font-semibold text-emerald-950 hover:bg-emerald-400 disabled:opacity-50">
                                <IconCheck className="h-4 w-4" />{t("approve")}
                            </button>
                        </>
                    )}
                </div>
            )}
        </article>
    );
}

function ResolvedRow({ item }: { item: ApprovalItem }) {
    const t = useTranslations("approvals");
    const ago = useAgo();
    const actionLabel = useActionLabel();
    const approved = item.status === "approved";
    const dismissed = item.status === "dismissed";
    const label = approved ? t("status.approved") : dismissed ? t("status.dismissed") : item.status === "expired" ? t("status.expired") : t("status.rejected");
    const title = item.task?.title ?? t("resolvedTitle", { name: item.requester?.name ?? t("anAgent"), action: actionLabel(item) });
    const href = item.task ? taskHref(item.task) : item.requester ? `/agents?agent=${item.requester.id}` : "/approvals";
    return (
        <li>
            <Link href={href} className="flex items-center gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-zinc-900">
                <span className={cn("grid h-6 w-6 shrink-0 place-items-center rounded-full",
                    approved ? "bg-emerald-500/15 text-emerald-300" : dismissed || item.status === "expired" ? "bg-zinc-500/15 text-zinc-300" : "bg-rose-500/15 text-rose-300")}>
                    {approved ? <IconCheck className="h-3.5 w-3.5" /> : dismissed || item.status === "expired" ? <IconArchive className="h-3.5 w-3.5" /> : <IconX className="h-3.5 w-3.5" />}
                </span>
                <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-zinc-200">{title}</span>
                    <span className="block truncate text-xs text-zinc-500">
                        {item.resolverName ? t("resolvedBy", { label, name: item.resolverName }) : label}{item.resolutionNote ? ` — "${item.resolutionNote}"` : ""}
                    </span>
                </span>
                <span className="shrink-0 text-[11px] text-zinc-600">{item.resolvedAt ? ago(item.resolvedAt) : ""}</span>
            </Link>
        </li>
    );
}

/** What agents are waiting on you to decide, with what you need to decide it. */
export default function ApprovalsClient({ items }: { items: ApprovalItem[] }) {
    const t = useTranslations("approvals");
    const router = useRouter();
    const [query, setQuery] = useState("");
    const [busyKey, setBusyKey] = useState<string | null>(null);

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return items;
        return items.filter((i) => [i.task?.title, ...i.linkedTasks.map((t) => t.title), i.task?.description, i.rationale, i.projectName, i.customerName, i.requester?.name, i.task?.assignee,
            i.action?.label, ...(i.action?.args.map((a) => `${a.field} ${a.value}`) ?? [])]
            .filter(Boolean).join(" ").toLowerCase().includes(q));
    }, [items, query]);
    const pending = filtered.filter((i) => i.status === "pending").sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
    const resolved = filtered.filter((i) => i.status !== "pending").sort((a, b) => (b.resolvedAt ?? "").localeCompare(a.resolvedAt ?? "")).slice(0, 30);

    const decide = async (item: ApprovalItem, decision: Decision, note: string) => {
        setBusyKey(item.key);
        try {
            let approvalId = item.approvalId;
            if (!approvalId && item.task) {
                const created = await fetch("/api/approvals", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ projectId: item.task.projectId, taskIds: [item.task.id], rationale: "Approval decided directly in Emperor." }),
                });
                if (!created.ok) throw new Error(t("createFailed"));
                approvalId = (await created.json()).approval?.id ?? null;
            }
            if (!approvalId) throw new Error(t("idMissing"));
            const res = await fetch(`/api/approvals/${approvalId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ status: decision, resolutionNote: note.trim() || null }),
            });
            if (!res.ok) throw new Error(t("decideFailed"));
            // A decision is final: if it was already resolved (expired, or decided
            // by someone else), say what actually stands instead of confirming ours.
            const stored = ((await res.json().catch(() => ({}))) as { approval?: { status?: string } }).approval?.status;
            if (stored && stored !== decision) {
                router.refresh();
                throw new Error(t("alreadyResolved", { status: stored }));
            }
            toast.success(
                decision === "approved"
                    ? t("approvedToast", { name: item.requester?.name ?? t("theAgentCapital") })
                    : decision === "dismissed"
                        ? t("dismissedToast", { name: item.requester?.name ?? t("theAgentCapital") })
                        : t("sentBackToast", { name: item.requester?.name ?? t("theAgent") }),
            );
            router.refresh();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : t("somethingWrong"));
        } finally {
            setBusyKey(null);
        }
    };

    return (
        <div className="mx-auto max-w-[1800px] space-y-6 animate-in fade-in duration-500">
            <PageHeader
                eyebrow={t("eyebrow")}
                title={t("title")}
                description={t("description")}
                actions={
                    <div className="relative">
                        <IconSearch className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
                        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("searchPlaceholder")} aria-label={t("searchLabel")} className="w-full rounded-xl border border-zinc-800 bg-zinc-950/80 py-2 pl-9 pr-4 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-cyan-400/60 sm:w-72" />
                    </div>
                }
            />

            <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
            <section className="min-w-0 space-y-3">
                <h2 className="text-sm font-semibold text-zinc-300">{t("waitingOnYou")} <span className="ml-1 rounded-full bg-zinc-800 px-2 py-0.5 text-xs tabular-nums text-zinc-400">{pending.length}</span></h2>
                {pending.length === 0 ? (
                    query.trim() ? (
                        <EmptyState
                            icon={IconSearch}
                            title={t("noMatches")}
                            description={<button type="button" onClick={() => setQuery("")} className="text-primary hover:underline">{t("clearSearch")}</button>}
                        />
                    ) : (
                        <EmptyState
                            icon={IconRosetteDiscountCheck}
                            title={t("emptyTitle")}
                            description={t("emptyDescription")}
                        />
                    )
                ) : pending.map((item) => <PendingCard key={item.key} item={item} onDecide={decide} busy={busyKey === item.key} />)}
            </section>

            <section className="emperor-panel h-fit rounded-2xl p-4">
                <h2 className="mb-1 px-2 text-sm font-semibold text-zinc-300">{t("recentlyDecided")}</h2>
                {resolved.length > 0
                    ? <ul className="divide-y divide-zinc-800/70">{resolved.map((item) => <ResolvedRow key={item.key} item={item} />)}</ul>
                    : <EmptyState compact bordered={false} title={<span className="text-xs font-normal text-muted-foreground">{query.trim() ? t("noDecidedMatches") : t("noDecisions")}</span>} />}
            </section>
            </div>
        </div>
    );
}
