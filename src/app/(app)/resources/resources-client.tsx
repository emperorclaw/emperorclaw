
"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  FileText,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { ExpandablePanel } from "@/components/expandable-panel";
import { PageHeader } from "@/components/page-header";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), { ssr: false });
const MarkdownLiveEditor = dynamic(() => import("@/components/markdown-live-editor").then((mod) => mod.MarkdownLiveEditor), { ssr: false });

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
type UnresolvedGraphNode = GraphNode & { unresolved: true };

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

function setNoteStatus(content: string, status: "draft" | "active") {
  if (/^---[\s\S]*?\nstatus:\s*[A-Za-z0-9_-]+[\s\S]*?\n---/m.test(content)) {
    return content.replace(/^---([\s\S]*?)\nstatus:\s*[A-Za-z0-9_-]+([\s\S]*?\n---)/m, `---$1\nstatus: ${status}$2`);
  }
  if (/^---[\s\S]*?\n---/m.test(content)) {
    return content.replace(/^---\n/, `---\nstatus: ${status}\n`);
  }
  return `---\nstatus: ${status}\n---\n\n${content}`;
}

const FRONTMATTER_PATTERN = /^---\n[\s\S]*?\n---\n?/;

/** Splits leading YAML frontmatter from the note body. Frontmatter fields
 * (scope, status, tags, owner) are already managed by the Properties panel
 * controls, so only the body needs to go into the live markdown editor. */
function splitFrontmatter(content: string): { frontmatter: string; body: string } {
  const match = content.match(FRONTMATTER_PATTERN);
  if (!match) return { frontmatter: "", body: content };
  return { frontmatter: match[0], body: content.slice(match[0].length) };
}

function joinFrontmatter(frontmatter: string, body: string) {
  return frontmatter ? `${frontmatter}\n${body}` : body;
}

/** MDXEditor's markdown serializer defensively backslash-escapes literal
 * "[[" sequences (they're not valid CommonMark link syntax on their own),
 * which would silently break the [[Note Name]] wiki-link convention the
 * backlinks graph parses with a plain /\[\[.../ regex. Undo that escaping
 * only at save time, not on every keystroke, so it never fights the
 * editor's own internal state while typing. */
function unescapeWikilinkBrackets(content: string) {
  return content.replace(/\\(\[|\])/g, "$1");
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
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "shared" | "drafts">("all");
  const [draftTitle, setDraftTitle] = useState(initialResources[0]?.displayName || initialResources[0]?.name || "");
  const [draftContent, setDraftContent] = useState(initialResources[0]?.configText || "");
  const [draftScopeType, setDraftScopeType] = useState(initialResources[0]?.scopeType || "company");
  const [draftScopeId, setDraftScopeId] = useState(initialResources[0]?.scopeId || "");
  const [draftShared, setDraftShared] = useState(Boolean(initialResources[0]?.isShared));
  const [publicationStatus, setPublicationStatus] = useState<"draft" | "active">(noteStatus(initialResources[0]?.configText || "") === "draft" ? "draft" : "active");
  const [insights, setInsights] = useState<BrainInsights>(EMPTY_INSIGHTS);
  const [isSaving, setIsSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [deleteDialogTarget, setDeleteDialogTarget] = useState<ResourceRecord | null>(null);
  const [isDeletingDialog, setIsDeletingDialog] = useState(false);

  const scopeOptions = useMemo(() => ({ customer: customers, project: projects, agent: agents }), [agents, customers, projects]);
  const selectedResource = useMemo(() => resources.find((resource) => resource.id === selectedResourceId) || null, [resources, selectedResourceId]);
  const isDeleteArmed = Boolean(selectedResource) && confirmingDelete === selectedResource?.id;

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
    setPublicationStatus(noteStatus(selectedResource.configText || "") === "draft" ? "draft" : "active");
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
    toast.success("Knowledge rule created");
  }

  async function createLinkedResource() {
    const parentTitle = selectedResource ? (selectedResource.displayName || selectedResource.name) : "Company Operating Doctrine";
    const title = "New Linked Note";
    const response = await fetch("/api/resources", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scopeType: selectedResource?.scopeType || "company",
        scopeId: selectedResource?.scopeType === "company" ? null : selectedResource?.scopeId || null,
        provider: "knowledge",
        resourceType: "knowledge_base",
        name: slugifyResourceKey(title),
        displayName: title,
        configText: `---\nscope: ${selectedResource?.scopeType || "company"}\ntype: knowledge-note\nstatus: draft\nowner: operator\ntags:\n  - knowledge\n---\n\n# ${title}\n\nShort reusable note.\n\n## Related\n\n- [[${parentTitle}]]`,
        isShared: false,
      }),
    });
    const body = await response.json();
    if (!response.ok) return toast.error(body.error || "Failed to create linked note");
    setResources((current) => [body.resource, ...current]);
    setSelectedResourceId(body.resource.id);
    toast.success("Linked note created");
  }

  function selectAdjacentResource(direction: "previous" | "next") {
    if (!selectedResourceId || filteredResources.length === 0) return;
    const index = filteredResources.findIndex((resource) => resource.id === selectedResourceId);
    if (index < 0) {
      setSelectedResourceId(filteredResources[0].id);
      return;
    }
    const offset = direction === "previous" ? -1 : 1;
    const nextIndex = (index + offset + filteredResources.length) % filteredResources.length;
    setSelectedResourceId(filteredResources[nextIndex].id);
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
          configText: setNoteStatus(unescapeWikilinkBrackets(draftContent), publicationStatus),
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

  async function updatePublicationStatus(nextStatus: "draft" | "active") {
    if (!selectedResource || isSaving) return;
    const previousStatus = publicationStatus;
    setPublicationStatus(nextStatus);
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
          configText: setNoteStatus(unescapeWikilinkBrackets(draftContent), nextStatus),
          isShared: draftShared,
          changeSummary: nextStatus === "active" ? "Operator published Knowledge & Rules entry" : "Operator moved Knowledge & Rules entry to draft",
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Failed to update publication status");
      setResources((current) => current.map((resource) => resource.id === selectedResource.id ? { ...resource, ...body.resource } : resource));
      await loadBrainInsights(selectedResource.id);
      toast.success(nextStatus === "active" ? "Knowledge note published" : "Knowledge note moved to draft");
    } catch (error) {
      setPublicationStatus(previousStatus);
      toast.error(error instanceof Error ? error.message : "Failed to update publication status");
    } finally {
      setIsSaving(false);
    }
  }

  async function archiveSelectedResource() {
    if (!selectedResource) return;
    if (confirmingDelete !== selectedResource.id) {
      setConfirmingDelete(selectedResource.id);
      setTimeout(() => setConfirmingDelete(null), 4000);
      return;
    }
    setConfirmingDelete(null);
    const response = await fetch(`/api/resources/${selectedResource.id}`, { method: "DELETE" });
    if (!response.ok) return toast.error("Failed to delete note");
    const remaining = resources.filter((resource) => resource.id !== selectedResource.id);
    setResources(remaining);
    setSelectedResourceId(remaining[0]?.id || null);
    toast.success("Knowledge note deleted");
  }

  async function confirmDeleteFromContextMenu() {
    if (!deleteDialogTarget || isDeletingDialog) return;
    setIsDeletingDialog(true);
    try {
      const response = await fetch(`/api/resources/${deleteDialogTarget.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Failed to delete note");
      const remaining = resources.filter((resource) => resource.id !== deleteDialogTarget.id);
      setResources(remaining);
      if (selectedResourceId === deleteDialogTarget.id) setSelectedResourceId(remaining[0]?.id || null);
      toast.success("Knowledge note deleted");
      setDeleteDialogTarget(null);
    } catch {
      toast.error("Failed to delete note");
    } finally {
      setIsDeletingDialog(false);
    }
  }

  return (
    <div className="mx-auto flex h-[calc(100vh-6rem)] sm:h-[calc(100vh-8rem)] max-w-[1800px] flex-col gap-4 animate-in fade-in duration-500">
      <PageHeader
        eyebrow="Knowledge base"
        title="Knowledge & Rules"
        description="Durable notes, SOPs, and instructions your agents read before they act."
      />
      <div className="min-h-0 flex-1 overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl shadow-black/20">
      <div className="flex h-full min-h-[360px] sm:min-h-[500px] flex-col">
        <div className="grid grid-cols-1 border-b border-zinc-800 bg-zinc-950/95 lg:grid-cols-[300px_minmax(0,1fr)_360px]">
          <div className="flex h-11 items-center justify-between border-b border-zinc-800 px-3 lg:border-b-0 lg:border-r">
            <div className="flex items-center gap-1.5 text-zinc-500">
              <button className="cursor-pointer rounded p-1 transition-colors hover:bg-zinc-900 hover:text-zinc-200" title="New note" aria-label="New note" onClick={createResource}><FileText className="h-4 w-4" /></button>
              <button className="cursor-pointer rounded p-1 transition-colors hover:bg-zinc-900 hover:text-zinc-200" title="New note linked to this one" aria-label="New linked note" onClick={createLinkedResource}><Plus className="h-4 w-4" /></button>
              <button className="cursor-pointer rounded p-1 transition-colors hover:bg-zinc-900 hover:text-zinc-200" title="Refresh vault" aria-label="Refresh vault" onClick={refreshResources}><RefreshCw className="h-4 w-4" /></button>
            </div>
            <button onClick={archiveSelectedResource} disabled={!selectedResource} className={cn("inline-flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40", isDeleteArmed ? "border-red-500/40 bg-red-500/10 text-red-300" : "border-transparent text-zinc-500 hover:bg-red-500/10 hover:text-red-300")}>
              <Trash2 className="h-3.5 w-3.5" /> {isDeleteArmed ? "Click again to confirm" : "Delete note"}
            </button>
          </div>
          <div className="flex h-11 items-center justify-between border-b border-zinc-800 px-4 lg:border-b-0 lg:border-r">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex items-center gap-1 text-zinc-600">
                <button onClick={() => selectAdjacentResource("previous")} className="cursor-pointer rounded p-1 transition-colors hover:bg-zinc-900 hover:text-zinc-300" title="Previous note" aria-label="Previous note"><ArrowLeft className="h-4 w-4" /></button>
                <button onClick={() => selectAdjacentResource("next")} className="cursor-pointer rounded p-1 transition-colors hover:bg-zinc-900 hover:text-zinc-300" title="Next note" aria-label="Next note"><ArrowRight className="h-4 w-4" /></button>
              </div>
              <div className="min-w-0 truncate text-xs text-zinc-500">
                <span>Knowledge & Rules</span>
                {selectedResource && <span className="text-zinc-700"> / </span>}
                {selectedResource && <span className="text-zinc-300">{draftTitle || "Untitled note"}</span>}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5 text-zinc-500">
              <button onClick={() => void updatePublicationStatus(publicationStatus === "draft" ? "active" : "draft")} disabled={!selectedResource || isSaving} className={cn("inline-flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50", publicationStatus === "draft" ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200 hover:bg-emerald-400/15" : "border-amber-400/25 bg-amber-400/10 text-amber-200 hover:bg-amber-400/15")}>
                <Check className="h-3.5 w-3.5" /> {publicationStatus === "draft" ? "Publish" : "Move to draft"}
              </button>
              <button onClick={saveSelectedResource} disabled={!selectedResource || isSaving} className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-zinc-800 px-2 py-1 text-[11px] font-medium text-zinc-300 transition-colors hover:bg-zinc-900 disabled:cursor-not-allowed disabled:opacity-50">
                <Check className="h-3.5 w-3.5" /> {isSaving ? "Saving" : "Save"}
              </button>
              <button onClick={archiveSelectedResource} disabled={!selectedResource} className={cn("cursor-pointer rounded p-1 transition-colors disabled:cursor-not-allowed disabled:opacity-40", isDeleteArmed ? "bg-red-500/10 text-red-300" : "text-zinc-500 hover:bg-red-500/10 hover:text-red-300")} title={isDeleteArmed ? "Click again to confirm delete" : "Delete note"} aria-label={isDeleteArmed ? "Click again to confirm delete" : "Delete note"}><Trash2 className="h-4 w-4" /></button>
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
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search notes..." className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900 py-2 pl-9 pr-3 text-sm text-zinc-100 outline-none focus:border-cyan-400/60" />
              </div>
              <div className="mt-3 flex items-center gap-2">
                {(["all", "shared", "drafts"] as const).map((item) => (
                  <button key={item} onClick={() => setFilter(item)} className={cn("cursor-pointer rounded-md px-2.5 py-1 text-[11px] font-medium capitalize transition-colors", filter === item ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300")}>{item}</button>
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
                        <ContextMenu key={resource.id}>
                          <ContextMenuTrigger asChild>
                            <button onClick={() => setSelectedResourceId(resource.id)} className={cn("group flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors", selectedResourceId === resource.id ? "bg-cyan-400/10 text-cyan-100" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100")}>
                              <FileText className={cn("h-3.5 w-3.5 shrink-0", selectedResourceId === resource.id ? "text-cyan-300" : "text-zinc-600 group-hover:text-zinc-400")} />
                              <span className="min-w-0 flex-1 truncate">{resource.displayName || resource.name}</span>
                              {noteStatus(resource.configText || "") === "draft" && <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-amber-300">draft</span>}
                              {resource.isShared && <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" title="Shared with agents" />}
                            </button>
                          </ContextMenuTrigger>
                          <ContextMenuContent className="w-48 border-zinc-800 bg-zinc-950 text-zinc-100">
                            <ContextMenuItem onClick={() => setSelectedResourceId(resource.id)}>
                              <FileText className="h-3.5 w-3.5" /> Open
                            </ContextMenuItem>
                            <ContextMenuItem variant="destructive" onClick={() => setDeleteDialogTarget(resource)}>
                              <Trash2 className="h-3.5 w-3.5" /> Delete note
                            </ContextMenuItem>
                          </ContextMenuContent>
                        </ContextMenu>
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
                    {publicationStatus === "draft" && <span className="rounded border border-amber-500/20 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-amber-300">draft</span>}
                    {draftShared && <span className="rounded border border-cyan-400/20 bg-cyan-400/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-cyan-300">shared</span>}
                  </div>
                </div>
                <div className="min-h-0 flex-1 overflow-auto">
                  <MarkdownLiveEditor
                    key={selectedResource.id}
                    markdown={splitFrontmatter(selectedResource.configText || "").body}
                    onChange={(nextBody) => setDraftContent(joinFrontmatter(splitFrontmatter(draftContent).frontmatter, nextBody))}
                    placeholder="Write one reusable rule, SOP, or instruction here..."
                    className="mx-auto min-h-[620px] max-w-4xl px-4 py-4"
                  />
                </div>
              </>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-zinc-500">Select or create a note.</div>
            )}
          </main>

          <aside className="flex min-h-0 flex-col overflow-y-auto border-t border-zinc-800 bg-zinc-950 lg:border-l lg:border-t-0">
            {selectedResource && (
              <>
                <div className="shrink-0 border-b border-zinc-800">
                  <ExpandablePanel
                    className="h-[360px] overflow-hidden"
                    expandedClassName="overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-950 shadow-2xl shadow-black/60"
                    label="Expand graph"
                  >
                    {(expanded) => <div className="h-full"><LocalGraph key={expanded ? "expanded" : "collapsed"} graph={insights.graph} selectedId={selectedResource.id} /></div>}
                  </ExpandablePanel>
                </div>

                <div className="shrink-0 p-3">
                  <div className="grid grid-cols-3 gap-2 text-center text-[11px] text-zinc-500">
                    <div className="rounded-md border border-zinc-800 bg-zinc-950/60 px-2 py-1"><span className="text-zinc-200">{insights.backlinks.length}</span> incoming</div>
                    <div className="rounded-md border border-zinc-800 bg-zinc-950/60 px-2 py-1"><span className="text-zinc-200">{insights.outgoing.length}</span> outgoing</div>
                    <div className="rounded-md border border-zinc-800 bg-zinc-950/60 px-2 py-1"><span className="text-zinc-200">{splitFrontmatter(draftContent).body.split(/\s+/).filter(Boolean).length}</span> words</div>
                  </div>
                  <details className="mt-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                    <summary className="cursor-pointer text-xs font-semibold text-zinc-300">Properties</summary>
                    <div className="mt-3">
                      <label className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">Publication status</label>
                      <select value={publicationStatus} onChange={(event) => setPublicationStatus(event.target.value === "draft" ? "draft" : "active")} className="mt-1 h-9 w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 text-sm text-zinc-100 outline-none focus:border-cyan-400/60">
                        <option value="draft">Draft / Needs review</option>
                        <option value="active">Published</option>
                      </select>
                      <button onClick={() => void updatePublicationStatus(publicationStatus === "draft" ? "active" : "draft")} disabled={isSaving} className={cn("mt-2 inline-flex w-full cursor-pointer items-center justify-center gap-2 rounded-md border px-3 py-2 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50", publicationStatus === "draft" ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200 hover:bg-emerald-400/15" : "border-amber-400/25 bg-amber-400/10 text-amber-200 hover:bg-amber-400/15")}>
                        <Check className="h-3.5 w-3.5" />
                        {publicationStatus === "draft" ? "Publish note" : "Move back to draft"}
                      </button>
                      <p className="mt-1 text-[11px] leading-4 text-zinc-500">Published means this note is trusted doctrine. Shared is separate: it controls agent context injection.</p>

                      <label className="mt-3 block text-[11px] font-medium uppercase tracking-wider text-zinc-600">Scope</label>
                      <select value={draftScopeType} onChange={(event) => setDraftScopeType(event.target.value)} className="mt-1 h-9 w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 text-sm text-zinc-100 outline-none focus:border-cyan-400/60">
                        <option value="company">Company</option>
                        <option value="customer">Customer</option>
                        <option value="project">Project</option>
                        <option value="agent">Agent</option>
                      </select>
                      {draftScopeType !== "company" && (
                        <select value={draftScopeId} onChange={(event) => setDraftScopeId(event.target.value)} className="mt-2 h-9 w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 text-sm text-zinc-100 outline-none focus:border-cyan-400/60">
                          <option value="">Choose {scopeLabel(draftScopeType).toLowerCase()}</option>
                          {(scopeOptions[draftScopeType as "customer" | "project" | "agent"] || []).map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
                        </select>
                      )}
                      <button onClick={() => setDraftShared(!draftShared)} className={cn("mt-3 flex w-full cursor-pointer items-center justify-between rounded-md border p-2 text-xs transition-colors", draftShared ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200" : "border-zinc-800 bg-zinc-950 text-zinc-400 hover:bg-zinc-900")}>
                        <span>Inject into matching agents</span>
                        <span className="font-semibold">{draftShared ? "On" : "Off"}</span>
                      </button>
                      <p className="mt-1 text-[11px] leading-4 text-zinc-600">shared means context injection for matching agents. Keep it off unless agents should receive it during work.</p>
                      {insights.tags.length > 0 && <div className="mt-3"><TagList tags={insights.tags} /></div>}
                      <button onClick={archiveSelectedResource} className={cn("mt-3 inline-flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-xs font-medium transition-colors", isDeleteArmed ? "bg-red-500/10 text-red-300" : "text-zinc-600 hover:text-red-300")}><Archive className="h-3.5 w-3.5" /> {isDeleteArmed ? "Click again to confirm" : "Delete note"}</button>
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

      <Dialog open={Boolean(deleteDialogTarget)} onOpenChange={(open) => { if (!open && !isDeletingDialog) setDeleteDialogTarget(null); }}>
        <DialogContent className="border-zinc-800 bg-zinc-950 text-zinc-100 sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete &ldquo;{deleteDialogTarget?.displayName || deleteDialogTarget?.name}&rdquo;?</DialogTitle>
            <DialogDescription className="text-zinc-400">This can&apos;t be undone. Any links pointing to this note will become unresolved.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button type="button" onClick={() => setDeleteDialogTarget(null)} disabled={isDeletingDialog} className="cursor-pointer rounded-lg border border-zinc-800 bg-zinc-950 px-4 py-2 text-sm text-zinc-200 transition-colors hover:bg-zinc-900 disabled:cursor-not-allowed disabled:opacity-50">
              Cancel
            </button>
            <button type="button" onClick={() => void confirmDeleteFromContextMenu()} disabled={isDeletingDialog} className="cursor-pointer rounded-lg bg-rose-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-rose-400 disabled:cursor-not-allowed disabled:opacity-50">
              {isDeletingDialog ? "Deleting..." : "Delete"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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


type ForceNode = { id: string; label: string; unresolved: boolean; isShared: boolean; selected: boolean; val: number; x?: number; y?: number; [key: string]: unknown };
type ForceLink = { source: string; target: string; label: string; unresolved: boolean; [key: string]: unknown };

function useContainerSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    // Debounced: some canvas libraries only correctly normalize their
    // devicePixelRatio scaling on the FIRST non-default size they receive.
    // A ResizeObserver can otherwise fire more than once with different
    // transitional sizes while layout settles, feeding the canvas two
    // distinct sizes and leaving its transform matrix mis-scaled.
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      clearTimeout(timeout);
      timeout = setTimeout(() => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }), 80);
    });
    observer.observe(element);
    return () => {
      clearTimeout(timeout);
      observer.disconnect();
    };
  }, []);
  return { ref, size };
}

function LocalGraph({ graph, selectedId }: { graph: { nodes: GraphNode[]; edges: GraphEdge[] }; selectedId: string }) {
  const { ref: containerRef, size } = useContainerSize<HTMLDivElement>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const graphRef = useRef<any>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);

  // Memoized against graph/selectedId only: node/link *objects* must stay
  // referentially stable across renders (d3-force mutates them in place with
  // x/y/vx/vy), or the simulation restarts from scratch on every unrelated
  // re-render (e.g. hover) and never settles into a spread-out layout.
  const { graphData, neighborMap } = useMemo(() => {
    const unresolvedNodes: UnresolvedGraphNode[] = graph.edges
      .filter((edge) => !edge.target)
      .slice(0, 8)
      .map((edge) => ({
        id: `unresolved:${edge.id}`,
        label: edge.label,
        scopeType: "unresolved",
        resourceType: "knowledge_base",
        isShared: false,
        tags: [],
        unresolved: true,
      }));
    const resolvedNodes = graph.nodes.length ? graph.nodes : [{ id: selectedId, label: "Current note", scopeType: "company", resourceType: "knowledge_base", isShared: false, tags: [] }];
    const rawNodes = [...resolvedNodes, ...unresolvedNodes].slice(0, 18);
    const nodeIds = new Set(rawNodes.map((node) => node.id));

    const computedLinks: ForceLink[] = graph.edges
      .map((edge) => ({ source: edge.source, target: edge.target || `unresolved:${edge.id}`, label: edge.label, unresolved: edge.unresolved }))
      .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
      .slice(0, 24);
    const computedConnectedNodeIds = new Set(computedLinks.flatMap((link) => [link.source, link.target]));
    const computedNeighborMap = new Map<string, Set<string>>();
    for (const link of computedLinks) {
      if (!computedNeighborMap.has(link.source)) computedNeighborMap.set(link.source, new Set());
      if (!computedNeighborMap.has(link.target)) computedNeighborMap.set(link.target, new Set());
      computedNeighborMap.get(link.source)!.add(link.target);
      computedNeighborMap.get(link.target)!.add(link.source);
    }

    const computedNodes: ForceNode[] = rawNodes.map((node) => {
      const unresolved = "unresolved" in node;
      const selected = node.id === selectedId;
      return { id: node.id, label: node.label, unresolved, isShared: node.isShared, selected, val: selected ? 9 : computedConnectedNodeIds.has(node.id) ? 5 : 3.5 };
    });

    return { graphData: { nodes: computedNodes, links: computedLinks }, connectedNodeIds: computedConnectedNodeIds, neighborMap: computedNeighborMap };
  }, [graph, selectedId]);
  const { links } = graphData;

  useEffect(() => {
    // Re-fit repeatedly for a bit: node positions keep moving while the force
    // simulation settles, and a single early zoomToFit call locks onto a
    // still-clustered layout that never gets corrected afterwards.
    const interval = setInterval(() => graphRef.current?.zoomToFit(400, 32), 200);
    const stop = setTimeout(() => clearInterval(interval), 2000);
    return () => {
      clearInterval(interval);
      clearTimeout(stop);
    };
  }, [graphData, size.width, size.height]);

  const highlightNodes = hoveredNodeId ? new Set([hoveredNodeId, ...(neighborMap.get(hoveredNodeId) || [])]) : null;

  return (
    <div ref={containerRef} className="relative h-full min-h-[360px] overflow-hidden bg-[radial-gradient(circle_at_50%_35%,rgba(99,102,241,0.16),transparent_32%),#09090b]">
      {size.width > 0 && size.height > 0 && (
        <ForceGraph2D
          ref={graphRef}
          width={size.width}
          height={size.height}
          graphData={graphData}
          backgroundColor="rgba(0,0,0,0)"
          nodeRelSize={3}
          nodeLabel={(raw: unknown) => (raw as ForceNode).label}
          onNodeHover={(raw: unknown) => setHoveredNodeId((raw as ForceNode | null)?.id || null)}
          linkColor={(raw: unknown) => {
            const link = raw as ForceLink;
            const dimmed = highlightNodes && !(highlightNodes.has(link.source as unknown as string) && highlightNodes.has(link.target as unknown as string));
            if (link.unresolved) return dimmed ? "rgba(245,158,11,0.25)" : "rgba(245,158,11,0.75)";
            return dimmed ? "rgba(129,140,248,0.18)" : "rgba(129,140,248,0.65)";
          }}
          linkWidth={1.4}
          linkDirectionalArrowLength={5}
          linkDirectionalArrowRelPos={1}
          linkDirectionalParticles={2}
          linkDirectionalParticleWidth={2}
          linkDirectionalParticleSpeed={0.006}
          linkDirectionalParticleColor={(raw: unknown) => ((raw as ForceLink).unresolved ? "#fbbf24" : "#a5b4fc")}
          cooldownTicks={120}
          d3VelocityDecay={0.35}
          nodeCanvasObject={(raw: unknown, ctx: CanvasRenderingContext2D, globalScale: number) => {
            const node = raw as ForceNode;
            const isHighlighted = !highlightNodes || highlightNodes.has(node.id);
            const color = node.selected ? "#a78bfa" : node.unresolved ? "#f59e0b" : node.isShared ? "#818cf8" : "#a1a1aa";
            const radius = node.val;
            ctx.save();
            ctx.globalAlpha = isHighlighted ? 1 : 0.25;
            if (node.selected || hoveredNodeId === node.id) {
              ctx.shadowColor = color;
              ctx.shadowBlur = 14;
            }
            ctx.beginPath();
            ctx.arc(node.x || 0, node.y || 0, radius, 0, 2 * Math.PI);
            ctx.fillStyle = color;
            ctx.fill();
            ctx.shadowBlur = 0;
            const fontSize = Math.max(10 / globalScale, 3.2);
            ctx.font = `${node.selected ? "700" : "500"} ${fontSize}px Inter, sans-serif`;
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            ctx.fillStyle = node.selected ? "#e9d5ff" : node.unresolved ? "#fde68a" : "#d4d4d8";
            ctx.fillText(node.label.slice(0, 30), (node.x || 0) + radius + 3, node.y || 0);
            ctx.restore();
          }}
        />
      )}
      {links.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-zinc-600">No graph connections yet</div>
      )}
      <p className="absolute bottom-3 left-3 right-3 rounded-md border border-zinc-800 bg-zinc-950/80 px-3 py-2 text-[11px] leading-4 text-zinc-500 backdrop-blur">
        Graph connections: {links.length}. Local graph is generated from [[links]] and inferred title mentions. Amber nodes are unresolved links.
      </p>
    </div>
  );
}
