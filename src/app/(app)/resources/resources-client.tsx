"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Archive,
  BrainCircuit,
  Check,
  Clock3,
  FileText,
  GitBranch,
  Link2,
  Network,
  Plus,
  Search,
  Send,
  Share2,
  ShieldCheck,
  Sparkles,
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
const TABS = ["edit", "preview", "graph", "feed"] as const;
type BrainTab = (typeof TABS)[number];

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
  const [activeTab, setActiveTab] = useState<BrainTab>("preview");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "shared" | "orphans" | "stale">("all");
  const [draftTitle, setDraftTitle] = useState(initialResources[0]?.displayName || initialResources[0]?.name || "");
  const [draftContent, setDraftContent] = useState(initialResources[0]?.configText || "");
  const [draftScopeType, setDraftScopeType] = useState(initialResources[0]?.scopeType || "company");
  const [draftScopeId, setDraftScopeId] = useState(initialResources[0]?.scopeId || "");
  const [draftShared, setDraftShared] = useState(Boolean(initialResources[0]?.isShared));
  const [insights, setInsights] = useState<BrainInsights>(EMPTY_INSIGHTS);
  const [proposals, setProposals] = useState<BrainProposal[]>([]);
  const [proposalText, setProposalText] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  const scopeOptions = useMemo(() => ({ customer: customers, project: projects, agent: agents }), [agents, customers, projects]);
  const selectedResource = useMemo(() => resources.find((resource) => resource.id === selectedResourceId) || null, [resources, selectedResourceId]);
  const filteredResources = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return resources.filter((resource) => {
      const haystack = `${resource.name} ${resource.displayName || ""} ${resource.configText}`.toLowerCase();
      if (normalized && !haystack.includes(normalized)) return false;
      if (filter === "shared") return resource.isShared;
      if (filter === "orphans") return !insights.graph.edges.some((edge) => edge.source === resource.id || edge.target === resource.id);
      if (filter === "stale") return Date.now() - new Date(resource.updatedAt).getTime() > 1000 * 60 * 60 * 24 * 45;
      return true;
    });
  }, [filter, insights.graph.edges, query, resources]);

  const counts = useMemo(() => ({
    shared: resources.filter((resource) => resource.isShared).length,
    proposals: proposals.filter((proposal) => proposal.status === "pending").length,
    links: insights.graph.edges.length,
    tags: insights.tags.length,
  }), [insights.graph.edges.length, insights.tags.length, proposals, resources]);

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
      toast.error("Failed to load Company Brain links");
    }
  }

  async function loadProposals() {
    const response = await fetch("/api/resources/proposals?status=pending", { cache: "no-store" });
    if (response.ok) {
      const body = await response.json();
      setProposals(body.proposals || []);
    }
  }

  async function createBrainNote() {
    const title = "New Company Brain Note";
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
        configText: "# New Company Brain Note\n\nAdd reusable doctrine, SOPs, or rules here. Link related notes with [[Wikilinks]] and add #tags.",
        isShared: false,
      }),
    });
    const body = await response.json();
    if (!response.ok) return toast.error(body.error || "Failed to create note");
    setResources((current) => [body.resource, ...current]);
    setSelectedResourceId(body.resource.id);
    setActiveTab("edit");
    toast.success("Company Brain note created");
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
          changeSummary: "Operator updated Company Brain note",
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Failed to save note");
      setResources((current) => current.map((resource) => resource.id === selectedResource.id ? { ...resource, ...body.resource } : resource));
      await loadBrainInsights(selectedResource.id);
      toast.success("Company Brain note saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save note");
    } finally {
      setIsSaving(false);
    }
  }

  async function archiveSelectedResource() {
    if (!selectedResource || !confirm("Archive this Company Brain note?")) return;
    const response = await fetch(`/api/resources/${selectedResource.id}`, { method: "DELETE" });
    if (!response.ok) return toast.error("Failed to archive note");
    setResources((current) => current.filter((resource) => resource.id !== selectedResource.id));
    setSelectedResourceId(resources.find((resource) => resource.id !== selectedResource.id)?.id || null);
    toast.success("Company Brain note archived");
  }

  async function submitBrainProposal() {
    if (!proposalText.trim()) return;
    const title = selectedResource ? `Update ${selectedResource.displayName || selectedResource.name}` : "New Company Brain proposal";
    const response = await fetch("/api/resources/proposals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        action: selectedResource ? "update" : "create",
        targetResourceId: selectedResource?.id || null,
        scopeType: selectedResource?.scopeType || "company",
        scopeId: selectedResource?.scopeId || null,
        proposedText: proposalText,
        reason: "Manual operator feed",
      }),
    });
    if (!response.ok) return toast.error("Failed to create proposal");
    setProposalText("");
    await loadProposals();
    setActiveTab("feed");
    toast.success("Brain proposal created");
  }

  async function reviewProposal(proposal: BrainProposal, status: "approved" | "rejected" | "merged") {
    const response = await fetch(`/api/resources/proposals/${proposal.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return toast.error(body.error || "Failed to review proposal");
    await loadProposals();
    const refreshed = await fetch("/api/resources", { cache: "no-store" });
    if (refreshed.ok) setResources((await refreshed.json()).resources || []);
    toast.success(status === "rejected" ? "Proposal rejected" : "Proposal applied");
  }

  return (
    <div className="company-brain relative min-h-[calc(100vh-120px)] overflow-hidden rounded-[2rem] border border-cyan-400/10 bg-[#02040b] text-zinc-100 shadow-[0_30px_120px_rgba(0,0,0,0.45)]">
      <style>{`@media (prefers-reduced-motion: reduce) { .company-brain * { animation: none !important; transition-duration: 0.01ms !important; } }`}</style>
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_0%,rgba(34,211,238,0.16),transparent_30%),radial-gradient(circle_at_85%_15%,rgba(168,85,247,0.13),transparent_30%),linear-gradient(180deg,rgba(2,4,11,0.2),#02040b)]" />
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,rgba(255,255,255,0.05)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.035)_1px,transparent_1px)] bg-[size:48px_48px] opacity-40" />

      <div className="relative z-10 flex h-[calc(100vh-120px)] flex-col">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 px-5 py-4">
          <div>
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-cyan-300/20 bg-cyan-300/10 shadow-[0_0_40px_rgba(34,211,238,0.18)]">
                <BrainCircuit className="h-5 w-5 text-cyan-200" />
              </div>
              <div>
                <h1 className="text-2xl font-semibold tracking-tight text-white">Company Brain</h1>
                <p className="text-sm text-zinc-500">Operator-governed knowledge graph for durable agent context.</p>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={createBrainNote} className="inline-flex items-center gap-2 rounded-xl bg-cyan-200 px-4 py-2 text-sm font-bold text-slate-950 transition-colors hover:bg-white">
              <Plus className="h-4 w-4" /> New Note
            </button>
            <button onClick={saveSelectedResource} disabled={!selectedResource || isSaving} className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.06] px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-white/[0.1] disabled:opacity-50">
              <Check className="h-4 w-4" /> Save
            </button>
          </div>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)_360px]">
          <aside className="min-h-0 border-r border-white/10 bg-white/[0.025] p-4">
            <div className="relative mb-3">
              <Search className="absolute left-3 top-3 h-4 w-4 text-zinc-500" />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search brain..." className="w-full rounded-2xl border border-white/10 bg-slate-950/70 py-2.5 pl-9 pr-3 text-sm outline-none transition-colors focus:border-cyan-300/40" />
            </div>
            <div className="mb-4 grid grid-cols-2 gap-2">
              {(["all", "shared", "orphans", "stale"] as const).map((item) => (
                <button key={item} onClick={() => setFilter(item)} className={cn("rounded-xl border px-3 py-2 text-xs font-bold capitalize transition-colors", filter === item ? "border-cyan-300/40 bg-cyan-300/10 text-cyan-100" : "border-white/10 bg-white/[0.03] text-zinc-500 hover:text-zinc-200")}>{item}</button>
              ))}
            </div>
            <div className="mb-4 grid grid-cols-2 gap-2 text-xs">
              <Metric icon={Share2} label="Shared" value={counts.shared} />
              <Metric icon={Send} label="Feed" value={counts.proposals} />
              <Metric icon={Link2} label="Links" value={counts.links} />
              <Metric icon={Tags} label="Tags" value={counts.tags} />
            </div>
            <div className="max-h-[calc(100vh-365px)] space-y-2 overflow-y-auto pr-1">
              {filteredResources.map((resource) => (
                <button key={resource.id} onClick={() => setSelectedResourceId(resource.id)} className={cn("w-full rounded-2xl border p-3 text-left transition-colors", selectedResourceId === resource.id ? "border-cyan-300/40 bg-cyan-300/10" : "border-white/10 bg-white/[0.035] hover:border-white/20 hover:bg-white/[0.055]")}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-white">{resource.displayName || resource.name}</div>
                      <div className="mt-1 flex items-center gap-2 text-[11px] uppercase tracking-[0.16em] text-zinc-500">
                        <span>{scopeLabel(resource.scopeType)}</span>
                        {resource.isShared && <span className="text-cyan-200">Shared</span>}
                      </div>
                    </div>
                    <FileText className="h-4 w-4 shrink-0 text-zinc-500" />
                  </div>
                </button>
              ))}
            </div>
          </aside>

          <main className="min-h-0 p-4">
            {selectedResource ? (
              <div className="flex h-full flex-col overflow-hidden rounded-[1.5rem] border border-white/10 bg-slate-950/50">
                <div className="border-b border-white/10 p-4">
                  <input value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} className="w-full bg-transparent text-2xl font-semibold tracking-tight text-white outline-none" />
                  <div className="mt-3 flex flex-wrap gap-2">
                    {TABS.map((tab) => (
                      <button key={tab} onClick={() => setActiveTab(tab)} className={cn("rounded-xl px-3 py-1.5 text-xs font-bold uppercase tracking-[0.16em] transition-colors", activeTab === tab ? "bg-cyan-300/15 text-cyan-100" : "text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200")}>{tab}</button>
                    ))}
                  </div>
                </div>
                <div className="min-h-0 flex-1 overflow-auto p-4">
                  <AnimatePresence mode="wait">
                    {activeTab === "edit" && (
                      <motion.textarea key="edit" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} value={draftContent} onChange={(event) => setDraftContent(event.target.value)} className="h-full min-h-[520px] w-full resize-none rounded-2xl border border-white/10 bg-black/35 p-5 font-mono text-sm leading-7 text-zinc-100 outline-none focus:border-cyan-300/40" />
                    )}
                    {activeTab === "preview" && (
                      <motion.div key="preview" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="prose prose-invert max-w-none rounded-2xl border border-white/10 bg-black/25 p-6">
                        <MarkdownRenderer content={draftContent || "*No content yet.*"} />
                      </motion.div>
                    )}
                    {activeTab === "graph" && <GraphPanel key="graph" graph={insights.graph} selectedId={selectedResource.id} />}
                    {activeTab === "feed" && <BrainFeed key="feed" proposals={proposals} onReview={reviewProposal} />}
                  </AnimatePresence>
                </div>
              </div>
            ) : (
              <div className="flex h-full items-center justify-center rounded-[1.5rem] border border-white/10 bg-white/[0.03] text-zinc-500">Select or create a Company Brain note.</div>
            )}
          </main>

          <aside className="min-h-0 overflow-y-auto border-l border-white/10 bg-white/[0.025] p-4">
            {selectedResource && (
              <div className="space-y-4">
                <InspectorCard title="Context Inspector" icon={ShieldCheck}>
                  <label className="text-xs text-zinc-500">Scope</label>
                  <select value={draftScopeType} onChange={(event) => setDraftScopeType(event.target.value)} className="mt-1 w-full rounded-xl border border-white/10 bg-slate-950 p-2 text-sm">
                    <option value="company">Company</option>
                    <option value="customer">Customer</option>
                    <option value="project">Project</option>
                    <option value="agent">Agent</option>
                  </select>
                  {draftScopeType !== "company" && (
                    <select value={draftScopeId} onChange={(event) => setDraftScopeId(event.target.value)} className="mt-2 w-full rounded-xl border border-white/10 bg-slate-950 p-2 text-sm">
                      {(scopeOptions[draftScopeType as keyof typeof scopeOptions] || []).map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
                    </select>
                  )}
                  <button onClick={() => setDraftShared(!draftShared)} className={cn("mt-3 flex w-full items-center justify-between rounded-xl border p-3 text-sm font-bold", draftShared ? "border-cyan-300/40 bg-cyan-300/10 text-cyan-100" : "border-white/10 bg-white/[0.03] text-zinc-400")}>
                    Auto-inject to agents <span>{draftShared ? "On" : "Off"}</span>
                  </button>
                </InspectorCard>

                <InspectorCard title="Tags" icon={Tags}>
                  <div className="flex flex-wrap gap-2">
                    {insights.tags.length ? insights.tags.map((tag) => <span key={tag.id} className="rounded-full border border-cyan-300/20 bg-cyan-300/10 px-2 py-1 text-xs text-cyan-100">#{tag.tag}</span>) : <EmptyHint text="Add #tags in markdown." />}
                  </div>
                </InspectorCard>

                <InspectorCard title="Backlinks" icon={Link2}>
                  <LinkList links={insights.backlinks} empty="No backlinks yet." />
                </InspectorCard>

                <InspectorCard title="Outgoing Links" icon={GitBranch}>
                  <LinkList links={insights.outgoing} empty="Use [[Wikilinks]] to connect notes." />
                </InspectorCard>

                <InspectorCard title="Versions" icon={Clock3}>
                  <div className="space-y-2">
                    {insights.versions.slice(0, 6).map((version) => (
                      <div key={version.id} className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
                        <div className="text-xs font-bold text-zinc-200">{version.changeSummary || "Version"}</div>
                        <div className="mt-1 text-[11px] text-zinc-500">{dateLabel(version.createdAt)} · {version.createdByType}</div>
                      </div>
                    ))}
                    {!insights.versions.length && <EmptyHint text="Versions appear after edits." />}
                  </div>
                </InspectorCard>

                <InspectorCard title="Manual Operator Feed" icon={Sparkles}>
                  <textarea value={proposalText} onChange={(event) => setProposalText(event.target.value)} placeholder="Propose reusable knowledge, rules, or doctrine. Operators approve before it mutates the Brain." className="min-h-28 w-full resize-none rounded-xl border border-white/10 bg-slate-950 p-3 text-sm outline-none focus:border-cyan-300/40" />
                  <button onClick={submitBrainProposal} className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-violet-300 px-3 py-2 text-sm font-bold text-slate-950 hover:bg-white">
                    <Send className="h-4 w-4" /> Send to Brain Feed
                  </button>
                </InspectorCard>

                <button onClick={archiveSelectedResource} className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-rose-400/20 bg-rose-400/10 px-3 py-2 text-sm font-bold text-rose-200 hover:bg-rose-400/15">
                  <Archive className="h-4 w-4" /> Archive Note
                </button>
              </div>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}

function Metric({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: number }) {
  return <div className="rounded-xl border border-white/10 bg-white/[0.035] p-3"><Icon className="mb-2 h-4 w-4 text-cyan-200" /><div className="text-lg font-semibold text-white">{value}</div><div className="text-[10px] uppercase tracking-[0.16em] text-zinc-500">{label}</div></div>;
}

function InspectorCard({ title, icon: Icon, children }: { title: string; icon: LucideIcon; children: ReactNode }) {
  return <section className="rounded-2xl border border-white/10 bg-white/[0.035] p-4"><div className="mb-3 flex items-center gap-2 text-sm font-bold text-white"><Icon className="h-4 w-4 text-cyan-200" />{title}</div>{children}</section>;
}

function EmptyHint({ text }: { text: string }) {
  return <div className="rounded-xl border border-dashed border-white/10 p-3 text-xs text-zinc-500">{text}</div>;
}

function LinkList({ links, empty }: { links: BrainLink[]; empty: string }) {
  if (!links.length) return <EmptyHint text={empty} />;
  return <div className="space-y-2">{links.map((link) => <div key={link.id} className="rounded-xl border border-white/10 bg-white/[0.03] p-3 text-sm"><div className="text-zinc-200">[[{link.linkText}]]</div>{!link.targetResourceId && <div className="mt-1 text-xs text-amber-200">Unresolved — create linked note</div>}</div>)}</div>;
}

function GraphPanel({ graph, selectedId }: { graph: { nodes: GraphNode[]; edges: GraphEdge[] }; selectedId: string }) {
  return <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="relative min-h-[560px] overflow-hidden rounded-2xl border border-white/10 bg-[radial-gradient(circle_at_center,rgba(34,211,238,0.12),transparent_42%),rgba(0,0,0,0.22)] p-6">
    <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(255,255,255,0.05)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.035)_1px,transparent_1px)] bg-[size:42px_42px]" />
    <div className="relative z-10 mb-4 flex items-center gap-2 text-sm font-bold text-cyan-100"><Network className="h-4 w-4" /> Graph</div>
    <div className="relative z-10 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {graph.nodes.map((node) => <div key={node.id} className={cn("rounded-2xl border p-4 shadow-[0_0_40px_rgba(34,211,238,0.08)]", node.id === selectedId ? "border-cyan-300/50 bg-cyan-300/10" : "border-white/10 bg-slate-950/70")}><div className="font-semibold text-white">{node.label}</div><div className="mt-2 text-xs uppercase tracking-[0.16em] text-zinc-500">{node.scopeType} · {node.resourceType}</div><div className="mt-3 flex flex-wrap gap-1">{node.tags.slice(0, 3).map((tag) => <span key={tag} className="rounded-full bg-white/10 px-2 py-1 text-[10px] text-cyan-100">#{tag}</span>)}</div></div>)}
    </div>
    <div className="relative z-10 mt-6 rounded-2xl border border-white/10 bg-black/30 p-4 text-xs text-zinc-400">{graph.edges.length} edges · unresolved links stay visible so operators can create missing notes.</div>
  </motion.div>;
}

function BrainFeed({ proposals, onReview }: { proposals: BrainProposal[]; onReview: (proposal: BrainProposal, status: "approved" | "rejected" | "merged") => void }) {
  return <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-3">
    <div className="rounded-2xl border border-violet-300/20 bg-violet-300/10 p-4"><div className="flex items-center gap-2 font-bold text-violet-100"><Sparkles className="h-4 w-4" /> Brain Feed</div><p className="mt-1 text-sm text-zinc-400">Agents and operators propose knowledge here. Humans approve reusable truth before it mutates Company Brain.</p></div>
    {proposals.length ? proposals.map((proposal) => <div key={proposal.id} className="rounded-2xl border border-white/10 bg-white/[0.035] p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="font-semibold text-white">{proposal.title}</div><div className="mt-1 text-xs uppercase tracking-[0.16em] text-zinc-500">{proposal.action} · {proposal.scopeType} · {dateLabel(proposal.createdAt)}</div></div><div className="flex gap-2"><button onClick={() => onReview(proposal, "approved")} className="rounded-xl bg-emerald-300 px-3 py-1.5 text-xs font-bold text-slate-950"><Check className="inline h-3 w-3" /> Approve</button><button onClick={() => onReview(proposal, "rejected")} className="rounded-xl border border-white/10 px-3 py-1.5 text-xs font-bold text-zinc-300"><X className="inline h-3 w-3" /> Reject</button></div></div><pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap rounded-xl bg-black/30 p-3 text-xs leading-6 text-zinc-300">{proposal.proposedText}</pre></div>) : <EmptyHint text="No pending proposals." />}
  </motion.div>;
}
