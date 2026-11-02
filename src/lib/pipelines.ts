// Pipelines registry helpers.
//
// Agent-first contract: pipelines are built and executed inside the agent's
// own runtime. Emperor only registers them, documents them, and tracks runs.
// The mermaid diagram is ALWAYS generated server-side from the declared steps
// so it can never drift from what was registered.

export type PipelineStep = {
    name: string;
    agentRef?: string; // agent name or id that executes the step
    taskType?: string;
    description?: string;
    gate?: boolean; // true = human approval gate before continuing
};

export type PipelineContextConfig = {
    contextQuery: string | null;
    contextResourceIds: string[];
    contextTagFilters: string[];
    contextMaxChars: number;
};

export type PipelineTrigger = "cron" | "event" | "manual";

export const PIPELINE_STATUSES = ["draft", "active", "paused", "retired"] as const;
export type PipelineStatus = (typeof PIPELINE_STATUSES)[number];

export const PIPELINE_RUN_STATUSES = ["running", "succeeded", "failed", "partial", "skipped"] as const;
export type PipelineRunStatus = (typeof PIPELINE_RUN_STATUSES)[number];

/**
 * What started a run. `manual` is Run now from the app, `agent` a run the agent
 * reported from its runtime, `schedule` a scheduled run (the agent's or
 * Emperor's), `api` an operator or agent calling run_automation. A run stored
 * before 0.27 has none (null): it was reported by the agent.
 */
export const PIPELINE_RUN_SOURCES = ["manual", "agent", "schedule", "api"] as const;
export type PipelineRunSource = (typeof PIPELINE_RUN_SOURCES)[number];

/** The sources an agent may name when it reports a run through the runs API. */
export const AGENT_REPORTED_RUN_SOURCES = ["agent", "schedule"] as const;

/** Who fires a cron automation: its agent's runtime (default) or Emperor itself. */
export const PIPELINE_SCHEDULERS = ["agent", "emperor"] as const;
export type PipelineScheduler = (typeof PIPELINE_SCHEDULERS)[number];

export function isPipelineScheduler(value: unknown): value is PipelineScheduler {
    return typeof value === "string" && (PIPELINE_SCHEDULERS as readonly string[]).includes(value);
}

export type PipelineRunOrigin =
    | { kind: "manual" | "api" | "agent"; who: { type: "user" | "agent"; id: string } | null }
    | { kind: "schedule"; who: null }
    | { kind: "legacy"; agentId: string | null };

/**
 * How a run's history line names its origin ("Run now · by Alex", "Agent ·
 * Quill", "Schedule", "Reported by Quill"). Pure: the caller resolves names.
 */
export function pipelineRunOrigin(run: {
    source?: string | null;
    triggeredByType?: string | null;
    triggeredById?: string | null;
    agentId?: string | null;
}): PipelineRunOrigin {
    const source = run.source;
    if (!source || !(PIPELINE_RUN_SOURCES as readonly string[]).includes(source)) {
        return { kind: "legacy", agentId: run.agentId ?? null };
    }
    if (source === "schedule") return { kind: "schedule", who: null };
    const who = (run.triggeredByType === "user" || run.triggeredByType === "agent") && run.triggeredById
        ? { type: run.triggeredByType as "user" | "agent", id: run.triggeredById }
        : source === "agent" && run.agentId ? { type: "agent" as const, id: run.agentId } : null;
    return { kind: source as "manual" | "api" | "agent", who };
}

/** A run is finished when it is anything but running. */
export function isTerminalRunStatus(status: string): boolean {
    return status !== "running";
}

/** Milliseconds a run took (or has taken so far, against `now`); null without a start. */
export function pipelineRunDurationMs(run: { startedAt: string | Date; endedAt?: string | Date | null }, now = new Date()): number | null {
    const start = new Date(run.startedAt).getTime();
    if (!Number.isFinite(start)) return null;
    const end = run.endedAt ? new Date(run.endedAt).getTime() : now.getTime();
    return Number.isFinite(end) ? Math.max(0, end - start) : null;
}

/** The run status a linked task's terminal state closes the run with; null while the task is open. */
export function runStatusForTaskState(state: string): "succeeded" | "failed" | null {
    if (state === "done") return "succeeded";
    if (state === "failed" || state === "dead_letter") return "failed";
    return null;
}

export function parsePipelineSteps(input: unknown): { steps: PipelineStep[]; error?: string } {
    if (input == null) return { steps: [] };
    if (!Array.isArray(input)) return { steps: [], error: "steps must be an array" };
    if (input.length > 50) return { steps: [], error: "steps cannot exceed 50 entries" };

    const steps: PipelineStep[] = [];
    for (let i = 0; i < input.length; i++) {
        const raw = input[i];
        if (typeof raw !== "object" || raw === null || typeof (raw as { name?: unknown }).name !== "string" || !(raw as { name: string }).name.trim()) {
            return { steps: [], error: `steps[${i}] must be an object with a non-empty "name"` };
        }
        const r = raw as Record<string, unknown>;
        steps.push({
            name: String(r.name).slice(0, 120),
            agentRef: typeof r.agentRef === "string" ? r.agentRef.slice(0, 120) : undefined,
            taskType: typeof r.taskType === "string" ? r.taskType.slice(0, 120) : undefined,
            description: typeof r.description === "string" ? r.description.slice(0, 500) : undefined,
            gate: r.gate === true,
        });
    }
    return { steps };
}

function stringList(input: unknown, maxItems: number, maxLength: number): string[] {
    if (!Array.isArray(input)) return [];
    return Array.from(new Set(input
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim().slice(0, maxLength))))
        .slice(0, maxItems);
}

export function parsePipelineContextConfig(input: {
    contextQuery?: unknown;
    contextResourceIds?: unknown;
    contextTagFilters?: unknown;
    contextMaxChars?: unknown;
}): PipelineContextConfig {
    const requestedMaxChars = Number(input.contextMaxChars);
    return {
        contextQuery: typeof input.contextQuery === "string" && input.contextQuery.trim()
            ? input.contextQuery.trim().slice(0, 500)
            : null,
        contextResourceIds: stringList(input.contextResourceIds, 30, 80),
        contextTagFilters: stringList(input.contextTagFilters, 20, 80).map((tag) => tag.replace(/^#/, "")),
        contextMaxChars: Number.isFinite(requestedMaxChars)
            ? Math.min(Math.max(Math.trunc(requestedMaxChars), 1000), 24000)
            : 8000,
    };
}

export function buildPipelineContextParams(pipeline: {
    customerId?: string | null;
    projectId?: string | null;
    ownerAgentId?: string | null;
    contextResourceIds?: unknown;
    contextTagFilters?: unknown;
    contextMaxChars?: number | null;
}) {
    const context = parsePipelineContextConfig({
        contextResourceIds: pipeline.contextResourceIds,
        contextTagFilters: pipeline.contextTagFilters,
        contextMaxChars: pipeline.contextMaxChars,
    });
    return {
        customerId: pipeline.customerId || null,
        projectId: pipeline.projectId || null,
        agentId: pipeline.ownerAgentId || null,
        resourceIds: context.contextResourceIds,
        tagFilters: context.contextTagFilters,
        maxChars: context.contextMaxChars,
    };
}

export function extractRunContextSourceIds(input: {
    contextSourceIds?: unknown;
    stats?: unknown;
}): string[] {
    const direct = stringList(input.contextSourceIds, 50, 80);
    if (direct.length > 0) return direct;
    const stats = typeof input.stats === "object" && input.stats !== null ? input.stats as Record<string, unknown> : {};
    return stringList(stats.contextSourceIds, 50, 80);
}

function sanitizeLabel(text: string): string {
    // Mermaid node labels inside quotes: strip quotes/backticks and control chars.
    return text.replace(/["`]/g, "'").replace(/[\r\n]+/g, " ").trim();
}

function triggerLabel(trigger: string, triggerConfig: unknown): string {
    const cfg = (typeof triggerConfig === "object" && triggerConfig !== null) ? triggerConfig as Record<string, unknown> : {};
    if (trigger === "cron" && typeof cfg.cron === "string") return `cron: ${cfg.cron}`;
    if (trigger === "event" && typeof cfg.event === "string") return `on: ${cfg.event}`;
    return trigger;
}

export function generateMermaid(trigger: string, triggerConfig: unknown, steps: PipelineStep[]): string {
    const lines: string[] = ["graph LR"];
    lines.push(`    TRIGGER(["${sanitizeLabel(triggerLabel(trigger, triggerConfig))}"])`);

    let prev = "TRIGGER";
    steps.forEach((step, i) => {
        const id = `S${i + 1}`;
        const label = step.agentRef ? `${step.agentRef}: ${step.name}` : step.name;
        if (step.gate) {
            const gateId = `G${i + 1}`;
            lines.push(`    ${gateId}{"approval gate"}`);
            lines.push(`    ${prev} --> ${gateId}`);
            prev = gateId;
        }
        lines.push(`    ${id}["${sanitizeLabel(label)}"]`);
        lines.push(`    ${prev} --> ${id}`);
        prev = id;
    });

    lines.push(`    OUT[("results: tasks / artifacts / proofs")]`);
    lines.push(`    ${prev} --> OUT`);
    return lines.join("\n");
}

// A pipeline may not be activated without honest documentation.
export function validateForActivation(pipeline: {
    purpose?: string | null;
    docMarkdown?: string | null;
    stepsJson?: unknown;
}): string | null {
    if (!pipeline.purpose?.trim()) {
        return "Pipeline cannot be activated without a purpose (one sentence: what it does and why).";
    }
    if (!pipeline.docMarkdown?.trim()) {
        return "Pipeline cannot be activated without docMarkdown (a written explanation of how it works).";
    }
    const steps = Array.isArray(pipeline.stepsJson) ? pipeline.stepsJson : [];
    if (steps.length === 0) {
        return "Pipeline cannot be activated without at least one declared step.";
    }
    return null;
}
