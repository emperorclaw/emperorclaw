"use client";

import { useMemo, useState } from "react";
import { Database, FolderKanban, Mail, ShieldCheck, Trash2, UserRound, type LucideIcon, Edit, ChevronRight, ChevronDown, Folder, FileText, Plus, Search } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

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
    const [editingResource, setEditingResource] = useState<ResourceRecord | null>(null);

    const [scopeType, setScopeType] = useState("project");
    const [scopeId, setScopeId] = useState(projects[0]?.id || "");
    const [resourceType, setResourceType] = useState("external_account");
    const [provider, setProvider] = useState("generic");
    const [name, setName] = useState("");
    const [displayName, setDisplayName] = useState("");
    const [configText, setConfigText] = useState(RESOURCE_TEMPLATES.external_account.configText);
    const [selectedResourceId, setSelectedResourceId] = useState<string | null>(null);
    const [searchQuery, setSearchQuery] = useState("");
    const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set(['company', 'customer', 'project', 'agent']));

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

    const groupedResources = useMemo(() => {
        const groups: Record<string, any> = {
            company: { label: "Company", icon: ShieldCheck, items: {} },
            customer: { label: "Customers", icon: Mail, items: {} },
            project: { label: "Projects", icon: FolderKanban, items: {} },
            agent: { label: "Agents", icon: UserRound, items: {} },
        };

        resources.forEach(r => {
            const scopeKey = r.scopeId || "global";
            if (!groups[r.scopeType].items[scopeKey]) {
                const options = scopeOptions[r.scopeType as keyof typeof scopeOptions] || [];
                const sName = r.scopeType === 'company' ? 'Company-wide' : (options.find(o => o.id === r.scopeId)?.name || "Unknown");
                groups[r.scopeType].items[scopeKey] = {
                    name: sName,
                    types: {}
                };
            }
            if (!groups[r.scopeType].items[scopeKey].types[r.resourceType]) {
                groups[r.scopeType].items[scopeKey].types[r.resourceType] = [];
            }
            groups[r.scopeType].items[scopeKey].types[r.resourceType].push(r);
        });
        return groups;
    }, [resources, scopeOptions]);

    const selectedResource = useMemo(() => 
        resources.find(r => r.id === selectedResourceId) || null
    , [resources, selectedResourceId]);

    const selectedTemplate = RESOURCE_TEMPLATES[resourceType] || RESOURCE_TEMPLATES.external_account;

    const selectResource = (resource: ResourceRecord) => {
        setSelectedResourceId(resource.id);
        setEditingResource(resource);
        setScopeType(resource.scopeType);
        setScopeId(resource.scopeId || "");
        setResourceType(resource.resourceType);
        setProvider(resource.provider);
        setName(resource.name);
        setDisplayName(resource.displayName || "");
        setConfigText(typeof resource.configJson === "string" ? resource.configJson : JSON.stringify(resource.configJson || {}, null, 2));
    };

    const toggleGroup = (groupId: string) => {
        const next = new Set(expandedGroups);
        if (next.has(groupId)) next.delete(groupId);
        else next.add(groupId);
        setExpandedGroups(next);
    };

    const openModalForCreate = () => {
        setEditingResource(null);
        setName("");
        setDisplayName("");
        setProvider("generic");
        updateScopeType("project");
        applyTemplate("external_account");
        setIsCreateOpen(true);
    };

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

            let res;
            if (editingResource) {
                res = await fetch(`/api/resources/${editingResource.id}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                });
            } else {
                res = await fetch("/api/resources", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                });
            }

            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(typeof body.error === "string" ? body.error : "Failed to create resource.");
            }

            setResources((current) => editingResource 
                ? current.map(r => r.id === editingResource.id ? (body.resource as ResourceRecord) : r)
                : [body.resource as ResourceRecord, ...current]);
            setIsCreateOpen(false);
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
        <div className="flex flex-col h-[calc(100vh-140px)] animate-in fade-in duration-500">
            <div className="flex items-center justify-between mb-4">
                <div>
                    <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Resources Explorer</h1>
                    <p className="text-sm text-zinc-500">Manage scoped assets and configurations</p>
                </div>
                <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
                    <DialogTrigger asChild>
                        <button onClick={openModalForCreate} className="flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-indigo-500">
                            <Plus className="h-4 w-4" />
                            Add Resource
                        </button>
                    </DialogTrigger>
                    <DialogContent className="sm:max-w-[720px] border-zinc-800 bg-zinc-950 text-zinc-200">
                        {/* Creation Modal Content - Keep mostly same but simplified if needed */}
                        <DialogHeader>
                            <DialogTitle className="text-xl font-medium tracking-tight">Create Scoped Resource</DialogTitle>
                        </DialogHeader>
                        <div className="grid gap-4 py-4">
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
                                    <input
                                        list="resource-types-list-modal"
                                        value={resourceType}
                                        onChange={(event) => {
                                            setResourceType(event.target.value);
                                            if (RESOURCE_TEMPLATES[event.target.value]) {
                                                applyTemplate(event.target.value);
                                            }
                                        }}
                                        className="w-full rounded-md border border-zinc-800 bg-zinc-900 p-3 text-sm text-zinc-300 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                                        placeholder="mailbox, identity..."
                                    />
                                    <datalist id="resource-types-list-modal">
                                        {RESOURCE_TYPE_OPTIONS.map((option) => (
                                            <option key={option} value={option} />
                                        ))}
                                    </datalist>
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
                                        placeholder="finance-inbox..."
                                    />
                                </label>
                                <label className="space-y-1.5 text-sm">
                                    <span className="text-zinc-500">Display Name</span>
                                    <input
                                        value={displayName}
                                        onChange={(event) => setDisplayName(event.target.value)}
                                        className="w-full rounded-md border border-zinc-800 bg-zinc-900 p-3 text-sm text-zinc-300 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                                        placeholder="ACME Finance"
                                    />
                                </label>
                            </div>
                            <div className="grid gap-4">
                                <label className="space-y-1.5 text-sm">
                                    <span className="text-zinc-500">Initial Configuration</span>
                                    <textarea
                                        value={configText}
                                        onChange={(event) => setConfigText(event.target.value)}
                                        className="h-32 w-full resize-y rounded-md border border-zinc-800 bg-zinc-900 p-3 font-mono text-sm text-zinc-300 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                                    />
                                </label>
                            </div>
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

            <div className="flex flex-1 overflow-hidden rounded-xl border border-zinc-800/80 bg-zinc-900/20 backdrop-blur-sm">
                {/* Sidebar Explorer */}
                <div className="w-80 flex flex-col border-r border-zinc-800/80 bg-zinc-900/40">
                    <div className="p-4 border-b border-zinc-800/50">
                        <div className="relative group">
                            <Search className="absolute left-3 top-2.5 h-4 w-4 text-zinc-500 group-focus-within:text-indigo-400 transition-colors" />
                            <input
                                type="text"
                                placeholder="Filter resources..."
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                className="w-full rounded-md border border-zinc-800 bg-zinc-950/50 pl-9 pr-3 py-2 text-xs text-zinc-300 placeholder:text-zinc-600 outline-none focus:border-indigo-500/50 transition-all"
                            />
                        </div>
                    </div>
                    
                    <div className="flex-1 overflow-y-auto py-2 custom-scrollbar">
                        {Object.entries(groupedResources).map(([categoryId, category]: [string, any]) => (
                            <div key={categoryId} className="mb-1">
                                <button
                                    onClick={() => toggleGroup(categoryId)}
                                    className="flex w-full items-center gap-2 px-4 py-2 text-xs font-bold uppercase tracking-wider text-zinc-500 hover:text-zinc-300 transition-colors"
                                >
                                    {expandedGroups.has(categoryId) ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                                    <category.icon className="h-3.5 w-3.5 text-indigo-400/70" />
                                    {category.label}
                                </button>
                                
                                {expandedGroups.has(categoryId) && (
                                    <div className="pl-4 space-y-0.5">
                                        {Object.entries(category.items).map(([scopeKey, scope]: [string, any]) => (
                                            <div key={scopeKey}>
                                                <div className="px-4 py-1.5 flex items-center gap-2 text-[11px] font-medium text-zinc-400">
                                                    <Folder className="h-3 w-3 text-emerald-500/50" />
                                                    {scope.name}
                                                </div>
                                                <div className="pl-4 border-l border-zinc-800/50 ml-5 space-y-0.5">
                                                    {Object.entries(scope.types).map(([typeName, resourcesOfType]: [string, any]) => (
                                                        <div key={typeName}>
                                                            <div className="px-3 py-1 text-[10px] font-bold text-zinc-600 uppercase tracking-widest">{typeName}</div>
                                                            {resourcesOfType.map((r: ResourceRecord) => (
                                                                <button
                                                                    key={r.id}
                                                                    onClick={() => selectResource(r)}
                                                                    className={cn(
                                                                        "w-full flex items-center gap-2 px-3 py-1.5 text-xs rounded-l-md transition-all group",
                                                                        selectedResourceId === r.id 
                                                                            ? "bg-indigo-500/10 text-indigo-400 border-r-2 border-indigo-500" 
                                                                            : "text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200"
                                                                    )}
                                                                >
                                                                    <FileText className={cn("h-3.5 w-3.5", selectedResourceId === r.id ? "text-indigo-400" : "text-zinc-500 group-hover:text-zinc-400")} />
                                                                    <span className="truncate">{r.displayName || r.name}</span>
                                                                </button>
                                                            ))}
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                </div>

                {/* Main Content / Editor */}
                <div className="flex-1 flex flex-col bg-zinc-950/40 overflow-hidden">
                    {selectedResource ? (
                        <div className="flex-1 flex flex-col overflow-hidden">
                            {/* Editor Header */}
                            <div className="flex flex-wrap items-center justify-between gap-4 p-6 border-b border-zinc-800/50 bg-zinc-900/20">
                                <div className="space-y-1">
                                    <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.2em] font-bold text-zinc-500">
                                        <span>{selectedResource.scopeType}</span>
                                        <ChevronRight className="h-2.5 w-2.5" />
                                        <span>{selectedResource.resourceType}</span>
                                    </div>
                                    <h2 className="text-xl font-semibold text-zinc-100">{selectedResource.displayName || selectedResource.name}</h2>
                                </div>
                                <div className="flex items-center gap-3">
                                    <button
                                        onClick={() => void handleDelete(selectedResource.id)}
                                        className="flex items-center gap-2 rounded-md border border-zinc-800 px-3 py-1.5 text-xs font-semibold text-zinc-400 transition-colors hover:border-rose-500/30 hover:text-rose-400"
                                    >
                                        <Trash2 className="h-3.5 w-3.5" />
                                        Archive
                                    </button>
                                    <button
                                        onClick={() => void handleCreate()}
                                        disabled={isSaving}
                                        className="flex items-center gap-2 rounded-md bg-zinc-100 px-4 py-1.5 text-xs font-bold text-zinc-950 shadow-sm transition-all hover:bg-white disabled:opacity-50"
                                    >
                                        {isSaving ? "Saving..." : "Save Changes"}
                                    </button>
                                </div>
                            </div>
                            
                            {/* Editor Body */}
                            <div className="flex-1 overflow-y-auto p-6 space-y-6 custom-scrollbar">
                                <div className="grid gap-6 md:grid-cols-2">
                                    <div className="space-y-4">
                                        <div className="grid grid-cols-2 gap-4">
                                            <label className="block space-y-1.5">
                                                <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Resource Name (Key)</span>
                                                <input
                                                    value={name}
                                                    onChange={(e) => setName(e.target.value)}
                                                    className="w-full rounded-md border border-zinc-800 bg-zinc-900/50 p-2 text-sm text-zinc-200 outline-none focus:border-indigo-500/50 font-mono"
                                                />
                                            </label>
                                            <label className="block space-y-1.5">
                                                <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Display Name</span>
                                                <input
                                                    value={displayName}
                                                    onChange={(e) => setDisplayName(e.target.value)}
                                                    className="w-full rounded-md border border-zinc-800 bg-zinc-900/50 p-2 text-sm text-zinc-200 outline-none focus:border-indigo-500/50"
                                                />
                                            </label>
                                        </div>
                                        <div className="grid grid-cols-2 gap-4">
                                            <label className="block space-y-1.5">
                                                <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Resource Type</span>
                                                <input
                                                    list="resource-types-list-editor"
                                                    value={resourceType}
                                                    onChange={(e) => setResourceType(e.target.value)}
                                                    className="w-full rounded-md border border-zinc-800 bg-zinc-900/50 p-2 text-sm text-zinc-200 outline-none focus:border-indigo-500/50"
                                                />
                                                <datalist id="resource-types-list-editor">
                                                    {RESOURCE_TYPE_OPTIONS.map((option) => (
                                                        <option key={option} value={option} />
                                                    ))}
                                                </datalist>
                                            </label>
                                            <label className="block space-y-1.5">
                                                <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Provider</span>
                                                <input
                                                    value={provider}
                                                    onChange={(e) => setProvider(e.target.value)}
                                                    className="w-full rounded-md border border-zinc-800 bg-zinc-900/50 p-2 text-sm text-zinc-200 outline-none focus:border-indigo-500/50"
                                                />
                                            </label>
                                        </div>
                                        <div className="grid grid-cols-2 gap-4">
                                            <div className="space-y-1.5">
                                                <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Ownership</span>
                                                <div className="rounded-md border border-zinc-800 bg-zinc-900/10 px-3 py-2 text-sm text-zinc-500 font-mono">
                                                    {selectedResource.ownership}
                                                </div>
                                            </div>
                                            <div className="space-y-1.5">
                                                <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Scope Type</span>
                                                <div className="rounded-md border border-zinc-800 bg-zinc-900/10 px-3 py-2 text-sm text-zinc-500 font-mono">
                                                    {selectedResource.scopeType}
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                    <div className="space-y-2">
                                        <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Resource Info</div>
                                        <div className="rounded-xl border border-indigo-500/10 bg-indigo-500/5 p-4 text-xs leading-relaxed text-indigo-300/80">
                                            {(RESOURCE_TEMPLATES[selectedResource.resourceType] || RESOURCE_TEMPLATES.external_account).helper}
                                        </div>
                                    </div>
                                </div>
                                
                                <div className="space-y-2 flex-1 flex flex-col min-h-[400px]">
                                    <div className="flex items-center justify-between">
                                        <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Configuration (Markdown)</span>
                                        <span className="text-[10px] font-mono text-zinc-600">Updated: {new Date(selectedResource.updatedAt).toLocaleString()}</span>
                                    </div>
                                    <textarea
                                        value={configText}
                                        onChange={(e) => setConfigText(e.target.value)}
                                        className="flex-1 w-full rounded-md border border-zinc-800 bg-zinc-900/50 p-4 font-mono text-sm text-zinc-100 outline-none focus:border-indigo-500/50 resize-none shadow-inner"
                                    />
                                </div>
                                
                                {error && (
                                    <div className="rounded-md border border-rose-500/20 bg-rose-500/5 p-3 text-sm text-rose-400 font-medium">
                                        {error}
                                    </div>
                                )}
                            </div>
                        </div>
                    ) : (
                        <div className="flex-1 flex flex-col items-center justify-center p-12 text-center">
                            <div className="w-16 h-16 rounded-2xl bg-zinc-900 border border-zinc-800 flex items-center justify-center mb-6 shadow-xl">
                                <Database className="h-8 w-8 text-zinc-600" />
                            </div>
                            <h3 className="text-xl font-medium text-zinc-300 mb-2">Select a resource</h3>
                            <p className="max-w-xs text-sm text-zinc-500 leading-relaxed">
                                Browse your company, customer, or project scoped configuration files in the explorer to the left.
                            </p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

