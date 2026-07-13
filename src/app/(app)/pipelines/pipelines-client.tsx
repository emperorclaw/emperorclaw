"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Background,
  BaseEdge,
  Controls,
  getBezierPath,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import ELK from "elkjs/lib/elk.bundled.js";
import {
  Bot,
  CheckCircle2,
  Clock,
  Copy,
  Database,
  FileText,
  Layers3,
  Maximize2,
  Minimize2,
  Play,
  Repeat,
  Search,
  Sparkles,
  Trash2,
  Workflow,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";

type PipelineStep = {
  id?: string;
  name?: string;
  title?: string;
  type?: string;
  description?: string;
  prompt?: string;
  dependsOn?: string[];
};

type PipelineRow = {
  id: string;
  name: string;
  purpose: string | null;
  docMarkdown: string | null;
  trigger: string;
  triggerConfig: Record<string, unknown> | null;
  stepsJson: unknown;
  diagramMermaid: string | null;
  contextQuery: string | null;
  contextResourceIds: string[] | null;
  contextTagFilters: string[] | null;
  contextMaxChars: number | null;
  runtimeRef: string | null;
  status: string;
  runCount: number;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  nextRunAt: string | null;
  ownerAgentId: string | null;
  projectId: string | null;
  customerId: string | null;
  updatedAt: string;
};

type RunRow = {
  id: string;
  pipelineId: string;
  status: string;
  summary: string | null;
  statsJson?: Record<string, unknown> | null;
  contextSourceIds?: string[] | null;
  contextSnapshot?: Record<string, unknown> | null;
  startedAt: string;
  endedAt: string | null;
};

type PipelineNodeData = {
  label: string;
  eyebrow: string;
  body: string;
  tone: "trigger" | "context" | "step" | "output" | "evidence";
};

type PipelineClientProps = {
  initialPipelines: PipelineRow[];
  initialRuns: RunRow[];
  agentsMap: Record<string, string>;
  projectsMap: Record<string, string>;
  customersMap: Record<string, string>;
};

const STATUS_STYLES: Record<string, string> = {
  active: "border-emerald-500/25 bg-emerald-500/10 text-emerald-300",
  draft: "border-zinc-500/25 bg-zinc-500/10 text-zinc-300",
  paused: "border-amber-500/25 bg-amber-500/10 text-amber-300",
  retired: "border-red-500/25 bg-red-500/10 text-red-300",
};

const RUN_STATUS_STYLES: Record<string, string> = {
  succeeded: "text-emerald-400",
  failed: "text-red-400",
  partial: "text-amber-400",
  running: "text-sky-400",
};

const STATUS_DOT_STYLES: Record<string, string> = {
  active: "bg-emerald-400",
  draft: "bg-zinc-400",
  paused: "bg-amber-400",
  retired: "bg-red-400",
};

const toneBarStyles: Record<PipelineNodeData["tone"], string> = {
  trigger: "bg-cyan-400",
  context: "bg-violet-400",
  step: "bg-zinc-500",
  output: "bg-emerald-400",
  evidence: "bg-amber-400",
};

const toneTextStyles: Record<PipelineNodeData["tone"], string> = {
  trigger: "text-cyan-300",
  context: "text-violet-300",
  step: "text-zinc-400",
  output: "text-emerald-300",
  evidence: "text-amber-300",
};

const toneHex: Record<PipelineNodeData["tone"], string> = {
  trigger: "#22d3ee",
  context: "#a78bfa",
  step: "#71717a",
  output: "#34d399",
  evidence: "#f59e0b",
};

const toneIcons: Record<PipelineNodeData["tone"], typeof Play> = {
  trigger: Play,
  context: Database,
  step: Layers3,
  output: FileText,
  evidence: CheckCircle2,
};

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function parseSteps(value: unknown): PipelineStep[] {
  if (Array.isArray(value)) return value as PipelineStep[];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function runEvidence(run: RunRow) {
  const stats = run.statsJson || {};
  return {
    contextSourceIds: stringArray(run.contextSourceIds),
    artifactIds: stringArray((stats as { artifactIds?: unknown }).artifactIds),
    taskIds: stringArray((stats as { taskIds?: unknown }).taskIds),
  };
}

function triggerText(pipeline: PipelineRow) {
  if (pipeline.trigger === "schedule" && pipeline.triggerConfig?.cron) return `Schedule: ${String(pipeline.triggerConfig.cron)}`;
  if (pipeline.trigger === "webhook") return "Webhook event";
  if (pipeline.trigger === "manual") return "Manual run";
  return pipeline.trigger || "Agent trigger";
}

function scopeLabel(pipeline: PipelineRow, agentsMap: Record<string, string>, projectsMap: Record<string, string>, customersMap: Record<string, string>) {
  const parts = [
    pipeline.customerId ? customersMap[pipeline.customerId] || "Customer" : null,
    pipeline.projectId ? projectsMap[pipeline.projectId] || "Project" : null,
    pipeline.ownerAgentId ? agentsMap[pipeline.ownerAgentId] || "Agent" : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" / ") : "Company workspace";
}

function PipelineDocNode({ data }: NodeProps<Node<PipelineNodeData>>) {
  const Icon = toneIcons[data.tone];
  return (
    <div className="min-w-[230px] max-w-[280px] overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950/95 shadow-2xl shadow-black/30 backdrop-blur">
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-zinc-950 !bg-current" style={{ color: toneHex[data.tone] }} />
      <div className={`h-1 w-full ${toneBarStyles[data.tone]}`} />
      <div className="p-4">
        <div className={`flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.22em] ${toneTextStyles[data.tone]}`}>
          <Icon className="h-3 w-3" />
          {data.eyebrow}
        </div>
        <div className="mt-1.5 text-sm font-semibold leading-tight text-zinc-100">{data.label}</div>
        {data.body ? <p className="mt-2 line-clamp-3 text-xs leading-relaxed text-zinc-400">{data.body}</p> : null}
      </div>
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-zinc-950 !bg-current" style={{ color: toneHex[data.tone] }} />
    </div>
  );
}

const nodeTypes = { pipelineDoc: PipelineDocNode };

type FlowEdgeData = { color?: string };

function AnimatedFlowEdge({ id, sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, style, markerEnd, data }: EdgeProps<Edge<FlowEdgeData>>) {
  const [edgePath] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const color = data?.color || "#71717a";
  return (
    <>
      <BaseEdge id={id} path={edgePath} style={style} markerEnd={markerEnd} />
      <circle r="3" fill={color}>
        <animateMotion dur="2.4s" repeatCount="indefinite">
          <mpath href={`#${id}`} />
        </animateMotion>
      </circle>
    </>
  );
}

const edgeTypes = { flowEdge: AnimatedFlowEdge };

function buildPipelineGraph(pipeline: PipelineRow, runs: RunRow[]): { nodes: Node<PipelineNodeData>[]; edges: Edge[] } {
  const steps = parseSteps(pipeline.stepsJson);
  const latestRun = runs.find((run) => run.pipelineId === pipeline.id);
  const contextTags = stringArray(pipeline.contextTagFilters).map((tag) => `#${tag}`).join(", ");
  const contextSources = stringArray(pipeline.contextResourceIds).length;
  const nodes: Node<PipelineNodeData>[] = [
    {
      id: "trigger",
      type: "pipelineDoc",
      position: { x: 0, y: 0 },
      data: { label: triggerText(pipeline), eyebrow: "Trigger", body: "", tone: "trigger" },
    },
    {
      id: "context",
      type: "pipelineDoc",
      position: { x: 0, y: 140 },
      data: {
        label: "Context Pack",
        eyebrow: "RAG contract",
        body: pipeline.contextQuery || contextTags || (contextSources > 0 ? `${contextSources} pinned source${contextSources === 1 ? "" : "s"}` : ""),
        tone: "context",
      },
    },
  ];

  const stepNodes = steps.length > 0 ? steps : [{ id: "empty", name: "No steps registered", description: "" }];

  stepNodes.forEach((step, index) => {
    nodes.push({
      id: `step-${index}`,
      type: "pipelineDoc",
      position: { x: 320 + index * 300, y: index % 2 === 0 ? 40 : 210 },
      data: {
        label: step.name || step.title || `Step ${index + 1}`,
        eyebrow: step.type || `Step ${index + 1}`,
        body: step.description || step.prompt || "",
        tone: "step",
      },
    });
  });

  nodes.push(
    {
      id: "output",
      type: "pipelineDoc",
      position: { x: 680 + stepNodes.length * 260, y: 40 },
      data: { label: "Output contract", eyebrow: "Deliverable", body: pipeline.docMarkdown || pipeline.purpose || "", tone: "output" },
    },
    {
      id: "evidence",
      type: "pipelineDoc",
      position: { x: 680 + stepNodes.length * 260, y: 220 },
      data: {
        label: latestRun ? `${latestRun.status} run evidence` : "Run evidence",
        eyebrow: "Audit trail",
        body: latestRun?.summary || "",
        tone: "evidence",
      },
    },
  );

  const flowEdge = (id: string, source: string, target: string, color: string): Edge => ({
    id,
    source,
    target,
    type: "flowEdge",
    style: { stroke: color, strokeWidth: 1.5 },
    data: { color },
  });

  const edges: Edge[] = [
    flowEdge("trigger-context", "trigger", "context", toneHex.trigger),
    flowEdge("context-first", "context", "step-0", toneHex.context),
  ];

  stepNodes.forEach((_, index) => {
    if (index < stepNodes.length - 1) edges.push(flowEdge(`step-${index}-step-${index + 1}`, `step-${index}`, `step-${index + 1}`, toneHex.step));
  });

  edges.push(
    flowEdge("last-output", `step-${stepNodes.length - 1}`, "output", toneHex.step),
    flowEdge("output-evidence", "output", "evidence", toneHex.output),
  );

  return { nodes, edges };
}

function useElkLayout(initialNodes: Node<PipelineNodeData>[], initialEdges: Edge[]) {
  const [nodes, setNodes] = useState(initialNodes);

  useEffect(() => {
    let cancelled = false;
    const elk = new ELK();
    const graph = {
      id: "root",
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": "RIGHT",
        "elk.spacing.nodeNode": "48",
        "elk.layered.spacing.nodeNodeBetweenLayers": "96",
      },
      children: initialNodes.map((node) => ({ id: node.id, width: 280, height: 132 })),
      edges: initialEdges.map((edge) => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
    };

    elk.layout(graph).then((layouted) => {
      if (cancelled) return;
      const positions = new Map((layouted.children || []).map((child) => [child.id, { x: child.x || 0, y: child.y || 0 }]));
      setNodes(initialNodes.map((node) => ({ ...node, position: positions.get(node.id) || node.position })));
    }).catch(() => setNodes(initialNodes));

    return () => {
      cancelled = true;
    };
  }, [initialNodes, initialEdges]);

  return { nodes, edges: initialEdges };
}

function PipelineFlowMap({ pipeline, runs, agentsMap }: { pipeline: PipelineRow; runs: RunRow[]; agentsMap: Record<string, string> }) {
  const graph = useMemo(() => buildPipelineGraph(pipeline, runs), [pipeline, runs]);
  const { nodes, edges } = useElkLayout(graph.nodes, graph.edges);
  const [expanded, setExpanded] = useState(false);

  const steps = parseSteps(pipeline.stepsJson);
  const latestRun = runs.find((run) => run.pipelineId === pipeline.id);
  const contextCount = stringArray(pipeline.contextResourceIds).length + stringArray(pipeline.contextTagFilters).length;
  const ownerName = pipeline.ownerAgentId ? agentsMap[pipeline.ownerAgentId] || "Agent" : "Any agent";

  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [expanded]);

  return (
    <>
      {expanded ? (
        <div className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm" onClick={() => setExpanded(false)} />
      ) : null}
      <div
        className={
          expanded
            ? "fixed inset-4 z-50 flex flex-col overflow-hidden rounded-3xl border border-zinc-800/80 bg-[radial-gradient(circle_at_25%_10%,rgba(34,211,238,0.14),transparent_30%),radial-gradient(circle_at_75%_20%,rgba(168,85,247,0.12),transparent_32%),#050507] shadow-2xl shadow-black/60"
            : "relative flex h-[70vh] min-h-[520px] flex-col overflow-hidden rounded-3xl border border-zinc-800/80 bg-[radial-gradient(circle_at_25%_10%,rgba(34,211,238,0.14),transparent_30%),radial-gradient(circle_at_75%_20%,rgba(168,85,247,0.12),transparent_32%),#050507]"
        }
      >
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="absolute right-3 top-3 z-10 inline-flex items-center gap-2 rounded-full border border-zinc-700 bg-zinc-950/90 px-3 py-1.5 text-xs font-medium text-zinc-300 backdrop-blur transition-colors hover:border-cyan-400/40 hover:text-cyan-100"
      >
        {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
        {expanded ? "Collapse" : "Expand"}
      </button>
      <div className="min-h-0 flex-1">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          colorMode="dark"
          fitView
          minZoom={0.15}
          maxZoom={1.75}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background color="rgba(148,163,184,0.18)" gap={28} />
          <MiniMap pannable zoomable className="!border !border-zinc-800 !bg-zinc-950/90" nodeColor={(node) => toneHex[(node.data as PipelineNodeData).tone]} />
          <Controls className="!border !border-zinc-800 !bg-zinc-950/90 !text-zinc-100" />
        </ReactFlow>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-zinc-800/80 bg-zinc-950/90 px-4 py-2 text-xs text-zinc-500">
        <span className="inline-flex items-center gap-1.5"><span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT_STYLES[pipeline.status] || "bg-zinc-600"}`} />{pipeline.status}</span>
        <span>{steps.length || 0} step{steps.length === 1 ? "" : "s"}</span>
        <span>Owner: {ownerName}</span>
        <span>{contextCount} context source{contextCount === 1 ? "" : "s"}</span>
        <span>{latestRun ? `Last run: ${latestRun.status}` : "No runs yet"}</span>
      </div>
      </div>
    </>
  );
}

function buildPipelineMarkdown(pipeline: PipelineRow, runs: RunRow[], agentsMap: Record<string, string>, projectsMap: Record<string, string>, customersMap: Record<string, string>) {
  const steps = parseSteps(pipeline.stepsJson);
  const latestRun = runs.find((run) => run.pipelineId === pipeline.id);
  const tags = stringArray(pipeline.contextTagFilters).map((tag) => `#${tag}`).join(", ") || "None";
  const pinned = stringArray(pipeline.contextResourceIds).join(", ") || "None";

  return [
    `# ${pipeline.name}`,
    "",
    `**Purpose:** ${pipeline.purpose || "Document the business purpose for this pipeline."}`,
    `**Scope:** ${scopeLabel(pipeline, agentsMap, projectsMap, customersMap)}`,
    `**Status:** ${pipeline.status}`,
    `**Trigger:** ${triggerText(pipeline)}`,
    "",
    "## Context Pack",
    `- Query: ${pipeline.contextQuery || "Not set"}`,
    `- Pinned sources: ${pinned}`,
    `- Tags: ${tags}`,
    `- Budget: ${pipeline.contextMaxChars || 8000} chars`,
    "",
    "## Workflow",
    ...(steps.length > 0 ? steps.map((step, index) => `${index + 1}. **${step.name || step.title || `Step ${index + 1}`}** - ${step.description || step.prompt || "Document this step."}`) : ["1. **No steps registered** - Ask the agent to register steps through the pipeline API."]),
    "",
    "## Evidence produced",
    latestRun ? `- Latest run: ${latestRun.status} at ${new Date(latestRun.startedAt).toLocaleString()}${latestRun.summary ? ` - ${latestRun.summary}` : ""}` : "- No runs reported yet.",
  ].join("\n");
}

async function copyPipelineMarkdown(markdown: string) {
  try {
    await navigator.clipboard.writeText(markdown);
    toast.success("Pipeline documentation copied");
  } catch {
    toast.error("Could not copy documentation");
  }
}

function Metric({ label, value, icon: Icon }: { label: string; value: string | number; icon: typeof Workflow }) {
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-4">
      <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.2em] text-zinc-500"><Icon className="h-4 w-4" />{label}</div>
      <div className="mt-2 text-2xl font-semibold text-zinc-100">{value}</div>
    </div>
  );
}

function EmptyPipelineState() {
  return (
    <div className="rounded-3xl border border-dashed border-zinc-700 bg-zinc-950/50 p-10 text-center">
      <Workflow className="mx-auto h-10 w-10 text-zinc-500" />
      <h2 className="mt-4 text-xl font-semibold text-zinc-100">No pipelines registered yet</h2>
      <p className="mx-auto mt-2 max-w-xl text-sm text-zinc-400">
        Pipelines are documentation contracts registered by agents through MCP. Emperor stores the map, context rules, and run evidence; the agent still performs the work in its own runtime.
      </p>
    </div>
  );
}

export default function PipelinesClient({ initialPipelines, initialRuns, agentsMap, projectsMap, customersMap }: PipelineClientProps) {
  const [pipelines, setPipelines] = useState(initialPipelines);
  const [selectedId, setSelectedId] = useState(initialPipelines[0]?.id || "");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);

  const filteredPipelines = useMemo(() => {
    return pipelines.filter((pipeline) => {
      const haystack = `${pipeline.name} ${pipeline.purpose || ""} ${pipeline.contextQuery || ""}`.toLowerCase();
      const matchesQuery = haystack.includes(query.toLowerCase());
      const matchesStatus = status === "all" || pipeline.status === status;
      return matchesQuery && matchesStatus;
    });
  }, [pipelines, query, status]);

  const selectedPipeline = filteredPipelines.find((pipeline) => pipeline.id === selectedId) || filteredPipelines[0] || pipelines[0];
  const selectedRuns = useMemo(() => initialRuns.filter((run) => run.pipelineId === selectedPipeline?.id), [initialRuns, selectedPipeline?.id]);
  const selectedMarkdown = selectedPipeline ? buildPipelineMarkdown(selectedPipeline, selectedRuns, agentsMap, projectsMap, customersMap) : "";

  const deletePipeline = useCallback(async (pipeline: PipelineRow) => {
    if (confirmingDelete !== pipeline.id) {
      setConfirmingDelete(pipeline.id);
      setTimeout(() => setConfirmingDelete(null), 4000);
      return;
    }
    setConfirmingDelete(null);
    const res = await fetch(`/api/pipelines/${pipeline.id}`, { method: "DELETE" });
    if (!res.ok) {
      toast.error("Could not delete pipeline");
      return;
    }
    setPipelines((current) => current.filter((item) => item.id !== pipeline.id));
    setSelectedId((current) => (current === pipeline.id ? "" : current));
    toast.success("Pipeline deleted");
  }, [confirmingDelete]);

  const activeCount = pipelines.filter((pipeline) => pipeline.status === "active").length;
  const runCount = pipelines.reduce((sum, pipeline) => sum + (pipeline.runCount || 0), 0);
  const documentedCount = pipelines.filter((pipeline) => parseSteps(pipeline.stepsJson).length > 0 || pipeline.docMarkdown).length;

  return (
    <div className="min-h-screen bg-zinc-950 px-4 py-6 text-zinc-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-[1800px] flex-col gap-6">
        <PageHeader
          eyebrow="Automations"
          title="Pipelines"
          description="A simple workspace to understand what agents do: visual map, Context Pack, run evidence, and copy-ready docs. Emperor documents and audits; agents execute in their own runtime."
          actions={
            <div className="grid grid-cols-3 gap-3 sm:min-w-[420px]">
              <Metric label="Active" value={activeCount} icon={Play} />
              <Metric label="Runs" value={runCount} icon={Repeat} />
              <Metric label="Documented" value={documentedCount} icon={FileText} />
            </div>
          }
        />

        {pipelines.length === 0 ? <EmptyPipelineState /> : (
          <div className="grid gap-6 xl:grid-cols-[360px_minmax(0,1fr)_430px]">
            <aside className="rounded-[1.75rem] border border-zinc-800 bg-zinc-950/80 p-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-zinc-100">Pipeline Explorer</h2>
                <span className="rounded-full border border-zinc-800 px-2 py-0.5 text-xs text-zinc-500">{filteredPipelines.length}</span>
              </div>
              <label className="mt-4 flex items-center gap-2 rounded-2xl border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-400">
                <Search className="h-4 w-4" />
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search pipelines" className="w-full bg-transparent text-zinc-100 outline-none placeholder:text-zinc-600" />
              </label>
              <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
                {["all", "active", "draft", "paused", "retired"].map((item) => (
                  <button key={item} type="button" onClick={() => setStatus(item)} className={`cursor-pointer rounded-full border px-3 py-1 text-xs font-medium transition-colors ${status === item ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-200" : "border-zinc-800 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300"}`}>
                    {item}
                  </button>
                ))}
              </div>
              <div className="mt-4 space-y-2">
                {filteredPipelines.map((pipeline) => (
                  <button key={pipeline.id} type="button" onClick={() => setSelectedId(pipeline.id)} className={`w-full cursor-pointer rounded-2xl border p-3 text-left transition-colors ${selectedPipeline?.id === pipeline.id ? "border-cyan-400/40 bg-cyan-400/10" : "border-zinc-800 bg-zinc-900/30 hover:border-zinc-700"}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-medium text-zinc-100">{pipeline.name}</div>
                        <div className="mt-1 line-clamp-2 text-xs leading-5 text-zinc-500">{pipeline.purpose || "No purpose documented yet."}</div>
                      </div>
                      <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase ${STATUS_STYLES[pipeline.status] || STATUS_STYLES.draft}`}>{pipeline.status}</span>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-zinc-500">
                      <span className="inline-flex items-center gap-1"><Bot className="h-3 w-3" />{pipeline.ownerAgentId ? agentsMap[pipeline.ownerAgentId] || "Agent" : "Any agent"}</span>
                      <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" />{pipeline.lastRunAt ? new Date(pipeline.lastRunAt).toLocaleDateString() : "No runs"}</span>
                    </div>
                  </button>
                ))}
              </div>
            </aside>

            <main className="min-w-0 space-y-4">
              {selectedPipeline && (
                <>
                  <div className="flex flex-col gap-3 rounded-[1.75rem] border border-zinc-800 bg-zinc-950/80 p-5 lg:flex-row lg:items-center lg:justify-between">
                    <div>
                      <div className="text-xs font-bold uppercase tracking-[0.22em] text-zinc-500">Visual Map</div>
                      <h2 className="mt-1 text-2xl font-semibold text-white">{selectedPipeline.name}</h2>
                      <p className="mt-1 text-sm text-zinc-400">{scopeLabel(selectedPipeline, agentsMap, projectsMap, customersMap)}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button type="button" onClick={() => copyPipelineMarkdown(selectedMarkdown)} className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-cyan-400/35 bg-cyan-400/10 px-4 py-2 text-sm font-medium text-cyan-100 transition-colors hover:bg-cyan-400/15">
                        <Copy className="h-4 w-4" /> Copy docs
                      </button>
                      <button type="button" onClick={() => deletePipeline(selectedPipeline)} className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-red-500/25 bg-red-500/10 px-4 py-2 text-sm font-medium text-red-200 transition-colors hover:bg-red-500/15">
                        <Trash2 className="h-4 w-4" /> {confirmingDelete === selectedPipeline?.id ? "Click again to confirm" : "Delete"}
                      </button>
                    </div>
                  </div>
                  <PipelineFlowMap pipeline={selectedPipeline} runs={selectedRuns} agentsMap={agentsMap} />
                </>
              )}
            </main>

            <aside className="rounded-[1.75rem] border border-zinc-800 bg-zinc-950/80 p-5">
              {selectedPipeline && (
                <div className="space-y-6">
                  <section>
                    <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.22em] text-violet-300"><FileText className="h-4 w-4" />Documentation</div>
                    <h2 className="mt-2 text-xl font-semibold text-white">Human-readable contract</h2>
                  </section>

                  <section className="rounded-2xl border border-violet-500/20 bg-violet-500/[0.06] p-4">
                    <h3 className="flex items-center gap-2 text-sm font-semibold text-violet-100"><Database className="h-4 w-4" />Context Pack</h3>
                    <dl className="mt-3 space-y-2 text-sm text-zinc-400">
                      <div><dt className="text-xs uppercase tracking-wider text-zinc-500">Query</dt><dd>{selectedPipeline.contextQuery || "Not set"}</dd></div>
                      <div><dt className="text-xs uppercase tracking-wider text-zinc-500">Pinned sources</dt><dd>{stringArray(selectedPipeline.contextResourceIds).length || "None"}</dd></div>
                      <div><dt className="text-xs uppercase tracking-wider text-zinc-500">Tags</dt><dd>{stringArray(selectedPipeline.contextTagFilters).map((tag) => `#${tag}`).join(", ") || "None"}</dd></div>
                      <div><dt className="text-xs uppercase tracking-wider text-zinc-500">Budget</dt><dd>{selectedPipeline.contextMaxChars || 8000} chars</dd></div>
                    </dl>
                  </section>

                  <section className="space-y-3">
                    <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-100"><Layers3 className="h-4 w-4" />Workflow steps</h3>
                    {parseSteps(selectedPipeline.stepsJson).length === 0 ? (
                      <div className="rounded-2xl border border-dashed border-zinc-700 p-4 text-sm text-zinc-500">No steps registered. Ask the agent to register steps, decisions, outputs, and evidence through the pipeline MCP endpoint.</div>
                    ) : (
                      <ol className="space-y-2">
                        {parseSteps(selectedPipeline.stepsJson).map((step, index) => (
                          <li key={`${step.id || step.name || index}`} className="rounded-2xl border border-zinc-800 bg-zinc-900/30 p-3">
                            <div className="flex items-center gap-2 text-sm font-medium text-zinc-100"><span className="grid h-6 w-6 place-items-center rounded-full bg-zinc-800 text-xs text-zinc-400">{index + 1}</span>{step.name || step.title || `Step ${index + 1}`}</div>
                            <p className="mt-2 text-xs leading-5 text-zinc-500">{step.description || step.prompt || "No description registered."}</p>
                          </li>
                        ))}
                      </ol>
                    )}
                  </section>

                  <section className="space-y-3">
                    <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-100"><CheckCircle2 className="h-4 w-4" />Recent runs</h3>
                    {selectedRuns.length === 0 ? <p className="text-sm text-zinc-500">No runs reported yet.</p> : (
                      <ul className="space-y-2">
                        {selectedRuns.slice(0, 6).map((run) => {
                          const evidence = runEvidence(run);
                          return (
                            <li key={run.id} className="rounded-2xl border border-zinc-800 bg-zinc-900/30 p-3 text-sm">
                              <div className="flex items-center justify-between gap-3">
                                <span className={`font-medium ${RUN_STATUS_STYLES[run.status] || "text-zinc-300"}`}>{run.status}</span>
                                <span className="text-xs text-zinc-500">{new Date(run.startedAt).toLocaleString()}</span>
                              </div>
                              {run.summary && <p className="mt-2 text-xs leading-5 text-zinc-400">{run.summary}</p>}
                              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-zinc-500">
                                <span>Sources used: {evidence.contextSourceIds.length}</span>
                                <span>Evidence produced: {evidence.taskIds.length} tasks / {evidence.artifactIds.length} artifacts</span>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </section>

                  <section className="rounded-2xl border border-zinc-800 bg-zinc-900/30 p-4">
                    <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-100"><Sparkles className="h-4 w-4" />Copy-ready markdown</h3>
                    <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-xl bg-black/35 p-3 text-xs leading-5 text-zinc-400">{selectedMarkdown}</pre>
                  </section>
                </div>
              )}
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}
