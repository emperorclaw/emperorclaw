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
import { IconCircleCheck, IconClock, IconCopy, IconDatabase, IconFileText, IconStack2, IconArrowsMaximize, IconArrowsMinimize, IconPlayerPlay, IconRepeat, IconSearch, IconSparkles, IconTrash, IconArrowsSplit } from "@tabler/icons-react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { PageHeader } from "@/components/page-header";
import { taskHref } from "@/lib/task-story";
import {
  AgentChip, EmptyAutomationsState, HowItRuns, nextRunText, PauseResumeButton, RunHistoryItem, RunNowButton, RunNowDialog, RunStatusDot,
  runStatusText, StatusToggle, type AgentOption, type AutomationRow, type AutomationRun,
} from "./automation-parts";

type PipelineStep = {
  id?: string;
  name?: string;
  title?: string;
  type?: string;
  description?: string;
  prompt?: string;
  dependsOn?: string[];
};

type PipelineRow = AutomationRow & {
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

type RunRow = AutomationRun & {
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
  agents: AgentOption[];
  agentsMap: Record<string, string>;
  projectsMap: Record<string, string>;
  customersMap: Record<string, string>;
  peopleMap: Record<string, string>;
  tasksMap: Record<string, string>;
  canEdit: boolean;
};

const STATUS_STYLES: Record<string, string> = {
  active: "border-emerald-500/25 bg-emerald-500/10 text-emerald-300",
  draft: "border-zinc-500/25 bg-zinc-500/10 text-zinc-300",
  paused: "border-amber-500/25 bg-amber-500/10 text-amber-300",
  retired: "border-red-500/25 bg-red-500/10 text-red-300",
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

const toneIcons: Record<PipelineNodeData["tone"], typeof IconPlayerPlay> = {
  trigger: IconPlayerPlay,
  context: IconDatabase,
  step: IconStack2,
  output: IconFileText,
  evidence: IconCircleCheck,
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

type Translate = ReturnType<typeof useTranslations<"pipelines">>;

const PIPELINE_STATUSES = new Set(["active", "draft", "paused", "retired"]);
const RUN_STATUSES = new Set(["succeeded", "failed", "partial", "running", "skipped"]);
const statusLabel = (t: Translate, status: string) => (PIPELINE_STATUSES.has(status) ? t(`statuses.${status as "active"}`) : status);
const runStatusLabel = (t: Translate, status: string) => (RUN_STATUSES.has(status) ? t(`runStatuses.${status as "running"}`) : status);

/** The trigger, for the screen (the copy-ready markdown keeps English: triggerText). */
function triggerLabel(t: Translate, pipeline: PipelineRow) {
  if (pipeline.trigger === "cron") return pipeline.triggerConfig?.cron ? t("trigger.scheduleAt", { cron: String(pipeline.triggerConfig.cron) }) : t("trigger.schedule");
  if (pipeline.trigger === "event") return t("trigger.event");
  if (pipeline.trigger === "manual") return t("trigger.manual");
  return pipeline.trigger || t("trigger.agent");
}

/** Where the pipeline runs, for the screen (the copy-ready markdown keeps English: scopeLabel). */
function scopeText(t: Translate, pipeline: PipelineRow, agentsMap: Record<string, string>, projectsMap: Record<string, string>, customersMap: Record<string, string>) {
  const parts = [
    pipeline.customerId ? customersMap[pipeline.customerId] || t("scope.customer") : null,
    pipeline.projectId ? projectsMap[pipeline.projectId] || t("scope.project") : null,
    pipeline.ownerAgentId ? agentsMap[pipeline.ownerAgentId] || t("scope.agent") : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" / ") : t("scope.company");
}

function triggerText(pipeline: PipelineRow) {
  if (pipeline.trigger === "cron") return pipeline.triggerConfig?.cron ? `Schedule: ${String(pipeline.triggerConfig.cron)}` : "Schedule";
  if (pipeline.trigger === "event") return "Event trigger";
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

function buildPipelineGraph(pipeline: PipelineRow, runs: RunRow[], t: Translate): { nodes: Node<PipelineNodeData>[]; edges: Edge[] } {
  const steps = parseSteps(pipeline.stepsJson);
  const latestRun = runs.find((run) => run.pipelineId === pipeline.id);
  const contextTags = stringArray(pipeline.contextTagFilters).map((tag) => `#${tag}`).join(", ");
  const contextSources = stringArray(pipeline.contextResourceIds).length;
  const nodes: Node<PipelineNodeData>[] = [
    {
      id: "trigger",
      type: "pipelineDoc",
      position: { x: 0, y: 0 },
      data: { label: triggerLabel(t, pipeline), eyebrow: t("graph.trigger"), body: "", tone: "trigger" },
    },
    {
      id: "context",
      type: "pipelineDoc",
      position: { x: 0, y: 140 },
      data: {
        label: t("graph.contextPack"),
        eyebrow: t("graph.ragContract"),
        body: pipeline.contextQuery || contextTags || (contextSources > 0 ? t("graph.pinnedSources", { count: contextSources }) : ""),
        tone: "context",
      },
    },
  ];

  const stepNodes = steps.length > 0 ? steps : [{ id: "empty", name: t("graph.noSteps"), description: "" }];

  stepNodes.forEach((step, index) => {
    nodes.push({
      id: `step-${index}`,
      type: "pipelineDoc",
      position: { x: 320 + index * 300, y: index % 2 === 0 ? 40 : 210 },
      data: {
        label: step.name || step.title || t("stepN", { n: index + 1 }),
        eyebrow: step.type || t("stepN", { n: index + 1 }),
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
      data: { label: t("graph.output"), eyebrow: t("graph.deliverable"), body: pipeline.docMarkdown || pipeline.purpose || "", tone: "output" },
    },
    {
      id: "evidence",
      type: "pipelineDoc",
      position: { x: 680 + stepNodes.length * 260, y: 220 },
      data: {
        label: latestRun ? t("graph.runEvidenceOf", { status: runStatusLabel(t, latestRun.status) }) : t("graph.runEvidence"),
        eyebrow: t("graph.auditTrail"),
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
  const t = useTranslations("pipelines");
  const graph = useMemo(() => buildPipelineGraph(pipeline, runs, t), [pipeline, runs, t]);
  const { nodes, edges } = useElkLayout(graph.nodes, graph.edges);
  const [expanded, setExpanded] = useState(false);

  const steps = parseSteps(pipeline.stepsJson);
  const latestRun = runs.find((run) => run.pipelineId === pipeline.id);
  const contextCount = stringArray(pipeline.contextResourceIds).length + stringArray(pipeline.contextTagFilters).length;
  const ownerName = pipeline.ownerAgentId ? agentsMap[pipeline.ownerAgentId] || t("scope.agent") : t("anyAgent");

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
            ? "fixed inset-4 z-50 flex flex-col overflow-hidden rounded-3xl border border-zinc-800/80 bg-[radial-gradient(circle_at_25%_10%,rgba(34,211,238,0.14),transparent_30%),radial-gradient(circle_at_75%_20%,rgba(168,85,247,0.12),transparent_32%),#050507] shadow-2xl shadow-black/60 force-dark"
            : "relative flex h-[70vh] min-h-[520px] flex-col overflow-hidden rounded-3xl border border-zinc-800/80 bg-[radial-gradient(circle_at_25%_10%,rgba(34,211,238,0.14),transparent_30%),radial-gradient(circle_at_75%_20%,rgba(168,85,247,0.12),transparent_32%),#050507] force-dark"
        }
      >
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="absolute right-3 top-3 z-10 inline-flex items-center gap-2 rounded-full border border-zinc-700 bg-zinc-950/90 px-3 py-1.5 text-xs font-medium text-zinc-300 backdrop-blur transition-colors hover:border-cyan-400/40 hover:text-cyan-100"
      >
        {expanded ? <IconArrowsMinimize className="h-3.5 w-3.5" /> : <IconArrowsMaximize className="h-3.5 w-3.5" />}
        {expanded ? t("collapse") : t("expand")}
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
          <MiniMap pannable zoomable className="!border !border-border !bg-card" nodeColor={(node) => toneHex[(node.data as PipelineNodeData).tone]} />
          <Controls className="!border !border-border !bg-card !text-foreground" />
        </ReactFlow>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-border bg-card px-4 py-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5"><span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT_STYLES[pipeline.status] || "bg-zinc-600"}`} />{statusLabel(t, pipeline.status)}</span>
        <span>{t("stepCount", { count: steps.length || 0 })}</span>
        <span>{t("owner", { name: ownerName })}</span>
        <span>{t("contextSources", { count: contextCount })}</span>
        <span>{latestRun ? t("lastRun", { status: runStatusLabel(t, latestRun.status) }) : t("noRunsYet")}</span>
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
    latestRun ? `- Latest run: ${latestRun.status} at ${new Date(latestRun.startedAt).toISOString()}${latestRun.summary ? ` - ${latestRun.summary}` : ""}` : "- No runs reported yet.",
  ].join("\n");
}

async function copyPipelineMarkdown(markdown: string, t: Translate) {
  try {
    await navigator.clipboard.writeText(markdown);
    toast.success(t("copied"));
  } catch {
    toast.error(t("copyFailed"));
  }
}

function Metric({ label, value, icon: Icon }: { label: string; value: string | number; icon: typeof IconArrowsSplit }) {
  return (
    <div className="rounded-xl sm:rounded-2xl border border-zinc-800 bg-zinc-950/70 p-2.5 sm:p-4">
      <div className="flex items-center gap-1.5 sm:gap-2 text-[10px] sm:text-xs font-bold uppercase tracking-[0.2em] text-zinc-500"><Icon className="h-3 w-3 sm:h-4 sm:w-4" />{label}</div>
      <div className="mt-1 sm:mt-2 text-lg sm:text-2xl font-semibold text-zinc-100">{value}</div>
    </div>
  );
}

export default function PipelinesClient({ initialPipelines, initialRuns, agents, agentsMap, projectsMap, customersMap, peopleMap, tasksMap, canEdit }: PipelineClientProps) {
  const t = useTranslations("pipelines");
  const format = useFormatter();
  const router = useRouter();
  const [pipelines, setPipelines] = useState(initialPipelines);
  const [selectedId, setSelectedId] = useState(initialPipelines[0]?.id || "");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [runDialogFor, setRunDialogFor] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // A server refresh (an action here, or a run that started or closed
  // elsewhere) brings new rows: take them.
  useEffect(() => { setPipelines(initialPipelines); }, [initialPipelines]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);

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
  const runDialogPipeline = pipelines.find((pipeline) => pipeline.id === runDialogFor) ?? null;

  const deletePipeline = useCallback(async (pipeline: PipelineRow) => {
    if (confirmingDelete !== pipeline.id) {
      setConfirmingDelete(pipeline.id);
      setTimeout(() => setConfirmingDelete(null), 4000);
      return;
    }
    setConfirmingDelete(null);
    const res = await fetch(`/api/pipelines/${pipeline.id}`, { method: "DELETE" });
    if (!res.ok) {
      toast.error(t("deleteFailed"));
      return;
    }
    setPipelines((current) => current.filter((item) => item.id !== pipeline.id));
    setSelectedId((current) => (current === pipeline.id ? "" : current));
    toast.success(t("deleted"));
  }, [confirmingDelete, t]);

  /** PATCH and keep the row in step; the error text comes from the server when it has one. */
  const patchPipeline = useCallback(async (pipeline: PipelineRow, body: Record<string, unknown>, success: string, failure: string) => {
    setSavingId(pipeline.id);
    try {
      const res = await fetch(`/api/pipelines/${pipeline.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(typeof data?.error === "string" ? data.error : failure);
        return;
      }
      setPipelines((current) => current.map((item) => (item.id === pipeline.id ? { ...item, ...data.pipeline, schedule: item.schedule } : item)));
      toast.success(success);
      router.refresh();
    } catch {
      toast.error(failure);
    } finally {
      setSavingId(null);
    }
  }, [router]);

  const toggleStatus = useCallback((pipeline: PipelineRow, next: "active" | "paused") => {
    void patchPipeline(pipeline, { status: next }, next === "paused" ? t("toggle.paused", { name: pipeline.name }) : t("toggle.resumed", { name: pipeline.name }), t("toggle.failed"));
  }, [patchPipeline, t]);

  const changeRunner = useCallback((pipeline: PipelineRow, agentId: string | null) => {
    if (agentId === pipeline.ownerAgentId) return;
    const name = agentId ? agentsMap[agentId] || t("scope.agent") : null;
    void patchPipeline(pipeline, { ownerAgentId: agentId }, name ? t("runner.changed", { name }) : t("runner.cleared"), t("runner.changeFailed"));
  }, [agentsMap, patchPipeline, t]);

  const changeScheduler = useCallback((pipeline: PipelineRow, scheduledBy: "agent" | "emperor") => {
    if (scheduledBy === pipeline.scheduledBy) return;
    void patchPipeline(pipeline, { scheduledBy }, scheduledBy === "emperor" ? t("schedule.nowEmperor") : t("schedule.nowAgent"), t("schedule.changeFailed"));
  }, [patchPipeline, t]);

  const onRunStarted = useCallback((result: { taskId: string }, agentName: string) => {
    setRunDialogFor(null);
    toast.success(t("runNow.started", { agent: agentName }), {
      action: { label: t("runNow.openTask"), onClick: () => router.push(taskHref(result.taskId)) },
    });
    router.refresh();
  }, [router, t]);

  const activeCount = pipelines.filter((pipeline) => pipeline.status === "active").length;
  const runCount = pipelines.reduce((sum, pipeline) => sum + (pipeline.runCount || 0), 0);
  const documentedCount = pipelines.filter((pipeline) => parseSteps(pipeline.stepsJson).length > 0 || pipeline.docMarkdown).length;

  return (
    <div className="mx-auto flex max-w-[1800px] flex-col gap-6 animate-in fade-in duration-500">
        <PageHeader
          eyebrow={t("eyebrow")}
          title={t("title")}
          description={t("description")}
          actions={
            <div className="grid grid-cols-3 gap-2 sm:gap-3 w-full sm:w-auto">
              <Metric label={t("metrics.active")} value={activeCount} icon={IconPlayerPlay} />
              <Metric label={t("metrics.runs")} value={runCount} icon={IconRepeat} />
              <Metric label={t("metrics.documented")} value={documentedCount} icon={IconFileText} />
            </div>
          }
        />

        {pipelines.length === 0 ? <EmptyAutomationsState /> : (
          <div className="grid grid-cols-1 gap-4 sm:gap-6 lg:grid-cols-[300px_minmax(0,1fr)] lg:grid-rows-[auto_auto_1fr] lg:[grid-template-areas:'list_head'_'list_side'_'list_map'] 2xl:grid-cols-[320px_minmax(0,1fr)_400px] 2xl:grid-rows-[auto_1fr] 2xl:[grid-template-areas:'list_head_side'_'list_map_side']">
            {/* Phone: list, header, how it runs, map. Laptop: the list beside the rest. Wide: how it runs gets its own column. */}
            <aside className="rounded-[1.25rem] sm:rounded-[1.75rem] border border-zinc-800 bg-zinc-950/80 p-3 sm:p-4 lg:[grid-area:list] lg:self-start">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-zinc-100">{t("explorer")}</h2>
                <span className="rounded-full border border-zinc-800 px-2 py-0.5 text-xs text-zinc-500">{filteredPipelines.length}</span>
              </div>
              <label className="mt-4 flex items-center gap-2 rounded-2xl border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-400">
                <IconSearch className="h-4 w-4" />
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("searchPlaceholder")} className="w-full bg-transparent text-zinc-100 outline-none placeholder:text-zinc-600" />
              </label>
              <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
                {["all", "active", "draft", "paused", "retired"].map((item) => (
                  <button key={item} type="button" onClick={() => setStatus(item)} className={`shrink-0 cursor-pointer whitespace-nowrap rounded-full border px-3 py-1 text-xs font-medium transition-colors ${status === item ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-200" : "border-zinc-800 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300"}`}>
                    {item === "all" ? t("all") : statusLabel(t, item)}
                  </button>
                ))}
              </div>
              <div className="mt-4 space-y-2">
                {filteredPipelines.map((pipeline) => {
                  const next = pipeline.trigger === "cron" || pipeline.status !== "active" ? nextRunText(t, format, pipeline) : null;
                  return (
                    <div
                      key={pipeline.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelectedId(pipeline.id)}
                      onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); setSelectedId(pipeline.id); } }}
                      className={`w-full cursor-pointer rounded-2xl border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/50 ${selectedPipeline?.id === pipeline.id ? "border-cyan-400/40 bg-cyan-400/10" : "border-zinc-800 bg-zinc-900/30 hover:border-zinc-700"}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="font-medium text-zinc-100">{pipeline.name}</div>
                          <div className="mt-1 line-clamp-2 text-xs leading-5 text-zinc-500">{pipeline.purpose || t("noPurpose")}</div>
                        </div>
                        <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase ${STATUS_STYLES[pipeline.status] || STATUS_STYLES.draft}`}>{statusLabel(t, pipeline.status)}</span>
                      </div>
                      <div className="mt-3 flex flex-col gap-1.5 text-[11px] text-zinc-500">
                        <AgentChip agent={pipeline.ownerAgentId ? agentById.get(pipeline.ownerAgentId) : null} size={18} className="text-zinc-300" />
                        <span className="inline-flex items-center gap-1.5">
                          <IconClock className="h-3 w-3 shrink-0" />
                          {pipeline.lastRunAt ? (
                            <>
                              <RunStatusDot status={pipeline.lastRunStatus || ""} />
                              {t("lastRunAt", { status: runStatusText(t, pipeline.lastRunStatus || ""), time: format.relativeTime(new Date(pipeline.lastRunAt), now) })}
                            </>
                          ) : t("lastRunNever")}
                        </span>
                        {next ? <span className={pipeline.status === "active" ? "text-zinc-400" : "text-amber-300/80"}>{next}</span> : null}
                      </div>
                      {canEdit && (pipeline.status === "active" || pipeline.status === "paused") ? (
                        <div className="mt-2 flex items-center justify-between gap-2">
                          <RunNowButton compact disabled={pipeline.status !== "active"} onClick={() => setRunDialogFor(pipeline.id)} />
                          <StatusToggle pipeline={pipeline} disabled={savingId === pipeline.id} onToggle={(nextStatus) => toggleStatus(pipeline, nextStatus)} />
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </aside>

              {selectedPipeline && (
                  <div className="flex min-w-0 flex-col gap-3 rounded-[1.25rem] sm:rounded-[1.75rem] border border-zinc-800 bg-zinc-950/80 p-4 sm:p-5 lg:[grid-area:head]">
                    <div className="min-w-0">
                      <div className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-[0.22em] text-zinc-500"><span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT_STYLES[selectedPipeline.status] || "bg-zinc-600"}`} />{statusLabel(t, selectedPipeline.status)}</div>
                      <h2 className="mt-1 break-words text-2xl font-semibold text-zinc-50">{selectedPipeline.name}</h2>
                      <p className="mt-1 text-sm text-zinc-400">{scopeText(t, selectedPipeline, agentsMap, projectsMap, customersMap)}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {canEdit && selectedPipeline.status === "active" ? <RunNowButton onClick={() => setRunDialogFor(selectedPipeline.id)} /> : null}
                      {canEdit ? <PauseResumeButton pipeline={selectedPipeline} disabled={savingId === selectedPipeline.id} onToggle={(nextStatus) => toggleStatus(selectedPipeline, nextStatus)} /> : null}
                      <button type="button" onClick={() => copyPipelineMarkdown(selectedMarkdown, t)} className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-zinc-700 bg-zinc-900/60 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:border-zinc-600">
                        <IconCopy className="h-4 w-4" /> {t("copyDocs")}
                      </button>
                      {canEdit ? (
                        <button type="button" onClick={() => deletePipeline(selectedPipeline)} className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-red-500/25 bg-red-500/10 px-4 py-2 text-sm font-medium text-red-200 transition-colors hover:bg-red-500/15">
                          <IconTrash className="h-4 w-4" /> {confirmingDelete === selectedPipeline?.id ? t("confirmDelete") : t("delete")}
                        </button>
                      ) : null}
                    </div>
                  </div>
              )}

            <aside className="min-w-0 rounded-[1.25rem] sm:rounded-[1.75rem] border border-zinc-800 bg-zinc-950/80 p-4 sm:p-5 lg:[grid-area:side] 2xl:self-start">
              {selectedPipeline && (
                <div className="space-y-6">
                  <HowItRuns
                    pipeline={selectedPipeline}
                    agents={agents}
                    agentsMap={agentsMap}
                    peopleMap={peopleMap}
                    canEdit={canEdit && savingId !== selectedPipeline.id}
                    onChangeRunner={(agentId) => changeRunner(selectedPipeline, agentId)}
                    onChangeScheduler={(scheduledBy) => changeScheduler(selectedPipeline, scheduledBy)}
                  />

                  <section className="space-y-3">
                    <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-100"><IconCircleCheck className="h-4 w-4" />{t("recentRuns")}</h3>
                    {selectedRuns.length === 0 ? <p className="text-sm text-zinc-500">{t("noRunsReported")}</p> : (
                      <ul className="space-y-2">
                        {selectedRuns.slice(0, 10).map((run) => (
                          <RunHistoryItem key={run.id} run={run} agentsMap={agentsMap} peopleMap={peopleMap} tasksMap={tasksMap} now={now} />
                        ))}
                      </ul>
                    )}
                  </section>

                  <section>
                    <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.22em] text-violet-300"><IconFileText className="h-4 w-4" />{t("documentation")}</div>
                    <h2 className="mt-2 text-xl font-semibold text-zinc-50">{t("contract")}</h2>
                  </section>

                  <section className="rounded-2xl border border-violet-500/20 bg-violet-500/[0.06] p-4">
                    <h3 className="flex items-center gap-2 text-sm font-semibold text-violet-100"><IconDatabase className="h-4 w-4" />{t("graph.contextPack")}</h3>
                    <dl className="mt-3 space-y-2 text-sm text-zinc-400">
                      <div><dt className="text-xs uppercase tracking-wider text-zinc-500">{t("context.query")}</dt><dd>{selectedPipeline.contextQuery || t("context.notSet")}</dd></div>
                      <div><dt className="text-xs uppercase tracking-wider text-zinc-500">{t("context.pinned")}</dt><dd>{stringArray(selectedPipeline.contextResourceIds).length || t("context.none")}</dd></div>
                      <div><dt className="text-xs uppercase tracking-wider text-zinc-500">{t("context.tags")}</dt><dd>{stringArray(selectedPipeline.contextTagFilters).map((tag) => `#${tag}`).join(", ") || t("context.none")}</dd></div>
                      <div><dt className="text-xs uppercase tracking-wider text-zinc-500">{t("context.budget")}</dt><dd>{t("context.chars", { count: selectedPipeline.contextMaxChars || 8000 })}</dd></div>
                    </dl>
                  </section>

                  <section className="space-y-3">
                    <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-100"><IconStack2 className="h-4 w-4" />{t("workflowSteps")}</h3>
                    {parseSteps(selectedPipeline.stepsJson).length === 0 ? (
                      <div className="rounded-2xl border border-dashed border-zinc-700 p-4 text-sm text-zinc-500">{t("noStepsHint")}</div>
                    ) : (
                      <ol className="space-y-2">
                        {parseSteps(selectedPipeline.stepsJson).map((step, index) => (
                          <li key={`${step.id || step.name || index}`} className="rounded-2xl border border-zinc-800 bg-zinc-900/30 p-3">
                            <div className="flex items-center gap-2 text-sm font-medium text-zinc-100"><span className="grid h-6 w-6 place-items-center rounded-full bg-zinc-800 text-xs text-zinc-400">{index + 1}</span>{step.name || step.title || t("stepN", { n: index + 1 })}</div>
                            <p className="mt-2 text-xs leading-5 text-zinc-500">{step.description || step.prompt || t("noStepDescription")}</p>
                          </li>
                        ))}
                      </ol>
                    )}
                  </section>

                  <section className="rounded-2xl border border-zinc-800 bg-zinc-900/30 p-4">
                    <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-100"><IconSparkles className="h-4 w-4" />{t("copyReady")}</h3>
                    <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-xl bg-zinc-950/60 p-3 text-xs leading-5 text-zinc-400">{selectedMarkdown}</pre>
                  </section>
                </div>
              )}
            </aside>

            {selectedPipeline ? (
              <main className="min-w-0 lg:[grid-area:map]">
                <PipelineFlowMap pipeline={selectedPipeline} runs={selectedRuns} agentsMap={agentsMap} />
              </main>
            ) : null}
          </div>
        )}
        <RunNowDialog
          pipeline={runDialogPipeline}
          agents={agents}
          open={runDialogPipeline !== null}
          onClose={() => setRunDialogFor(null)}
          onStarted={onRunStarted}
        />
    </div>
  );
}
