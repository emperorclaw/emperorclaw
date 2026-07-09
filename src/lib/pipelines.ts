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

export const PIPELINE_RUN_STATUSES = ["running", "succeeded", "failed", "partial"] as const;
export type PipelineRunStatus = (typeof PIPELINE_RUN_STATUSES)[number];

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
