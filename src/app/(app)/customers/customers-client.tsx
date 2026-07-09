"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useMemo, useState } from "react";
import { Building2, Save, Search, Sparkles } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type CustomerSummary = any;

export default function CustomersClient({ initialData: customerData }: { initialData: CustomerSummary[] }) {
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
            window.location.reload();
        } catch (error) {
            console.error("Failed to create customer", error);
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
            window.location.reload();
        } catch (error) {
            console.error("Failed to save customer notes", error);
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
            <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="space-y-1">
                    <p className="text-xs font-bold uppercase tracking-[0.24em] text-cyan-300">Customers</p>
                    <h1 className="text-2xl font-semibold tracking-tight text-zinc-100 sm:text-3xl">Customer Directory</h1>
                    <p className="text-sm text-zinc-400">Find a customer, inspect its portfolio health, and maintain the customer context agents should follow.</p>
                </div>
                <Dialog open={isAddClientOpen} onOpenChange={setIsAddClientOpen}>
                    <DialogTrigger asChild>
                        <button className="rounded-full border border-cyan-400/40 bg-cyan-400/10 px-4 py-2 text-sm font-semibold text-cyan-100 transition-colors hover:bg-cyan-400/15">
                            Add Customer
                        </button>
                    </DialogTrigger>
                    <DialogContent className="border-zinc-800 bg-zinc-950 text-zinc-200 sm:max-w-[500px]">
                        <DialogHeader>
                            <DialogTitle className="mb-2 text-xl font-medium tracking-tight">Create Customer</DialogTitle>
                        </DialogHeader>
                        <div className="grid gap-4 py-4">
                            <p className="text-sm text-zinc-400">Create a durable customer record and attach initial portfolio context.</p>
                            <input
                                value={newClientName}
                                onChange={(event) => setNewClientName(event.target.value)}
                                className="w-full rounded-xl border border-zinc-800 bg-zinc-950/80 p-3 text-sm text-zinc-100 outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400/60"
                                placeholder="Customer name"
                            />
                            <textarea
                                value={newClientNotes}
                                onChange={(event) => setNewClientNotes(event.target.value)}
                                className="h-32 w-full resize-none rounded-xl border border-zinc-800 bg-zinc-950/80 p-3 text-sm text-zinc-100 outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400/60"
                                placeholder="ICP details, project context, operational notes..."
                            />
                        </div>
                        <div className="flex justify-end border-t border-zinc-900 pt-2">
                            <button onClick={() => void handleCreateCustomer()} disabled={!newClientName.trim() || sending} className="flex items-center rounded-full border border-cyan-400/40 bg-cyan-400/10 px-4 py-2 text-sm font-medium text-cyan-100 disabled:opacity-50 hover:bg-cyan-400/15">
                                {sending ? "Creating..." : "Create Customer"}
                            </button>
                        </div>
                    </DialogContent>
                </Dialog>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                <SummaryCard label="Customers" value={customerData.length} hint="Portfolio records" />
                <SummaryCard label="Projects" value={totals.projects} hint="Projects across customers" accent="cyan" />
                <SummaryCard label="Tasks" value={totals.tasks} hint="Open and closed work" accent="emerald" />
                <SummaryCard label="Blocked" value={totals.blocked} hint="Tasks waiting on dependencies" accent="rose" />
                <SummaryCard label="Approvals" value={totals.approvals} hint="Pending human decisions" accent="amber" />
            </div>

            {customerData.length === 0 ? (
                <div className="emperor-panel rounded-2xl py-12 text-center">
                    <Building2 className="mx-auto mb-4 h-12 w-12 text-zinc-500" />
                    <h3 className="mb-1 font-medium text-zinc-200">No customers yet</h3>
                    <p className="text-sm text-zinc-500">Add a customer to define the portfolio and execution context your agents should follow.</p>
                </div>
            ) : (
                <div className="grid gap-6 xl:grid-cols-[360px_minmax(0,1fr)]">
                    <aside className="emperor-panel rounded-2xl p-4">
                        <label className="flex items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-950/80 px-3 py-2 text-sm text-zinc-400">
                            <Search className="h-4 w-4" />
                            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search customers" className="w-full bg-transparent text-zinc-100 outline-none placeholder:text-zinc-500" />
                        </label>
                        <div className="mt-4 space-y-2">
                            {filteredCustomers.map((customer) => (
                                <button key={customer.id} type="button" onClick={() => setSelectedId(customer.id)} className={cn("w-full rounded-xl border p-3 text-left transition-colors", selectedCustomer?.id === customer.id ? "border-cyan-400/40 bg-cyan-400/10" : "border-zinc-800 bg-zinc-950/60 hover:border-zinc-700")}>
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0">
                                            <div className="truncate font-medium text-zinc-100">{customer.name}</div>
                                            <div className="mt-1 text-xs text-zinc-500">{customer.projectCount || 0} projects · {customer.taskCount || 0} tasks</div>
                                        </div>
                                        {(customer.blockedCount || customer.pendingApprovalCount || customer.incidentCount) ? <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[10px] font-bold text-amber-200">Needs review</span> : null}
                                    </div>
                                </button>
                            ))}
                            {filteredCustomers.length === 0 ? <div className="rounded-xl border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-500">No customers match that search.</div> : null}
                        </div>
                    </aside>

                    {selectedCustomer ? (
                        <main className="emperor-panel rounded-2xl p-5">
                            <div className="flex flex-wrap items-start justify-between gap-4 border-b border-zinc-800/80 pb-5">
                                <div>
                                    <div className="flex items-center gap-2">
                                        <h2 className="text-2xl font-semibold text-zinc-100">{selectedCustomer.name}</h2>
                                        <span className="rounded border border-zinc-800 bg-zinc-950 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-zinc-400">ID: {selectedCustomer.id.substring(0, 8)}</span>
                                    </div>
                                    <div className="mt-3 flex flex-wrap gap-2 text-[10px] font-semibold uppercase tracking-[0.16em]">
                                        <Tag label={`${selectedCustomer.projectCount || 0} projects`} />
                                        <Tag label={`${selectedCustomer.taskCount || 0} tasks`} />
                                        <Tag label={`${selectedCustomer.reviewCount || 0} in review`} />
                                        <Tag label={`${selectedCustomer.blockedCount || 0} blocked`} tone="rose" />
                                        <Tag label={`${selectedCustomer.pendingApprovalCount || 0} approvals`} tone="amber" />
                                        <Tag label={`${selectedCustomer.incidentCount || 0} attention items`} tone="slate" />
                                        <Tag label={`${selectedCustomer.pipelineCount || 0} pipelines`} tone="cyan" />
                                    </div>
                                </div>
                                <Sparkles className="mt-1 h-5 w-5 text-cyan-300/70" />
                            </div>
                            <div className="pt-5">
                                <div className="mb-2 flex items-center justify-between">
                                    <label className="text-sm font-medium text-zinc-300">Customer context markdown</label>
                                    <button onClick={() => void handleSaveNotes(selectedCustomer.id)} disabled={sending || localNotes[selectedCustomer.id] === undefined} className="flex items-center text-xs font-semibold text-cyan-300 transition-colors hover:text-cyan-200 disabled:opacity-50">
                                        <Save className="mr-1 h-3 w-3" />
                                        Save context
                                    </button>
                                </div>
                                <textarea
                                    className="h-[420px] w-full resize-y rounded-xl border border-zinc-800 bg-zinc-950/80 p-4 font-mono text-sm leading-6 text-zinc-100 outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400/60"
                                    placeholder="# Target Audience\nDescribe who the team should optimize for..."
                                    value={localNotes[selectedCustomer.id] ?? selectedCustomer.notes ?? ""}
                                    onChange={(event) => setLocalNotes((prev) => ({ ...prev, [selectedCustomer.id]: event.target.value }))}
                                />
                                <p className="mt-2 text-xs text-zinc-500">This is durable customer context. Keep project-specific rules in Project or Knowledge & Rules.</p>
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
        <div className={`rounded-xl border p-4 ${tone}`}>
            <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-zinc-500">{label}</div>
            <div className="mt-2 text-2xl font-semibold text-zinc-100">{value}</div>
            <div className="mt-1 text-xs text-zinc-500">{hint}</div>
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
