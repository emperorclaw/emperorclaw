
"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  FileText,
  Link2,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Tags,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

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
  configText: string;
  secretText?: string;
  createdAt: string | Date;
  updatedAt: string | Date;
  deletedAt?: string | Date | null;
  isShared: boolean;
};

type ScopeOption = { id: string; name: string };
type BrainLink = { id: string; sourceResourceId: string; targetResourceId: string | null; linkText: string; linkType: string };
type BrainTag = { id: string; tag: string; resourceId: string };
type BrainVersion = { id: string; configText: string; changeSummary: string | null; createdAt: string | Date; createdByType: string };
type BrainProposal = {
  id: string;
  title: string;
  action: string;
  scopeType: string;
  scopeId: string | null;
  targetResourceId: string | null;
  proposedText: string;
  reason: string | null;
  status: string;
  createdAt: string | Date;
};
type GraphNode = { id: string; label: string; scopeType: string; resourceType: string; isShared: boolean; tags: string[] };
type GraphEdge = { id: string; source: string; target: string | null; label: string; unresolved: boolean };

type BrainInsights = {
  outgoing: BrainLink[];
  backlinks: BrainLink[];
  tags: BrainTag[];
  versions: BrainVersion[];
  graph: { nodes: GraphNode[]; edges: GraphEdge[] };
};

const EMPTY_INSIGHTS: BrainInsights = { outgoing: [], backlinks: [], tags: [], versions: [], graph: { nodes: [], edges: [] } };

function slugifyResourceKey(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "untitled-note";
}

function scopeLabel(scopeType: string) {
  return { company: "Company", customer: "Customer", project: "Project", agent: "Agent" }[scopeType] || scopeType;
}

function dateLabel(value: string | Date) {
  return new Date(value).toLocaleString();
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
  const [selectedResourceId, setSelectedResourceId] = useState(initialResources[0]?.id || null);
  const [mode, setMode] = useState<"edit" | "preview">("preview");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "shared">("all");
  const [draftTitle, setDraftTitle] = useState(initialResources[0]?.displayName || initialResources[0]?.name || "");
  const [draftContent, setDraftContent] = useState(initialResources[0]?.configText || "");
  const [draftScopeType, setDraftScopeType] = useState(initialResources[0]?.scopeType || "company");
  const [draftScopeId, setDraftScopeId] = useState(initialResources[0]?.scopeId || "");
  const [draftShared, setDraftShared] = useState(Boolean(initialResources[0]?.isShared));
  const [insights, setInsights] = useState<BrainInsights>(EMPTY_INSIGHTS);
  const [proposals, setProposals] = useState<BrainProposal[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);

  const scopeOptions = useMemo(() => ({ customer: customers, project: projects, agent: agents }), [agents, customers, projects]);
  const selectedResource = useMemo(() => resources.find((resource) => resource.id === selectedResourceId) || null, [resources, selectedResourceId]);
  const pendingProposals = useMemo(() => proposals.filter((proposal) => proposal.status === "pending"), [proposals]);

  const filteredResources = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return resources.filter((resource) => {
      const haystack = `${resource.name} ${resource.displayName || ""} ${resource.configText}`.toLowerCase();
      if (normalized && !haystack.includes(normalized)) return false;
      if (filter === "shared") return resource.isShared;
      return true;
    });
  }, [filter, query, resources]);

  const groupedResources = useMemo(() => {
    const groups = [
      { key: "company", label: "Company", items: filteredResources.filter((resource) => resource.scopeType === "company") },
      { key: "customer", label: "Customers", items: filteredResources.filter((resource) => resource.scopeType === "customer") },
      { key: "project", label: "Projects", items: filteredResources.filter((resource) => resource.scopeType === "project") },
      { key: "agent", label: "Agents", items: filteredResources.filter((resource) => resource.scopeType === "agent") },
    ];
    return groups.filter((group) => group.items.length > 0);
  }, [filteredResources]);

  useEffect(() => {
    if (!selectedResource) return;
    setDraftTitle(selectedResource.displayName || selectedResource.name);
    setDraftContent(selectedResource.configText || "");
    setDraftScopeType(selectedResource.scopeType);
    setDraftScopeId(selectedResource.scopeId || "");
    setDraftShared(Boolean(selectedResource.isShared));
    void loadBrainInsights(selectedResource.id);
  }, [selectedResource]);

  useEffect(() => {
    void loadProposals();
  }, []);

  async function loadBrainInsights(resourceId: string) {
    try {
      const [backlinksRes, graphRes] = await Promise.all([
        fetch(`/api/resources/${resourceId}/backlinks`, { cache: "no-store" }),
        fetch(`/api/resources/${resourceId}/graph`, { cache: "no-store" }),
      ]);
      const backlinksBody = await backlinksRes.json();
      const graphBody = await graphRes.json();
      setInsights({
        outgoing: backlinksBody.outgoing || [],
        backlinks: backlinksBody.backlinks || [],
        tags: backlinksBody.tags || [],
        versions: backlinksBody.versions || [],
        graph: graphBody || { nodes: [], edges: [] },
      });
    } catch (error) {
      console.error(error);
      toast.error("Could not load related knowledge metadata");
    }
  }

  async function loadProposals() {
    const response = await fetch("/api/resources/proposals?status=pending", { cache: "no-store" });
    if (response.ok) {
      const body = await response.json();
      setProposals(body.proposals || []);
    }
  }

  async function refreshResources() {
    const response = await fetch("/api/resources", { cache: "no-store" });
    if (response.ok) setResources((await response.json()).resources || []);
  }

  async function createResource() {
    const title = "New Knowledge Rule";
    const response = await fetch("/api/resources", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scopeType: "company",
        scopeId: null,
        provider: "knowledge",
        resourceType: "knowledge_base",
        name: slugifyResourceKey(title),
        displayName: title,
        configText: "# New Knowledge Rule\n\nWrite reusable company knowledge, SOPs, customer context, or agent rules here.",
        isShared: false,
      }),
    });
    const body = await response.json();
    if (!response.ok) return toast.error(body.error || "Failed to create rule");
    setResources((current) => [body.resource, ...current]);
    setSelectedResourceId(body.resource.id);
    setMode("edit");
    toast.success("Knowledge rule created");
  }

  async function saveSelectedResource() {
    if (!selectedResource || isSaving) return;
    setIsSaving(true);
    try {
      const response = await fetch(`/api/resources/${selectedResource.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: slugifyResourceKey(draftTitle),
          displayName: draftTitle,
          scopeType: draftScopeType,
          scopeId: draftScopeType === "company" ? null : draftScopeId || null,
          provider: selectedResource.provider || "knowledge",
          resourceType: selectedResource.resourceType || "knowledge_base",
          configText: draftContent,
          isShared: draftShared,
          changeSummary: "Operator updated Knowledge & Rules entry",
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Failed to save rule");
      setResources((current) => current.map((resource) => resource.id === selectedResource.id ? { ...resource, ...body.resource } : resource));
      await loadBrainInsights(selectedResource.id);
      toast.success("Knowledge rule saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save rule");
    } finally {
      setIsSaving(false);
    }
  }

  async function archiveSelectedResource() {
    if (!selectedResource || !confirm("Archive this Knowledge & Rules entry?")) return;
    const response = await fetch(`/api/resources/${selectedResource.id}`, { method: "DELETE" });
    if (!response.ok) return toast.error("Failed to archive rule");
    setResources((current) => current.filter((resource) => resource.id !== selectedResource.id));
    setSelectedResourceId(resources.find((resource) => resource.id !== selectedResource.id)?.id || null);
    toast.success("Knowledge rule archived");
  }

  async function reviewProposal(proposal: BrainProposal, status: "approved" | "rejected" | "merged") {
    const response = await fetch(`/api/resources/proposals/${proposal.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return toast.error(body.error || "Failed to review suggestion");
    await loadProposals();
    await refreshResources();
    if (selectedResource) await loadBrainInsights(selectedResource.id);
    toast.success(status === "rejected" ? "Suggestion rejected" : "Suggestion applied");
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-indigo-500/30 bg-indigo-500/15 text-indigo-300">
              <FileText className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Knowledge & Rules</h1>
              <p className="text-sm text-zinc-500">Company Brain keeps reusable doctrine, SOPs, customer context, and agent rules in one governed place.</p>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={refreshResources} className="inline-flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-300 transition-colors hover:bg-zinc-800">
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>
          <button onClick={createResource} className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-indigo-500">
            <Plus className="h-4 w-4" /> New rule
          </button>
          <button onClick={saveSelectedResource} disabled={!selectedResource || isSaving} className="inline-flex items-center gap-2 rounded-lg bg-zinc-100 px-4 py-2 text-sm font-semibold text-zinc-950 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-50">
            <Check className="h-4 w-4" /> {isSaving ? "Saving..." : "Save"}
          </button>
        </div>
      </header>

      <div className="grid min-h-[calc(100vh-210px)] grid-cols-1 overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 lg:grid-cols-[320px_minmax(0,1fr)_360px]">
        <aside className="border-b border-zinc-800 bg-zinc-950/80 p-4 lg:border-b-0 lg:border-r">
          <div className="relative">
            <Search className="absolute left-3 top-3 h-4 w-4 text-zinc-500" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search knowledge..." className="h-10 w-full rounded-lg border border-zinc-800 bg-zinc-900 py-2 pl-9 pr-3 text-sm text-zinc-100 outline-none focus:border-indigo-500" />
          </div>
          <div className="mt-3 flex gap-2">
            {(["all", "shared"] as const).map((item) => (
              <button key={item} onClick={() => setFilter(item)} className={cn("rounded-md px-3 py-1.5 text-xs font-medium capitalize transition-colors", filter === item ? "bg-zinc-800 text-zinc-100 ring-1 ring-zinc-700" : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300")}>{item}</button>
            ))}
          </div>
          <div className="mt-4 grid grid-cols-3 gap-2">
            <Stat label="Rules" value={resources.length} />
            <Stat label="Shared" value={resources.filter((resource) => resource.isShared).length} />
            <Stat label="Review" value={pendingProposals.length} />
          </div>
          <div className="mt-4 max-h-[calc(100vh-410px)] space-y-4 overflow-y-auto pr-1">
            {groupedResources.map((group) => (
              <div key={group.key}>
                <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-600">
                  <ChevronDown className="h-3.5 w-3.5" /> {group.label}
                </div>
                <div className="space-y-2 border-l border-zinc-800 pl-3">
                  {group.items.map((resource) => (
                    <button key={resource.id} onClick={() => setSelectedResourceId(resource.id)} className={cn("w-full rounded-xl border p-3 text-left transition-colors", selectedResourceId === resource.id ? "border-indigo-500/50 bg-indigo-500/10" : "border-zinc-800 bg-zinc-900/50 hover:border-zinc-700 hover:bg-zinc-900")}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-zinc-100">{resource.displayName || resource.name}</div>
                          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
                            <span>{scopeLabel(resource.scopeType)}</span>
                            {resource.isShared && <span className="rounded bg-indigo-500/10 px-1.5 py-0.5 text-indigo-300">Shared</span>}
                          </div>
                        </div>
                        <FileText className="h-4 w-4 shrink-0 text-zinc-600" />
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ))}
            {!filteredResources.length && <EmptyState>No matching rules.</EmptyState>}
          </div>
        </aside>

        <main className="min-h-0 bg-zinc-950 p-4">
          {selectedResource ? (
            <div className="flex h-full min-h-[620px] flex-col rounded-xl border border-zinc-800 bg-zinc-900/30">
              <div className="border-b border-zinc-800 p-4">
                <input value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} className="w-full bg-transparent text-xl font-semibold text-zinc-100 outline-none" />
                <div className="mt-3 flex gap-2">
                  <button onClick={() => setMode("preview")} className={cn("rounded-md px-3 py-1.5 text-xs font-medium", mode === "preview" ? "bg-zinc-800 text-white" : "text-zinc-500 hover:text-zinc-300")}>Preview</button>
                  <button onClick={() => setMode("edit")} className={cn("rounded-md px-3 py-1.5 text-xs font-medium", mode === "edit" ? "bg-zinc-800 text-white" : "text-zinc-500 hover:text-zinc-300")}>Edit markdown</button>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-auto p-4">
                {mode === "edit" ? (
                  <textarea value={draftContent} onChange={(event) => setDraftContent(event.target.value)} className="h-full min-h-[520px] w-full resize-none rounded-xl border border-zinc-800 bg-zinc-950 p-4 font-mono text-sm leading-7 text-zinc-200 outline-none focus:border-indigo-500" />
                ) : (
                  <div className="prose prose-invert max-w-none rounded-xl border border-zinc-800 bg-zinc-950/70 p-6">
                    <MarkdownRenderer content={draftContent || "*No content yet.*"} />
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex h-full min-h-[620px] items-center justify-center rounded-xl border border-dashed border-zinc-800 text-sm text-zinc-500">Select or create a Knowledge & Rules entry.</div>
          )}
        </main>

        <aside className="min-h-0 overflow-y-auto border-t border-zinc-800 bg-zinc-950/80 p-4 lg:border-l lg:border-t-0">
          {selectedResource && (
            <div className="space-y-4">
              <Panel title="Rule settings" icon={ShieldCheck}>
                <label className="text-xs font-medium text-zinc-500">Scope</label>
                <select value={draftScopeType} onChange={(event) => setDraftScopeType(event.target.value)} className="mt-1 h-10 w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none focus:border-indigo-500">
                  <option value="company">Company</option>
                  <option value="customer">Customer</option>
                  <option value="project">Project</option>
                  <option value="agent">Agent</option>
                </select>
                {draftScopeType !== "company" && (
                  <select value={draftScopeId} onChange={(event) => setDraftScopeId(event.target.value)} className="mt-2 h-10 w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none focus:border-indigo-500">
                    <option value="">Choose {scopeLabel(draftScopeType).toLowerCase()}</option>
                    {(scopeOptions[draftScopeType as "customer" | "project" | "agent"] || []).map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
                  </select>
                )}
                <button onClick={() => setDraftShared(!draftShared)} className={cn("mt-3 flex w-full items-center justify-between rounded-lg border p-3 text-sm transition-colors", draftShared ? "border-indigo-500/40 bg-indigo-500/10 text-indigo-200" : "border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:bg-zinc-900")}>
                  <span>Auto-send to matching agents</span>
                  <span className="font-semibold">{draftShared ? "On" : "Off"}</span>
                </button>
                <button onClick={archiveSelectedResource} className="mt-3 inline-flex items-center gap-2 text-xs font-medium text-zinc-500 hover:text-red-300"><Archive className="h-3.5 w-3.5" /> Archive rule</button>
              </Panel>


              {pendingProposals.length > 0 && (
                <Panel title={`Agent suggestions (${pendingProposals.length})`} icon={Clock3}>
                  <div className="space-y-3">
                    {pendingProposals.map((proposal) => <ProposalCard key={proposal.id} proposal={proposal} onReview={reviewProposal} />)}
                  </div>
                </Panel>
              )}

              <button onClick={() => setIsAdvancedOpen((open) => !open)} className="flex w-full items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900/50 p-3 text-left text-sm font-medium text-zinc-300 hover:bg-zinc-900">
                Advanced relationships
                {isAdvancedOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              </button>
              {isAdvancedOpen && (
                <div className="space-y-4">
                  <Panel title="Knowledge map" icon={Link2}>
                    <KnowledgeMap graph={insights.graph} selectedId={selectedResource.id} />
                  </Panel>
                  <Panel title="Tags" icon={Tags}>{insights.tags.length ? <TagList tags={insights.tags} /> : <EmptyState>Add #tags in markdown.</EmptyState>}</Panel>
                  <Panel title="Related notes" icon={Link2}>
                    <LinkList title="This note links to" links={insights.outgoing} empty="No outgoing links." />
                    <div className="mt-3" />
                    <LinkList title="Used by" links={insights.backlinks} empty="No notes link here yet." />
                  </Panel>
                  <Panel title="Versions" icon={Clock3}>
                    <div className="space-y-2">
                      {insights.versions.slice(0, 6).map((version) => <div key={version.id} className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3"><div className="text-xs font-medium text-zinc-200">{version.changeSummary || "Version"}</div><div className="mt-1 text-[11px] text-zinc-500">{dateLabel(version.createdAt)} - {version.createdByType}</div></div>)}
                      {!insights.versions.length && <EmptyState>Versions appear after edits.</EmptyState>}
                    </div>
                  </Panel>
                </div>
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-2"><div className="text-sm font-semibold text-zinc-100">{value}</div><div className="text-[10px] uppercase tracking-wider text-zinc-600">{label}</div></div>;
}

function Panel({ title, icon: Icon, children }: { title: string; icon: LucideIcon; children: ReactNode }) {
  return <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4"><div className="mb-3 flex items-center gap-2 text-sm font-semibold text-zinc-100"><Icon className="h-4 w-4 text-indigo-400" />{title}</div>{children}</section>;
}

function EmptyState({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-zinc-800 p-3 text-xs text-zinc-500">{children}</div>;
}

function TagList({ tags }: { tags: BrainTag[] }) {
  return <div className="flex flex-wrap gap-2">{tags.map((tag) => <span key={tag.id} className="rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-xs text-zinc-300">#{tag.tag}</span>)}</div>;
}

function LinkList({ title, links, empty }: { title: string; links: BrainLink[]; empty: string }) {
  return <div><div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-zinc-600">{title}</div>{links.length ? <div className="space-y-2">{links.map((link) => <div key={link.id} className="rounded-lg border border-zinc-800 bg-zinc-950 p-2 text-xs text-zinc-300"><span>[[{link.linkText}]]</span>{!link.targetResourceId && <span className="ml-2 text-amber-300">unresolved</span>}</div>)}</div> : <EmptyState>{empty}</EmptyState>}</div>;
}


function KnowledgeMap({ graph, selectedId }: { graph: { nodes: GraphNode[]; edges: GraphEdge[] }; selectedId: string }) {
  if (!graph.nodes.length) return <EmptyState>No map yet. Add [[links]] between rules to build one.</EmptyState>;
  return <div className="space-y-3">
    <div className="grid grid-cols-2 gap-2">
      <Stat label="Notes" value={graph.nodes.length} />
      <Stat label="Links" value={graph.edges.length} />
    </div>
    <div className="max-h-56 space-y-2 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950 p-2">
      {graph.nodes.slice(0, 12).map((node) => <div key={node.id} className={cn("rounded-md border px-2 py-1.5 text-xs", node.id === selectedId ? "border-indigo-500/50 bg-indigo-500/10 text-indigo-200" : "border-zinc-800 bg-zinc-900 text-zinc-400")}>{node.label}</div>)}
    </div>
    <p className="text-xs leading-5 text-zinc-500">This map is generated from [[links]]. It stays tucked away because most operators only need the rule and where it is used.</p>
  </div>;
}

function ProposalCard({ proposal, onReview }: { proposal: BrainProposal; onReview: (proposal: BrainProposal, status: "approved" | "rejected" | "merged") => void }) {
  return <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3"><div className="flex items-start justify-between gap-3"><div><div className="text-sm font-medium text-zinc-100">{proposal.title}</div><div className="mt-1 text-[11px] text-zinc-500">{proposal.action} - {scopeLabel(proposal.scopeType)} - {dateLabel(proposal.createdAt)}</div></div></div><pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-zinc-900 p-3 text-xs leading-5 text-zinc-300">{proposal.proposedText}</pre><div className="mt-3 flex gap-2"><button onClick={() => onReview(proposal, "approved")} className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-emerald-500"><Check className="h-3 w-3" /> Approve</button><button onClick={() => onReview(proposal, "rejected")} className="inline-flex items-center gap-1 rounded-md border border-zinc-800 px-2.5 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-900"><X className="h-3 w-3" /> Reject</button></div></div>;
}
