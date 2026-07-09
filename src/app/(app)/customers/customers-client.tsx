"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useState } from "react";
import { Building2, Save, Sparkles } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type CustomerSummary = any;

export default function CustomersClient({ initialData: customerData }: { initialData: CustomerSummary[] }) {
    const [isAddClientOpen, setIsAddClientOpen] = useState(false);
    const [newClientName, setNewClientName] = useState("");
    const [newClientNotes, setNewClientNotes] = useState("");
    const [sending, setSending] = useState(false);
    const [localNotes, setLocalNotes] = useState<Record<string, string>>({});

    const handleCreateCustomer = async () => {
        if (!newClientName.trim() || sending) return;
        setSending(true);
        try {
            const res = await fetch("/api/customers", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: newClientName, notes: newClientNotes }),
            });
            if (!res.ok) {
                throw new Error("Failed to create customer");
            }
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
            if (!res.ok) {
                throw new Error("Failed to save customer notes");
            }
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
        <div className="mx-auto max-w-6xl space-y-8 animate-in fade-in duration-500">
            <div className="flex items-start justify-between gap-4">
                <div className="space-y-2">
                    <h1 className="text-3xl font-semibold tracking-tight text-zinc-100">Customers</h1>
                    <p className="font-medium text-zinc-500">Portfolio summaries for each customer and the projects tied to them.</p>
                </div>
                <Dialog open={isAddClientOpen} onOpenChange={setIsAddClientOpen}>
                    <DialogTrigger asChild>
                        <button className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500">
                            Add Customer
                        </button>
                    </DialogTrigger>
                    <DialogContent className="sm:max-w-[500px] border-zinc-800 bg-zinc-950 text-zinc-200">
                        <DialogHeader>
                            <DialogTitle className="mb-2 text-xl font-medium tracking-tight">Create Customer</DialogTitle>
                        </DialogHeader>
                        <div className="grid gap-4 py-4">
                            <p className="text-sm text-zinc-400">Create a durable customer record and attach initial portfolio context.</p>
                            <input
                                value={newClientName}
                                onChange={(event) => setNewClientName(event.target.value)}
                                className="w-full rounded-md border border-zinc-800 bg-zinc-900 p-3 text-sm text-zinc-300 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                                placeholder="Customer name"
                            />
                            <textarea
                                value={newClientNotes}
                                onChange={(event) => setNewClientNotes(event.target.value)}
                                className="h-32 w-full resize-none rounded-md border border-zinc-800 bg-zinc-900 p-3 text-sm text-zinc-300 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                                placeholder="ICP details, project context, operational notes..."
                            />
                        </div>
                        <div className="flex justify-end border-t border-zinc-900 pt-2">
                            <button onClick={() => void handleCreateCustomer()} disabled={!newClientName.trim() || sending} className="flex items-center rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 hover:bg-indigo-500">
                                {sending ? "Creating..." : "Create Customer"}
                            </button>
                        </div>
                    </DialogContent>
                </Dialog>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                <SummaryCard label="Customers" value={customerData.length} hint="Portfolio records" />
                <SummaryCard label="Projects" value={totals.projects} hint="Projects across customers" accent="indigo" />
                <SummaryCard label="Tasks" value={totals.tasks} hint="Open and closed work" accent="emerald" />
                <SummaryCard label="Blocked" value={totals.blocked} hint="Tasks waiting on dependencies" accent="rose" />
                <SummaryCard label="Approvals" value={totals.approvals} hint="Pending human decisions" accent="amber" />
            </div>

            <div className="grid gap-6 rounded-xl border border-zinc-800/80 bg-zinc-900/50 p-6">
                {customerData.length === 0 ? (
                    <div className="py-12 text-center">
                        <Building2 className="mx-auto mb-4 h-12 w-12 text-zinc-700" />
                        <h3 className="mb-1 font-medium text-zinc-300">No customers yet</h3>
                        <p className="text-sm text-zinc-500">Add a customer to define the portfolio and execution context your agents should follow.</p>
                    </div>
                ) : (
                    customerData.map((customer) => (
                        <div key={customer.id} className="overflow-hidden rounded-lg border border-zinc-800/80 bg-zinc-950/50">
                            <div className="flex items-start justify-between gap-4 border-b border-zinc-800/80 bg-zinc-900/30 p-5">
                                <div className="space-y-2">
                                    <h3 className="flex items-center gap-2 text-lg font-medium text-zinc-200">
                                        {customer.name}
                                        <span className="rounded border border-indigo-500/20 bg-indigo-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-indigo-400">
                                            ID: {customer.id.substring(0, 8)}
                                        </span>
                                    </h3>
                                    <div className="flex flex-wrap gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
                                        <Tag label={`${customer.projectCount || 0} projects`} />
                                        <Tag label={`${customer.taskCount || 0} tasks`} />
                                        <Tag label={`${customer.reviewCount || 0} in review`} />
                                        <Tag label={`${customer.blockedCount || 0} blocked`} tone="rose" />
                                        <Tag label={`${customer.pendingApprovalCount || 0} approvals`} tone="amber" />
                                        <Tag label={`${customer.incidentCount || 0} attention items`} tone="slate" />
                                        <Tag label={`${customer.pipelineCount || 0} pipelines`} tone="indigo" />
                                    </div>
                                </div>
                                <Sparkles className="mt-1 h-5 w-5 text-indigo-400/70" />
                            </div>

                            <div className="p-5">
                                <div className="mb-2 flex items-center justify-between">
                                    <label className="text-sm font-medium text-zinc-400">Context Markdown (ICP Details)</label>
                                    <button onClick={() => void handleSaveNotes(customer.id)} disabled={sending} className="flex items-center text-xs text-indigo-400 transition-colors hover:text-indigo-300 disabled:opacity-50">
                                        <Save className="mr-1 h-3 w-3" />
                                        Save Notes
                                    </button>
                                </div>
                                <textarea
                                    className="h-48 w-full resize-y rounded-md border border-zinc-800 bg-zinc-900 p-4 font-mono text-sm text-zinc-300 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                                    placeholder="# Target Audience\nDescribe who the team should optimize for..."
                                    defaultValue={customer.notes || ""}
                                    onChange={(event) => setLocalNotes((prev) => ({ ...prev, [customer.id]: event.target.value }))}
                                />
                                <p className="mt-2 text-xs text-zinc-600">This is stored directly in Emperor as durable customer context.</p>
                            </div>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}

function SummaryCard({ label, value, hint, accent = "slate" }: { label: string; value: number; hint: string; accent?: "slate" | "indigo" | "amber" | "emerald" | "rose" }) {
    const tone = {
        slate: "border-zinc-800 bg-zinc-950/50",
        indigo: "border-indigo-500/20 bg-indigo-500/10",
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

function Tag({ label, tone = "zinc" }: { label: string; tone?: "zinc" | "rose" | "amber" | "emerald" | "indigo" | "slate" }) {
    const toneClass = {
        zinc: "border-zinc-800 bg-zinc-900 text-zinc-500",
        slate: "border-zinc-800 bg-zinc-900 text-zinc-400",
        rose: "border-rose-500/20 bg-rose-500/10 text-rose-300",
        amber: "border-amber-500/20 bg-amber-500/10 text-amber-300",
        emerald: "border-emerald-500/20 bg-emerald-500/10 text-emerald-300",
        indigo: "border-indigo-500/20 bg-indigo-500/10 text-indigo-300",
    }[tone];

    return <span className={cn("rounded border px-2 py-1", toneClass)}>{label}</span>;
}
