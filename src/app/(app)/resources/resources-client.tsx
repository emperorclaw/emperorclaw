"use client";

import { useMemo, useState } from "react";
import { Database, FolderKanban, Mail, ShieldCheck, Trash2, UserRound, type LucideIcon } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

type ResourceRecord = {
    id: string;
    scopeType: string;
    scopeId: string | null;
    provider: string;
    resourceType: string;
    name: string;
    displayName: string | null;
    ownership: string;
    status: string;
    configJson: any;
    createdAt: string | Date;
    updatedAt: string | Date;
};

type ScopeOption = { id: string; name: string };

const RESOURCE_TYPE_OPTIONS = [
    "mailbox",
    "identity",
    "template",
    "billing_profile",
    "external_account",
    "knowledge_base",
];

const RESOURCE_TEMPLATES: Record<string, { provider: string; configText: string; helper: string }> = {
    mailbox: {
        provider: "email",
        configText: "protocol: imap\naddress: finance@example.com\nhost: imap.example.com\nport: 993",
        helper: "Use customer or project scope for mailboxes and invoice inboxes.",
    },
    identity: {
        provider: "identity",
        configText: "displayName: Accounts Payable\nsignature: Accounts Payable Team",
        helper: "Use this for sender names, signatures, and project-facing personas.",
    },
    template: {
        provider: "template",
        configText: "format: markdown\nkind: invoice_summary\npathHint: templates/invoice-summary.md",
        helper: "Templates belong here when they should be durable and reusable.",
    },
    billing_profile: {
        provider: "billing",
        configText: "legalName: Example GmbH\nvatId: DE123456789\naddress: Berlin",
        helper: "Use billing profiles for company invoice metadata and fiscal context.",
    },
    external_account: {
        provider: "generic",
        configText: "baseUrl: https://api.example.com\naccountId: acct_123",
        helper: "Generic external accounts are the fallback for arbitrary credentials or connector metadata.",
    },
    knowledge_base: {
        provider: "knowledge",
        configText: "location: s3://bucket/folder\nformat: pdf",
        helper: "Use knowledge-base resources for durable file sets or reference corpora.",
    },
};



function scopeLabel(scopeType: string) {
    return {
        company: "Company",
        customer: "Customer",
        project: "Project",
        agent: "Agent",
    }[scopeType] || scopeType;
}

export default function ResourcesClient({
    initialResources,
    customers,
    projects,
    agents,
}: {
    initialResources: ResourceRecord[];
    customers: ScopeOption[];
    projects: ScopeOption[];
    agents: ScopeOption[];
}) {
    const [resources, setResources] = useState(initialResources);
    const [isCreateOpen, setIsCreateOpen] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const [scopeType, setScopeType] = useState("project");
    const [scopeId, setScopeId] = useState(projects[0]?.id || "");
    const [resourceType, setResourceType] = useState("external_account");
    const [provider, setProvider] = useState("generic");
    const [name, setName] = useState("");
    const [displayName, setDisplayName] = useState("");
    const [configText, setConfigText] = useState(RESOURCE_TEMPLATES.external_account.configText);

    const scopeOptions = useMemo(() => ({
        customer: customers,
        project: projects,
        agent: agents,
    }), [agents, customers, projects]);

    const summary = useMemo(() => {
        return resources.reduce((acc, resource) => {
            acc.total += 1;
            acc[resource.scopeType as "company" | "customer" | "project" | "agent"] += 1;
            return acc;
        }, { total: 0, company: 0, customer: 0, project: 0, agent: 0 });
    }, [resources]);

    const selectedTemplate = RESOURCE_TEMPLATES[resourceType] || RESOURCE_TEMPLATES.external_account;

    const applyTemplate = (nextType: string) => {
        const template = RESOURCE_TEMPLATES[nextType] || RESOURCE_TEMPLATES.external_account;
        setResourceType(nextType);
        setProvider(template.provider);
        setConfigText(template.configText);
    };

    const updateScopeType = (nextScopeType: string) => {
        setScopeType(nextScopeType);
        const options = scopeOptions[nextScopeType as keyof typeof scopeOptions] || [];
        setScopeId(options[0]?.id || "");
    };

    const handleCreate = async () => {
        if (!name.trim() || isSaving) return;
        setIsSaving(true);
        setError(null);

        try {
            const payload = {
                scopeType,
                scopeId: scopeType === "company" ? null : scopeId || null,
                provider: provider.trim() || "generic",
                resourceType,
                name: name.trim(),
                displayName: displayName.trim() || null,
                configJson: configText,
                secretJson: {},
            };

            const res = await fetch("/api/resources", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });

            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(typeof body.error === "string" ? body.error : "Failed to create resource.");
            }

            setResources((current) => [body.resource as ResourceRecord, ...current]);
            setIsCreateOpen(false);
            setName("");
            setDisplayName("");
            setProvider("generic");
            updateScopeType("project");
            applyTemplate("external_account");
        } catch (createError) {
            setError(createError instanceof Error ? createError.message : "Failed to create resource.");
        } finally {
            setIsSaving(false);
        }
    };

    const handleDelete = async (resourceId: string) => {
        if (!confirm("Archive this resource?")) return;

        try {
            const res = await fetch(`/api/resources/${resourceId}`, {
                method: "DELETE",
            });
            if (!res.ok) {
                throw new Error("Failed to archive resource.");
            }
            setResources((current) => current.filter((resource) => resource.id !== resourceId));
        } catch (deleteError) {
            console.error(deleteError);
        }
    };

    const scopeName = (resource: ResourceRecord) => {
        if (resource.scopeType === "company") return "Company-wide";
        const options = scopeOptions[resource.scopeType as keyof typeof scopeOptions] || [];
        return options.find((option) => option.id === resource.scopeId)?.name || "Unknown scope";
    };

    return (
        <div className="mx-auto max-w-6xl space-y-8 animate-in fade-in duration-500">
            <div className="flex items-start justify-between gap-4">
                <div className="space-y-2">
                    <h1 className="text-3xl font-semibold tracking-tight text-zinc-100">Resources</h1>
                    <p className="font-medium text-zinc-500 max-w-3xl">
                        Store customer, project, and company resources here: mailboxes, identities, templates, billing profiles,
                        and generic credentials. Use agent runtime integrations only for secrets that truly belong to one local worker.
                    </p>
                </div>
                <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
                    <DialogTrigger asChild>
                        <button className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-indigo-500">
                            Add Resource
                        </button>
                    </DialogTrigger>
                    <DialogContent className="sm:max-w-[720px] border-zinc-800 bg-zinc-950 text-zinc-200">
                        <DialogHeader>
                            <DialogTitle className="text-xl font-medium tracking-tight">Create Scoped Resource</DialogTitle>
                        </DialogHeader>
                        <div className="grid gap-4 py-4">
                            <p className="text-sm text-zinc-400">
                                Store context and configuration details in <span className="font-mono text-zinc-300">Configuration</span> as Markdown or text.
                                Secrets are currently disabled.
                            </p>
                            <div className="grid gap-4 md:grid-cols-2">
                                <label className="space-y-1.5 text-sm">
                                    <span className="text-zinc-500">Scope</span>
                                    <select
                                        value={scopeType}
                                        onChange={(event) => updateScopeType(event.target.value)}
                                        className="w-full rounded-md border border-zinc-800 bg-zinc-900 p-3 text-sm text-zinc-300 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                                    >
                                        <option value="company">Company</option>
                                        <option value="customer">Customer</option>
                                        <option value="project">Project</option>
                                        <option value="agent">Agent</option>
                                    </select>
                                </label>
                                <label className="space-y-1.5 text-sm">
                                    <span className="text-zinc-500">Scope Record</span>
                                    <select
                                        value={scopeType === "company" ? "company" : scopeId}
                                        onChange={(event) => setScopeId(event.target.value)}
                                        disabled={scopeType === "company"}
                                        className="w-full rounded-md border border-zinc-800 bg-zinc-900 p-3 text-sm text-zinc-300 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 disabled:opacity-60"
                                    >
                                        {scopeType === "company" ? (
                                            <option value="company">Whole company</option>
                                        ) : (
                                            (scopeOptions[scopeType as keyof typeof scopeOptions] || []).map((option) => (
                                                <option key={option.id} value={option.id}>{option.name}</option>
                                            ))
                                        )}
                                    </select>
                                </label>
                            </div>
                            <div className="grid gap-4 md:grid-cols-3">
                                <label className="space-y-1.5 text-sm">
                                    <span className="text-zinc-500">Resource Type</span>
                                    <select
                                        value={resourceType}
                                        onChange={(event) => applyTemplate(event.target.value)}
                                        className="w-full rounded-md border border-zinc-800 bg-zinc-900 p-3 text-sm text-zinc-300 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                                    >
                                        {RESOURCE_TYPE_OPTIONS.map((option) => (
                                            <option key={option} value={option}>{option}</option>
                                        ))}
                                    </select>
                                </label>
                                <label className="space-y-1.5 text-sm md:col-span-2">
                                    <span className="text-zinc-500">Provider</span>
                                    <input
                                        value={provider}
                                        onChange={(event) => setProvider(event.target.value)}
                                        className="w-full rounded-md border border-zinc-800 bg-zinc-900 p-3 text-sm text-zinc-300 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                                        placeholder="generic, email, github, stripe, drive..."
                                    />
                                </label>
                            </div>
                            <div className="grid gap-4 md:grid-cols-2">
                                <label className="space-y-1.5 text-sm">
                                    <span className="text-zinc-500">Name</span>
                                    <input
                                        value={name}
                                        onChange={(event) => setName(event.target.value)}
                                        className="w-full rounded-md border border-zinc-800 bg-zinc-900 p-3 text-sm text-zinc-300 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                                        placeholder="finance-inbox, invoice-template, acme-billing"
                                    />
                                </label>
                                <label className="space-y-1.5 text-sm">
                                    <span className="text-zinc-500">Display Name</span>
                                    <input
                                        value={displayName}
                                        onChange={(event) => setDisplayName(event.target.value)}
                                        className="w-full rounded-md border border-zinc-800 bg-zinc-900 p-3 text-sm text-zinc-300 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                                        placeholder="ACME Finance Inbox"
                                    />
                                </label>
                            </div>
                            <div className="rounded-md border border-zinc-800 bg-zinc-900/60 p-3 text-sm text-zinc-400">
                                {selectedTemplate.helper}
                            </div>
                            <div className="grid gap-4">
                                <label className="space-y-1.5 text-sm">
                                    <span className="text-zinc-500">Configuration (Markdown)</span>
                                    <textarea
                                        value={configText}
                                        onChange={(event) => setConfigText(event.target.value)}
                                        className="h-56 w-full resize-y rounded-md border border-zinc-800 bg-zinc-900 p-3 font-mono text-sm text-zinc-300 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                                    />
                                </label>
                            </div>
                            {error && (
                                <div className="rounded-md border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300">
                                    {error}
                                </div>
                            )}
                        </div>
                        <div className="flex justify-end border-t border-zinc-900 pt-2">
                            <button
                                onClick={() => void handleCreate()}
                                disabled={!name.trim() || isSaving}
                                className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 hover:bg-indigo-500"
                            >
                                {isSaving ? "Saving..." : "Create Resource"}
                            </button>
                        </div>
                    </DialogContent>
                </Dialog>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                <SummaryCard label="Resources" value={summary.total} hint="Durable scoped assets" icon={Database} />
                <SummaryCard label="Company" value={summary.company} hint="Global scope" icon={ShieldCheck} />
                <SummaryCard label="Customers" value={summary.customer} hint="Customer-specific" icon={Mail} />
                <SummaryCard label="Projects" value={summary.project} hint="Project-specific" icon={FolderKanban} />
                <SummaryCard label="Agents" value={summary.agent} hint="Agent-local only" icon={UserRound} />
            </div>

            <div className="grid gap-4 rounded-xl border border-zinc-800/80 bg-zinc-900/50 p-6">
                {resources.length === 0 ? (
                    <div className="py-12 text-center text-zinc-500">
                        <Database className="mx-auto mb-4 h-12 w-12 text-zinc-700" />
                        No resources defined yet. Add scoped resources here instead of hiding customer mailboxes or templates inside agent-only integrations.
                    </div>
                ) : resources.map((resource) => (
                    <div key={resource.id} className="rounded-lg border border-zinc-800/80 bg-zinc-950/50 overflow-hidden">
                        <div className="flex items-start justify-between gap-4 border-b border-zinc-800/80 bg-zinc-900/30 p-5">
                            <div className="space-y-2">
                                <div className="flex flex-wrap items-center gap-2">
                                    <h3 className="text-lg font-medium text-zinc-200">{resource.displayName || resource.name}</h3>
                                    <span className="rounded border border-indigo-500/20 bg-indigo-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-indigo-400">
                                        {resource.resourceType}
                                    </span>
                                    <span className="rounded border border-zinc-800 bg-zinc-900 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                                        {scopeLabel(resource.scopeType)}
                                    </span>
                                </div>
                                <div className="text-sm text-zinc-500">
                                    {scopeName(resource)} · provider <span className="font-mono text-zinc-400">{resource.provider}</span> · ownership <span className="font-mono text-zinc-400">{resource.ownership}</span>
                                </div>
                            </div>
                            <button
                                onClick={() => void handleDelete(resource.id)}
                                className="inline-flex items-center rounded-md border border-zinc-800 px-3 py-2 text-xs font-semibold text-zinc-400 transition-colors hover:border-rose-500/30 hover:text-rose-300"
                            >
                                <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                                Archive
                            </button>
                        </div>
                        <div className="grid gap-4 p-5">
                            <div>
                                <div className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Configuration</div>
                                <pre className="overflow-x-auto rounded-md border border-zinc-800 bg-zinc-900 p-4 text-xs text-zinc-300 whitespace-pre-wrap">{typeof resource.configJson === 'string' ? resource.configJson : JSON.stringify(resource.configJson || {}, null, 2)}</pre>
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

function SummaryCard({
    label,
    value,
    hint,
    icon: Icon,
}: {
    label: string;
    value: number;
    hint: string;
    icon: LucideIcon;
}) {
    return (
        <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-4">
            <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.18em] text-zinc-500">
                <Icon className="h-4 w-4 text-indigo-400" />
                <span>{label}</span>
            </div>
            <div className="mt-2 text-2xl font-semibold text-zinc-100">{value}</div>
            <div className="mt-1 text-xs text-zinc-500">{hint}</div>
        </div>
    );
}
