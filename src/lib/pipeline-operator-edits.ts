// An automation edited by a person in the app.
//
// Agents own their automations' definitions (they register them over MCP and
// re-register on every boot), but a person may change when one runs and what
// it does from the Automations page (PATCH /api/pipelines/[id]). Those fields
// become operator-owned (pipelines.operator_fields): MCP register and MCP
// PATCH keep the person's values and tell the agent which fields are theirs,
// so it updates its runtime instead of overwriting the edit. A schedule set in
// the app is kept by Emperor (scheduledBy 'emperor'); choosing "the agent runs
// it" again in the app hands the schedule back.
//
// Pure (no DB), unit-tested in tests/unit/pipeline-operator-edits.test.ts.

export const OPERATOR_FIELDS = ["schedule", "purpose", "docMarkdown", "steps", "context"] as const;
export type OperatorField = (typeof OPERATOR_FIELDS)[number];

/** Longest purpose and documentation a person may save from the app. */
export const PURPOSE_MAX = 1000;
export const DOC_MARKDOWN_MAX = 100_000;

/** The pipeline columns each operator-owned field covers. */
export const OPERATOR_FIELD_COLUMNS: Record<OperatorField, readonly PipelineEditableColumn[]> = {
    schedule: ["trigger", "triggerConfig", "scheduledBy"],
    purpose: ["purpose"],
    docMarkdown: ["docMarkdown"],
    steps: ["stepsJson"],
    context: ["contextQuery", "contextResourceIds", "contextTagFilters", "contextMaxChars"],
};

export type PipelineEditableValues = {
    trigger: string;
    triggerConfig: unknown;
    scheduledBy: string;
    purpose: string | null;
    docMarkdown: string | null;
    stepsJson: unknown;
    contextQuery: string | null;
    contextResourceIds: unknown;
    contextTagFilters: unknown;
    contextMaxChars: number;
};
export type PipelineEditableColumn = keyof PipelineEditableValues;

export function isOperatorField(value: unknown): value is OperatorField {
    return typeof value === "string" && (OPERATOR_FIELDS as readonly string[]).includes(value);
}

/** The operator-owned fields stored on a pipeline (unknown entries dropped), in a stable order. */
export function operatorFieldsOf(value: unknown): OperatorField[] {
    const list = Array.isArray(value) ? value.filter(isOperatorField) : [];
    return OPERATOR_FIELDS.filter((field) => list.includes(field));
}

/** `current` plus `added`, minus `removed`, in a stable order. */
export function withOperatorFields(current: unknown, added: readonly OperatorField[], removed: readonly OperatorField[] = []): OperatorField[] {
    const set = new Set([...operatorFieldsOf(current), ...added]);
    for (const field of removed) set.delete(field);
    return OPERATOR_FIELDS.filter((field) => set.has(field));
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * An agent's write (MCP register or PATCH) with the operator's values kept:
 * every proposed column of an operator-owned field is replaced by the stored
 * value. `ignored` names the owned fields the agent tried to change (only the
 * columns it actually sent, when `sent` is given), for the response.
 */
export function keepOperatorValues<T extends Partial<PipelineEditableValues>>(
    owned: readonly OperatorField[],
    proposed: T,
    existing: PipelineEditableValues,
    sent?: ReadonlySet<string>,
): { values: T; ignored: OperatorField[] } {
    const values = { ...proposed };
    const ignored: OperatorField[] = [];
    for (const field of owned) {
        for (const column of OPERATOR_FIELD_COLUMNS[field]) {
            if (!(column in proposed)) continue;
            const wanted = proposed[column];
            if (!same(wanted, existing[column]) && (!sent || sent.has(column)) && !ignored.includes(field)) ignored.push(field);
            (values as Record<string, unknown>)[column] = existing[column];
        }
    }
    return { values, ignored: OPERATOR_FIELDS.filter((field) => ignored.includes(field)) };
}

const FIELD_WORDS: Record<OperatorField, string> = {
    schedule: "schedule",
    purpose: "purpose",
    docMarkdown: "documentation",
    steps: "steps",
    context: "context pack",
};

/** "schedule, steps and documentation". */
export function operatorFieldList(fields: readonly OperatorField[]): string {
    const words = fields.map((field) => FIELD_WORDS[field]);
    if (words.length <= 1) return words.join("");
    return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/**
 * What an MCP register/PATCH response tells the agent about operator-owned
 * fields (null when there are none). English, agent-facing.
 */
export function operatorOwnedNotice(pipelineId: string, owned: readonly OperatorField[], ignored: readonly OperatorField[]): string | null {
    if (owned.length === 0) return null;
    const parts = [
        `A person edited this automation's ${operatorFieldList(owned)} in the Emperor app; those fields are operator-owned and agents can't change them.`,
    ];
    if (ignored.length > 0) parts.push(`Your values for the ${operatorFieldList(ignored)} were not applied.`);
    if (owned.includes("schedule")) parts.push("Emperor keeps the schedule and gives you a task at each run: don't fire it from your own runtime.");
    parts.push(`Read the current version with GET /api/mcp/pipelines/${pipelineId} and update your runtime to match.`);
    return parts.join(" ");
}

/** A value shown inside quotes in an agent prompt: one line, no quotes or control/bidi characters, capped. */
export function promptQuoted(value: string, max = 120): string {
    const clean = value
        .replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, " ")
        .replace(/["“”[\]`]/g, "")
        .replace(/\s+/g, " ")
        .trim();
    return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export type ScheduleSnapshot = {
    /** null = no schedule (runs only when started). */
    cron: string | null;
    timezone: string | null;
    /** The plain-words description (cronstrue), when readable. */
    description: string | null;
};

function scheduleWords(schedule: ScheduleSnapshot): string {
    if (!schedule.cron) return "no schedule (only when someone starts it)";
    const detail = [promptQuoted(schedule.cron, 60), schedule.timezone ? promptQuoted(schedule.timezone, 60) : ""].filter(Boolean).join(", ");
    return schedule.description ? `${promptQuoted(schedule.description)} (${detail})` : detail;
}

/**
 * The notice the runner agent gets when a person hands the schedule back to
 * it ("The agent runs it from its runtime"): Emperor no longer starts runs,
 * and the stored schedule (kept as it is) is the one to fire. English,
 * agent-facing, sanitized.
 */
export function scheduleHandBackMessage(input: {
    pipelineId: string;
    pipelineName: string;
    editorName: string;
    schedule: ScheduleSnapshot;
}): string {
    return [
        `${promptQuoted(input.editorName) || "A teammate"} handed the schedule of the automation "${promptQuoted(input.pipelineName)}" back to you in the Emperor app.`,
        `Emperor no longer starts its runs: fire it from your own runtime on this schedule, which stays as it was: ${scheduleWords(input.schedule)}.`,
        `Report each run with POST /api/mcp/pipelines/${input.pipelineId}/runs. You may change the schedule again by re-registering the automation.`,
    ].join("\n");
}

/**
 * The one system message the runner agent gets after a person edits its
 * automation in the app: what changed (the schedule old → new in plain words,
 * or which parts were updated) and what that means for it. English,
 * agent-facing; every person- or agent-written value is sanitized.
 */
export function operatorEditMessage(input: {
    pipelineId: string;
    pipelineName: string;
    editorName: string;
    changed: readonly OperatorField[];
    schedule?: { before: ScheduleSnapshot; after: ScheduleSnapshot } | null;
}): string {
    const lines = [`${promptQuoted(input.editorName) || "A teammate"} edited the automation "${promptQuoted(input.pipelineName)}" in the Emperor app.`];
    if (input.changed.includes("schedule") && input.schedule) {
        lines.push(`- When it runs: ${scheduleWords(input.schedule.before)} → ${scheduleWords(input.schedule.after)}`);
    }
    for (const field of input.changed) {
        if (field === "schedule") continue;
        lines.push(`- ${FIELD_WORDS[field][0].toUpperCase()}${FIELD_WORDS[field].slice(1)} updated.`);
    }
    if (input.changed.includes("schedule") && input.schedule?.after.cron) {
        lines.push("", "Emperor now keeps this schedule: at each run it gives you a task. Stop firing this automation from your own runtime so it never runs twice.");
    } else if (input.changed.includes("schedule")) {
        lines.push("", "It no longer runs on a schedule: stop firing it from your own runtime.");
    }
    lines.push(
        "",
        `The ${operatorFieldList(input.changed)} ${input.changed.length === 1 ? "is" : "are"} now operator-owned: re-registering the automation won't change ${input.changed.length === 1 ? "it" : "them"}. `
        + `Read the current version with GET /api/mcp/pipelines/${input.pipelineId} and update your runtime to match.`,
    );
    return lines.join("\n");
}
