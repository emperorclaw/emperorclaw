"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { IconBuilding, IconDeviceFloppy, IconSearch } from "@tabler/icons-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
import { splitProjectTitle } from "@/lib/project-title";
import { ScopeViewsSection } from "@/components/views/scope-views-section";
import { ResourceAccessButton } from "@/components/access/resource-access-dialog";

type CustomerSummary = any;

const ATTENTION_KINDS = ["approval", "blocked", "incident", "review"] as const;
const PROJECT_STATUSES = ["active", "paused", "completed", "killed"] as const;
const ATTENTION_STYLE: Record<string, string> = {
    approval: "bg-amber-500/15 text-amber-200",
    blocked: "bg-rose-500/15 text-rose-200",
    incident: "bg-rose-500/15 text-rose-200",
    review: "bg-cyan-500/15 text-cyan-200",
};

export default function CustomersClient({ initialData: customerData }: { initialData: CustomerSummary[] }) {
    const t = useTranslations("customers");
    const tStatus = useTranslations("projects.statuses");
    const attentionLabel = (kind: string) => {
        const known = ATTENTION_KINDS.find((k) => k === kind);
        return known ? t(`attention.kinds.${known}`) : kind;
    };
    const statusLabel = (status: string) => {
        const known = PROJECT_STATUSES.find((s) => s === status);
        return known ? tStatus(known) : status;
    };
    const router = useRouter();
    const [isAddClientOpen, setIsAddClientOpen] = useState(false);
    const [newClientName, setNewClientName] = useState("");
    const [newClientNotes, setNewClientNotes] = useState("");
    const [sending, setSending] = useState(false);
    const [localNotes, setLocalNotes] = useState<Record<string, string>>({});
    const [query, setQuery] = useState("");
    const [selectedId, setSelectedId] = useState(customerData[0]?.id || "");

    const filteredCustomers = useMemo(() => {
        const normalized = query.trim().toLowerCase();
        if (!normalized) return customerData;
        return customerData.filter((customer) => `${customer.name} ${customer.notes || ""}`.toLowerCase().includes(normalized));
    }, [customerData, query]);
    const selectedCustomer = customerData.find((customer) => customer.id === selectedId) || filteredCustomers[0] || customerData[0] || null;

    const handleCreateCustomer = async () => {
        if (!newClientName.trim() || sending) return;
        setSending(true);
        try {
            const res = await fetch("/api/customers", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: newClientName, notes: newClientNotes }),
            });
            if (!res.ok) throw new Error("Failed to create customer");
            setNewClientName("");
            setNewClientNotes("");
            setIsAddClientOpen(false);
            toast.success(t("created"));
            router.refresh();
        } catch (error) {
            console.error("Failed to create customer", error);
            toast.error(t("createFailed"));
        } finally {
            setSending(false);
        }
    };

    const handleSaveNotes = async (customerId: string) => {
        const notes = localNotes[customerId];
        if (notes === undefined || sending) return;
        setSending(true);
        try {
            const res = await fetch(`/api/customers/${customerId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ notes }),
            });
            if (!res.ok) throw new Error("Failed to save customer notes");
            toast.success(t("notesSaved"));
            router.refresh();
        } catch (error) {
            console.error("Failed to save customer notes", error);
            toast.error(t("notesFailed"));
        } finally {
            setSending(false);
        }
    };

    const totals = customerData.reduce(
        (acc, customer) => {
            acc.projects += customer.projectCount || 0;
            acc.tasks += customer.taskCount || 0;
            acc.blocked += customer.blockedCount || 0;
            acc.approvals += customer.pendingApprovalCount || 0;
            acc.incidents += customer.incidentCount || 0;
            return acc;
        },
        { projects: 0, tasks: 0, blocked: 0, approvals: 0, incidents: 0 },
    );

    return (
        <div className="mx-auto max-w-[1800px] space-y-6 animate-in fade-in duration-500">
            <PageHeader
                eyebrow={t("eyebrow")}
                title={t("title")}
                description={t("description")}
                actions={
                    <Dialog open={isAddClientOpen} onOpenChange={setIsAddClientOpen}>
                        <DialogTrigger asChild>
                            <button className="cursor-pointer rounded-full border border-cyan-400/40 bg-cyan-400/10 px-4 py-2 text-sm font-semibold text-cyan-100 transition-colors hover:bg-cyan-400/15">
                                {t("add")}
                            </button>
                        </DialogTrigger>
                        <DialogContent className="border-zinc-800 bg-zinc-950 text-zinc-200 sm:max-w-[500px]">
                            <DialogHeader>
                                <DialogTitle className="mb-2 text-xl font-medium tracking-tight">{t("createTitle")}</DialogTitle>
                            </DialogHeader>
                            <div className="grid gap-4 py-4">
                                <p className="text-sm text-zinc-400">{t("createIntro")}</p>
                                <input
                                    value={newClientName}
                                    onChange={(event) => setNewClientName(event.target.value)}
                                    className="w-full rounded-xl border border-zinc-800 bg-zinc-950/80 p-3 text-sm text-zinc-100 outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400/60"
                                    placeholder={t("namePlaceholder")}
                                />
                                <textarea
                                    value={newClientNotes}
                                    onChange={(event) => setNewClientNotes(event.target.value)}
                                    className="h-32 w-full resize-none rounded-xl border border-zinc-800 bg-zinc-950/80 p-3 text-sm text-zinc-100 outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400/60"
                                    placeholder={t("notesPlaceholder")}
                                />
                            </div>
                            <div className="flex justify-end border-t border-zinc-900 pt-2">
                                <button title={!newClientName.trim() ? t("nameFirst") : undefined} onClick={() => void handleCreateCustomer()} disabled={!newClientName.trim() || sending} className="flex cursor-pointer items-center rounded-full border border-cyan-400/40 bg-cyan-400/10 px-4 py-2 text-sm font-medium text-cyan-100 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-cyan-400/15">
                                    {sending ? t("creating") : t("createTitle")}
                                </button>
                            </div>
                        </DialogContent>
                    </Dialog>
                }
            />

            <div className="grid gap-2 sm:gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
                <SummaryCard label={t("summary.customers")} value={customerData.length} hint={t("summary.customersHint")} />
                <SummaryCard label={t("summary.projects")} value={totals.projects} hint={t("summary.projectsHint")} accent="cyan" />
                <SummaryCard label={t("summary.tasks")} value={totals.tasks} hint={t("summary.tasksHint")} accent="emerald" />
                <SummaryCard label={t("summary.blocked")} value={totals.blocked} hint={t("summary.blockedHint")} accent="rose" />
                <SummaryCard label={t("summary.approvals")} value={totals.approvals} hint={t("summary.approvalsHint")} accent="amber" />
            </div>

            {customerData.length === 0 ? (
                <EmptyState
                    icon={IconBuilding}
                    title={t("emptyTitle")}
                    description={t("emptyDescription")}
                    action={<button type="button" onClick={() => setIsAddClientOpen(true)} className="cursor-pointer rounded-full border border-cyan-400/40 bg-cyan-400/10 px-4 py-2 text-sm font-semibold text-cyan-100 transition-colors hover:bg-cyan-400/15">{t("add")}</button>}
                />
            ) : (
                <div className="grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
                    <aside className="emperor-panel rounded-2xl p-3 sm:p-4">
                        <label className="flex items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-950/80 px-3 py-2 text-sm text-zinc-400">
                            <IconSearch className="h-4 w-4" />
                            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("searchPlaceholder")} className="w-full bg-transparent text-zinc-100 outline-none placeholder:text-zinc-500" />
                        </label>
                        <div className="mt-4 space-y-2">
                            {filteredCustomers.map((customer) => (
                                <button key={customer.id} type="button" onClick={() => setSelectedId(customer.id)} className={cn("w-full cursor-pointer rounded-xl border p-3 text-left transition-colors", selectedCustomer?.id === customer.id ? "border-cyan-400/40 bg-cyan-400/10" : "border-zinc-800 bg-zinc-950/60 hover:border-zinc-700")}>
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0">
                                            <div className="truncate font-medium text-zinc-100">{customer.name}</div>
                                            <div className="mt-1 text-xs text-zinc-500">{t("rowCounts", { projects: customer.projectCount || 0, tasks: customer.taskCount || 0 })}</div>
                                        </div>
                                        {customer.attention?.length ? (
                                            <span title={t("toCheckTitle")} className="shrink-0 rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[10px] font-bold text-amber-200">
                                                {t("toCheck", { count: customer.attention.length })}
                                            </span>
                                        ) : null}
                                    </div>
                                </button>
                            ))}
                            {filteredCustomers.length === 0 ? <EmptyState compact icon={IconSearch} title={t("noMatches")} description={<button type="button" onClick={() => setQuery("")} className="text-primary hover:underline">{t("clearSearch")}</button>} /> : null}
                        </div>
                    </aside>

                    {selectedCustomer ? (
                        <main className="emperor-panel rounded-2xl p-4 sm:p-5">
                            <div className="flex flex-wrap items-start justify-between gap-3 sm:gap-4 border-b border-zinc-800/80 pb-4 sm:pb-5">
                                <div>
                                    <div className="flex items-center gap-2">
                                        <h2 className="text-xl sm:text-2xl font-semibold text-zinc-100">{selectedCustomer.name}</h2>
                                        <span className="rounded border border-zinc-800 bg-zinc-950 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-zinc-400">{t("id", { id: selectedCustomer.id.substring(0, 8) })}</span>
                                    </div>
                                    <div className="mt-2 sm:mt-3 flex flex-wrap gap-1.5 sm:gap-2 text-[10px] font-semibold uppercase tracking-[0.16em]">
                                        <Tag label={t("tags.projects", { count: selectedCustomer.projectCount || 0 })} />
                                        <Tag label={t("tags.tasks", { count: selectedCustomer.taskCount || 0 })} />
                                        <Tag label={t("tags.inReview", { count: selectedCustomer.reviewCount || 0 })} />
                                        <Tag label={t("tags.blocked", { count: selectedCustomer.blockedCount || 0 })} tone="rose" />
                                        <Tag label={t("tags.approvals", { count: selectedCustomer.pendingApprovalCount || 0 })} tone="amber" />
                                        <Tag label={t("tags.incidents", { count: selectedCustomer.incidentCount || 0 })} tone="slate" />
                                        <Tag label={t("tags.pipelines", { count: selectedCustomer.pipelineCount || 0 })} tone="cyan" />
                                    </div>
                                </div>
                                <ResourceAccessButton type="customer" id={selectedCustomer.id} />
                            </div>
                            {selectedCustomer.attention?.length > 0 && (
                                <section className="mt-4 rounded-xl border border-amber-400/20 bg-amber-400/[0.04] p-3 sm:p-4" aria-label={t("attention.title")}>
                                    <h3 className="text-sm font-medium text-amber-100">{t("attention.title")}</h3>
                                    <p className="mt-0.5 text-xs text-zinc-500">{t("attention.hint")}</p>
                                    <ul className="mt-3 space-y-1.5">
                                        {selectedCustomer.attention.map((item: { kind: string; label: string; href: string }, index: number) => (
                                            <li key={`${item.kind}-${index}`}>
                                                <Link href={item.href} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-zinc-200 hover:bg-black/[0.04] dark:hover:bg-white/[0.04]">
                                                    <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider", ATTENTION_STYLE[item.kind] ?? ATTENTION_STYLE.review)}>{attentionLabel(item.kind)}</span>
                                                    <span className="truncate">{item.label}</span>
                                                </Link>
                                            </li>
                                        ))}
                                    </ul>
                                </section>
                            )}
                            {selectedCustomer.projects?.length > 0 && (
                                <section className="mt-4" aria-label={t("projects")}>
                                    <h3 className="mb-2 text-sm font-medium text-zinc-300">{t("projects")}</h3>
                                    <div className="grid gap-2 sm:grid-cols-2">
                                        {selectedCustomer.projects.map((project: { id: string; goal: string; status: string; openTasks: number }) => (
                                            <Link key={project.id} href={`/projects?project=${project.id}`} className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3 hover:border-cyan-400/30">
                                                <span className="block truncate text-sm text-zinc-100" title={project.goal}>{splitProjectTitle(project.goal).name}</span>
                                                <span className="text-xs text-zinc-500">{t("projectRow", { status: statusLabel(project.status), count: project.openTasks })}</span>
                                            </Link>
                                        ))}
                                    </div>
                                </section>
                            )}
                            <ScopeViewsSection key={selectedCustomer.id} customerId={selectedCustomer.id} className="mt-4" />
                            <div className="pt-4 sm:pt-5">
                                <div className="mb-2 flex items-center justify-between">
                                    <label className="text-sm font-medium text-zinc-300">{t("descriptionLabel")}</label>
                                    <button onClick={() => void handleSaveNotes(selectedCustomer.id)} disabled={sending || localNotes[selectedCustomer.id] === undefined} className="flex cursor-pointer items-center text-xs font-semibold text-cyan-300 transition-colors hover:text-cyan-200 disabled:opacity-50 disabled:cursor-not-allowed">
                                        <IconDeviceFloppy className="mr-1 h-3 w-3" />
                                        {t("save")}
                                    </button>
                                </div>
                                <textarea
                                    className="h-[280px] sm:h-[420px] w-full resize-y rounded-xl border border-zinc-800 bg-zinc-950/80 p-3 sm:p-4 font-mono text-sm leading-6 text-zinc-100 outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400/60"
                                    placeholder={t("descriptionPlaceholder")}
                                    value={localNotes[selectedCustomer.id] ?? selectedCustomer.notes ?? ""}
                                    onChange={(event) => setLocalNotes((prev) => ({ ...prev, [selectedCustomer.id]: event.target.value }))}
                                />
                                <p className="mt-2 text-xs text-zinc-500">{t("descriptionHint")}</p>
                            </div>
                        </main>
                    ) : null}
                </div>
            )}
        </div>
    );
}

function SummaryCard({ label, value, hint, accent = "slate" }: { label: string; value: number; hint: string; accent?: "slate" | "cyan" | "amber" | "emerald" | "rose" }) {
    const tone = {
        slate: "border-zinc-800 bg-zinc-950/50",
        cyan: "border-cyan-500/20 bg-cyan-500/10",
        amber: "border-amber-500/20 bg-amber-500/10",
        emerald: "border-emerald-500/20 bg-emerald-500/10",
        rose: "border-rose-500/20 bg-rose-500/10",
    }[accent];

    return (
        <div className={`rounded-xl border p-3 sm:p-4 ${tone}`}>
            <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-zinc-500">{label}</div>
            <div className="mt-1.5 sm:mt-2 text-xl sm:text-2xl font-semibold text-zinc-100">{value}</div>
            <div className="mt-0.5 sm:mt-1 text-[10px] sm:text-xs text-zinc-500">{hint}</div>
        </div>
    );
}

function Tag({ label, tone = "zinc" }: { label: string; tone?: "zinc" | "rose" | "amber" | "emerald" | "cyan" | "slate" }) {
    const toneClass = {
        zinc: "border-zinc-800 bg-zinc-900 text-zinc-400",
        slate: "border-zinc-800 bg-zinc-900 text-zinc-400",
        rose: "border-rose-500/20 bg-rose-500/10 text-rose-300",
        amber: "border-amber-500/20 bg-amber-500/10 text-amber-300",
        emerald: "border-emerald-500/20 bg-emerald-500/10 text-emerald-300",
        cyan: "border-cyan-500/20 bg-cyan-500/10 text-cyan-300",
    }[tone];

    return <span className={cn("rounded border px-2 py-1", toneClass)}>{label}</span>;
}
