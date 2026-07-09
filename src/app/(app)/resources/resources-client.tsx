
"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Edit3,
  FileText,
  MoreVertical,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
} from "lucide-react";
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

function noteStatus(content: string) {
  return content.match(/^---[\s\S]*?\nstatus:\s*([A-Za-z0-9_-]+)[\s\S]*?\n---/m)?.[1]?.toLowerCase() || "active";
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
  const [filter, setFilter] = useState<"all" | "shared" | "drafts">("all");
  const [draftTitle, setDraftTitle] = useState(initialResources[0]?.displayName || initialResources[0]?.name || "");
  const [draftContent, setDraftContent] = useState(initialResources[0]?.configText || "");
  const [draftScopeType, setDraftScopeType] = useState(initialResources[0]?.scopeType || "company");
  const [draftScopeId, setDraftScopeId] = useState(initialResources[0]?.scopeId || "");
  const [draftShared, setDraftShared] = useState(Boolean(initialResources[0]?.isShared));
  const [insights, setInsights] = useState<BrainInsights>(EMPTY_INSIGHTS);
  const [isSaving, setIsSaving] = useState(false);

  const scopeOptions = useMemo(() => ({ customer: customers, project: projects, agent: agents }), [agents, customers, projects]);
  const selectedResource = useMemo(() => resources.find((resource) => resource.id === selectedResourceId) || null, [resources, selectedResourceId]);

  const filteredResources = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return resources.filter((resource) => {
      const haystack = `${resource.name} ${resource.displayName || ""} ${resource.configText}`.toLowerCase();
      if (normalized && !haystack.includes(normalized)) return false;
      if (filter === "shared") return resource.isShared;
      if (filter === "drafts") return noteStatus(resource.configText || "") === "draft";
      return true;
    });
  }, [filter, query, resources]);

  const resourceTree = useMemo(() => {
    const customerNames = new Map(customers.map((customer) => [customer.id, customer.name]));
    const projectNames = new Map(projects.map((project) => [project.id, project.name]));
    const agentNames = new Map(agents.map((agent) => [agent.id, agent.name]));
    const byScope = new Map<string, { key: string; label: string; items: ResourceRecord[] }>();

    function add(key: string, label: string, resource: ResourceRecord) {
      if (!byScope.has(key)) byScope.set(key, { key, label, items: [] });
      byScope.get(key)!.items.push(resource);
    }

    for (const resource of filteredResources) {
      if (resource.scopeType === "company") add("company", "Company", resource);
      else if (resource.scopeType === "customer") add(`customer:${resource.scopeId || "unknown"}`, customerNames.get(resource.scopeId || "") || "Unknown customer", resource);
      else if (resource.scopeType === "project") add(`project:${resource.scopeId || "unknown"}`, projectNames.get(resource.scopeId || "") || "Unknown project", resource);
      else if (resource.scopeType === "agent") add(`agent:${resource.scopeId || "unknown"}`, agentNames.get(resource.scopeId || "") || "Unknown agent", resource);
      else add(resource.scopeType, scopeLabel(resource.scopeType), resource);
    }

    const rank = (key: string) => key === "company" ? 0 : key.startsWith("customer:") ? 1 : key.startsWith("project:") ? 2 : key.startsWith("agent:") ? 3 : 4;
    return Array.from(byScope.values()).sort((a, b) => rank(a.key) - rank(b.key) || a.label.localeCompare(b.label));
  }, [agents, customers, filteredResources, projects]);

  useEffect(() => {
    if (!selectedResource) return;
    setDraftTitle(selectedResource.displayName || selectedResource.name);
    setDraftContent(selectedResource.configText || "");
    setDraftScopeType(selectedResource.scopeType);
    setDraftScopeId(selectedResource.scopeId || "");
    setDraftShared(Boolean(selectedResource.isShared));
    void loadBrainInsights(selectedResource.id);
  }, [selectedResource]);

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
        configText: "---\nscope: company\ntype: sop\nstatus: draft\nowner: operator\ntags:\n  - knowledge\n---\n\n# New Knowledge Rule\n\nWrite one reusable rule, SOP, customer context note, or agent instruction here.\n\n## Rule\n\n- \n\n## Related\n\n- [[Company Operating Doctrine]]",
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

  return (
    <div className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl shadow-black/20">
      <div className="flex h-[calc(100vh-150px)] min-h-[680px] flex-col">
        <div className="grid grid-cols-1 border-b border-zinc-800 bg-zinc-950/95 lg:grid-cols-[300px_minmax(0,1fr)_360px]">
          <div className="flex h-11 items-center justify-between border-b border-zinc-800 px-3 lg:border-b-0 lg:border-r">
            <div className="flex items-center gap-1.5 text-zinc-500">
              <button className="rounded p-1 transition-colors hover:bg-zinc-900 hover:text-zinc-200" aria-label="New note" onClick={createResource}><FileText className="h-4 w-4" /></button>
              <button className="rounded p-1 transition-colors hover:bg-zinc-900 hover:text-zinc-200" aria-label="New linked note" onClick={createResource}><Plus className="h-4 w-4" /></button>
              <button className="rounded p-1 transition-colors hover:bg-zinc-900 hover:text-zinc-200" aria-label="Refresh vault" onClick={refreshResources}><RefreshCw className="h-4 w-4" /></button>
            </div>
            <button className="rounded p-1 text-zinc-500 transition-colors hover:bg-zinc-900 hover:text-zinc-200" aria-label="Vault settings"><SlidersHorizontal className="h-4 w-4" /></button>
          </div>
          <div className="flex h-11 items-center justify-between border-b border-zinc-800 px-4 lg:border-b-0 lg:border-r">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex items-center gap-1 text-zinc-600">
                <button className="rounded p-1 transition-colors hover:bg-zinc-900 hover:text-zinc-300" aria-label="Previous note"><ArrowLeft className="h-4 w-4" /></button>
                <button className="rounded p-1 transition-colors hover:bg-zinc-900 hover:text-zinc-300" aria-label="Next note"><ArrowRight className="h-4 w-4" /></button>
              </div>
              <div className="min-w-0 truncate text-xs text-zinc-500">
                <span>Knowledge & Rules</span>
                {selectedResource && <span className="text-zinc-700"> / </span>}
                {selectedResource && <span className="text-zinc-300">{draftTitle || "Untitled note"}</span>}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5 text-zinc-500">
              <button onClick={() => setMode(mode === "preview" ? "edit" : "preview")} className="rounded p-1 transition-colors hover:bg-zinc-900 hover:text-zinc-200" aria-label="Toggle editor mode"><Edit3 className="h-4 w-4" /></button>
              <button onClick={saveSelectedResource} disabled={!selectedResource || isSaving} className="inline-flex items-center gap-1 rounded-md border border-zinc-800 px-2 py-1 text-[11px] font-medium text-zinc-300 transition-colors hover:bg-zinc-900 disabled:cursor-not-allowed disabled:opacity-50">
                <Check className="h-3.5 w-3.5" /> {isSaving ? "Saving" : "Save"}
              </button>
              <button className="rounded p-1 transition-colors hover:bg-zinc-900 hover:text-zinc-200" aria-label="More actions"><MoreVertical className="h-4 w-4" /></button>
            </div>
          </div>
          <div className="hidden h-11 items-center border-zinc-800 px-4 lg:flex">
            <div className="min-w-0 truncate text-xs text-zinc-500">
              Knowledge graph
              {selectedResource && <span className="text-zinc-700"> / </span>}
              {selectedResource && <span className="text-zinc-300">Graph of {draftTitle || "Untitled note"}</span>}
            </div>
          </div>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)_360px]">
          <aside className="flex min-h-0 flex-col border-b border-zinc-800 bg-zinc-950 lg:border-b-0 lg:border-r">
            <div className="border-b border-zinc-800 p-3">
              <div className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Vault explorer</div>
              <div className="relative">
                <Search className="absolute left-3 top-2.5 h-4 w-4 text-zinc-600" />
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search notes..." className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900 py-2 pl-9 pr-3 text-sm text-zinc-100 outline-none focus:border-indigo-500" />
              </div>
              <div className="mt-3 flex items-center gap-2">
                {(["all", "shared", "drafts"] as const).map((item) => (
                  <button key={item} onClick={() => setFilter(item)} className={cn("rounded-md px-2.5 py-1 text-[11px] font-medium capitalize transition-colors", filter === item ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300")}>{item}</button>
                ))}
                <span className="ml-auto text-[11px] text-zinc-600">{filteredResources.length} notes</span>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              <div className="space-y-3">
                {resourceTree.map((group) => (
                  <div key={group.key}>
                    <div className="mb-1 flex items-center gap-2 rounded-md px-1.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                      <ChevronDown className="h-3.5 w-3.5" />
                      <span className="truncate">{group.label}</span>
                      <span className="ml-auto text-zinc-700">{group.items.length}</span>
                    </div>
                    <div className="space-y-0.5 pl-4">
                      {group.items.map((resource) => (
                        <button key={resource.id} onClick={() => setSelectedResourceId(resource.id)} className={cn("group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors", selectedResourceId === resource.id ? "bg-indigo-500/15 text-indigo-100" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100")}>
                          <FileText className={cn("h-3.5 w-3.5 shrink-0", selectedResourceId === resource.id ? "text-indigo-300" : "text-zinc-600 group-hover:text-zinc-400")} />
                          <span className="min-w-0 flex-1 truncate">{resource.displayName || resource.name}</span>
                          {noteStatus(resource.configText || "") === "draft" && <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-amber-300">draft</span>}
                          {resource.isShared && <span className="h-1.5 w-1.5 rounded-full bg-indigo-400" title="Shared with agents" />}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
                {!filteredResources.length && <EmptyState>No matching notes.</EmptyState>}
              </div>
            </div>
          </aside>

          <main className="flex min-h-0 flex-col bg-zinc-950">
            {selectedResource ? (
              <>
                <div className="flex items-center justify-between gap-3 border-b border-zinc-800 bg-zinc-950/90 px-4 py-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <FileText className="h-4 w-4 shrink-0 text-zinc-500" />
                    <input value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} className="min-w-0 flex-1 bg-transparent text-sm font-medium text-zinc-100 outline-none" />
                    {noteStatus(draftContent) === "draft" && <span className="rounded border border-amber-500/20 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-amber-300">draft</span>}
                    {draftShared && <span className="rounded border border-indigo-500/20 bg-indigo-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-indigo-300">shared</span>}
                  </div>
                  <div className="flex shrink-0 rounded-md border border-zinc-800 bg-zinc-900 p-0.5">
                    <button onClick={() => setMode("preview")} className={cn("rounded px-2.5 py-1 text-[11px] font-medium", mode === "preview" ? "bg-zinc-700 text-white" : "text-zinc-500 hover:text-zinc-300")}>Reading</button>
                    <button onClick={() => setMode("edit")} className={cn("rounded px-2.5 py-1 text-[11px] font-medium", mode === "edit" ? "bg-zinc-700 text-white" : "text-zinc-500 hover:text-zinc-300")}>Source</button>
                  </div>
                </div>
                <div className="min-h-0 flex-1 overflow-auto">
                  {mode === "edit" ? (
                    <textarea value={draftContent} onChange={(event) => setDraftContent(event.target.value)} className="h-full min-h-[620px] w-full resize-none bg-zinc-950 px-8 py-7 font-mono text-sm leading-7 text-zinc-200 outline-none selection:bg-indigo-500/30" />
                  ) : (
                    <article className="mx-auto min-h-full max-w-4xl px-8 py-8">
                      <div className="prose prose-invert max-w-none">
                        <MarkdownRenderer content={draftContent || "*No content yet.*"} />
                      </div>
                    </article>
                  )}
                </div>
              </>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-zinc-500">Select or create a note.</div>
            )}
          </main>

          <aside className="flex min-h-0 flex-col border-t border-zinc-800 bg-zinc-950 lg:border-l lg:border-t-0">
            {selectedResource && (
              <>
                <div className="min-h-0 flex-1">
                  <LocalGraph graph={insights.graph} selectedId={selectedResource.id} />
                </div>

                <div className="border-t border-zinc-800 p-3">
                  <div className="grid grid-cols-3 gap-2 text-center text-[11px] text-zinc-500">
                    <div className="rounded-md border border-zinc-800 bg-zinc-900/50 px-2 py-1"><span className="text-zinc-200">{insights.backlinks.length}</span> incoming</div>
                    <div className="rounded-md border border-zinc-800 bg-zinc-900/50 px-2 py-1"><span className="text-zinc-200">{insights.outgoing.length}</span> outgoing</div>
                    <div className="rounded-md border border-zinc-800 bg-zinc-900/50 px-2 py-1"><span className="text-zinc-200">{draftContent.split(/\s+/).filter(Boolean).length}</span> words</div>
                  </div>
                  <details className="mt-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                    <summary className="cursor-pointer text-xs font-semibold text-zinc-300">Properties</summary>
                    <div className="mt-3">
                      <label className="text-[11px] font-medium uppercase tracking-wider text-zinc-600">Scope</label>
                      <select value={draftScopeType} onChange={(event) => setDraftScopeType(event.target.value)} className="mt-1 h-9 w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 text-sm text-zinc-100 outline-none focus:border-indigo-500">
                        <option value="company">Company</option>
                        <option value="customer">Customer</option>
                        <option value="project">Project</option>
                        <option value="agent">Agent</option>
                      </select>
                      {draftScopeType !== "company" && (
                        <select value={draftScopeId} onChange={(event) => setDraftScopeId(event.target.value)} className="mt-2 h-9 w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 text-sm text-zinc-100 outline-none focus:border-indigo-500">
                          <option value="">Choose {scopeLabel(draftScopeType).toLowerCase()}</option>
                          {(scopeOptions[draftScopeType as "customer" | "project" | "agent"] || []).map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
                        </select>
                      )}
                      <button onClick={() => setDraftShared(!draftShared)} className={cn("mt-3 flex w-full items-center justify-between rounded-md border p-2 text-xs transition-colors", draftShared ? "border-indigo-500/40 bg-indigo-500/10 text-indigo-200" : "border-zinc-800 bg-zinc-950 text-zinc-400 hover:bg-zinc-900")}>
                        <span>Send to matching agents</span>
                        <span className="font-semibold">{draftShared ? "On" : "Off"}</span>
                      </button>
                      {insights.tags.length > 0 && <div className="mt-3"><TagList tags={insights.tags} /></div>}
                      <button onClick={archiveSelectedResource} className="mt-3 inline-flex items-center gap-2 text-xs font-medium text-zinc-600 hover:text-red-300"><Archive className="h-3.5 w-3.5" /> Archive note</button>
                    </div>
                  </details>
                  <details className="mt-2 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                    <summary className="cursor-pointer text-xs font-semibold text-zinc-300">Linked mentions</summary>
                    <div className="mt-3">
                      <LinkList title="Outgoing" links={insights.outgoing} empty="No outgoing links." />
                      <div className="mt-3" />
                      <LinkList title="Incoming" links={insights.backlinks} empty="No incoming links yet." />
                    </div>
                  </details>
                </div>
              </>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
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


function LocalGraph({ graph, selectedId }: { graph: { nodes: GraphNode[]; edges: GraphEdge[] }; selectedId: string }) {
  const nodes = graph.nodes.length ? graph.nodes.slice(0, 14) : [{ id: selectedId, label: "Current note", scopeType: "company", resourceType: "knowledge_base", isShared: false, tags: [] }];
  const centerIndex = Math.max(0, nodes.findIndex((node) => node.id === selectedId));
  const positioned = nodes.map((node, index) => {
    if (index === centerIndex) return { node, x: 180, y: 230 };
    const ringIndex = index > centerIndex ? index - 1 : index;
    const angle = (ringIndex / Math.max(1, nodes.length - 1)) * Math.PI * 2 - Math.PI / 5;
    const radius = ringIndex % 2 === 0 ? 118 : 152;
    return { node, x: 180 + Math.cos(angle) * radius, y: 230 + Math.sin(angle) * radius };
  });
  const byId = new Map(positioned.map((item) => [item.node.id, item]));
  const edges = graph.edges.filter((edge) => edge.target && byId.has(edge.source) && byId.has(edge.target)).slice(0, 18);

  return (
    <div className="relative h-full min-h-[360px] overflow-hidden bg-[radial-gradient(circle_at_50%_35%,rgba(99,102,241,0.16),transparent_32%),#09090b]">
      <svg viewBox="0 0 360 460" className="h-full w-full" role="img" aria-label="Local knowledge graph">
        <defs>
          <radialGradient id="selected-node" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#a78bfa" stopOpacity="1" />
            <stop offset="100%" stopColor="#7c3aed" stopOpacity="0.7" />
          </radialGradient>
        </defs>
        {edges.map((edge) => {
          const source = byId.get(edge.source)!;
          const target = byId.get(edge.target!)!;
          return <line key={edge.id} x1={source.x} y1={source.y} x2={target.x} y2={target.y} stroke="#3f3f46" strokeWidth="1" opacity="0.75" />;
        })}
        {positioned.map(({ node, x, y }) => {
          const selected = node.id === selectedId;
          return (
            <g key={node.id}>
              <circle cx={x} cy={y} r={selected ? 8 : 4.5} fill={selected ? "url(#selected-node)" : node.isShared ? "#818cf8" : "#71717a"} />
              <text x={x + 8} y={y + 4} fill={selected ? "#e9d5ff" : "#a1a1aa"} fontSize="9" className="select-none">{node.label.slice(0, 28)}</text>
            </g>
          );
        })}
      </svg>
      <p className="absolute bottom-3 left-3 right-3 rounded-md border border-zinc-800 bg-zinc-950/80 px-3 py-2 text-[11px] leading-4 text-zinc-500 backdrop-blur">
        Local graph is generated from [[links]] and inferred title mentions.
      </p>
    </div>
  );
}
