/**
 * Pure view-model helpers for the Projects board: which column a task sits
 * in, what a compact card shows, and how filters are described. Kept free of
 * React so the rules are unit-tested and shared by the board, the phone list
 * and the drawer.
 */

export type BoardTask = {
    id: string;
    projectId?: string | null;
    state?: string | null;
    taskKind?: string | null;
    priority?: number | null;
    inputJson?: unknown;
    taskType?: string | null;
    createdAt?: string | Date | null;
    updatedAt?: string | Date | null;
    assignedAgentId?: string | null;
    assignedMemberId?: string | null;
    humanApprovalRequired?: boolean | null;
    proofRequired?: boolean | null;
    blockedByTaskIds?: unknown;
};

/** Column keys in board order. `exceptions` holds failed and dead-lettered work. */
export const BOARD_COLUMNS = ["inbox", "in_progress", "blocked", "review", "done", "exceptions"] as const;
export type BoardColumnKey = (typeof BOARD_COLUMNS)[number];

export const BOARD_COLUMN_LABEL: Record<BoardColumnKey, string> = {
    inbox: "Inbox",
    in_progress: "In progress",
    blocked: "Blocked",
    review: "Review",
    done: "Done",
    exceptions: "Failed",
};

/** The task state a drop on a column sets. */
export const COLUMN_DROP_STATE: Record<BoardColumnKey, string> = {
    inbox: "inbox",
    in_progress: "in_progress",
    review: "review",
    blocked: "blocked",
    done: "done",
    exceptions: "failed",
};

export const STALE_INBOX_MS = 60 * 60 * 1000;
export const OVERDUE_REVIEW_MS = 24 * 60 * 60 * 1000;

export const isRecurringTask = (task: BoardTask | null | undefined) => task?.taskKind === "recurring" || task?.taskKind === "recurrent";
export const isExceptionTask = (task: BoardTask) => task.state === "failed" || task.state === "dead_letter";

function input(task: BoardTask): Record<string, unknown> {
    return task.inputJson && typeof task.inputJson === "object" ? task.inputJson as Record<string, unknown> : {};
}

export function taskTitle(task: BoardTask): string {
    const title = input(task).title;
    return typeof title === "string" && title.trim() ? title.trim() : task.taskType?.trim() || "Untitled task";
}

export function taskBody(task: BoardTask): string | null {
    const fields = input(task);
    for (const key of ["description", "prompt"] as const) {
        const value = fields[key];
        if (typeof value === "string" && value.trim()) return value.trim();
    }
    return null;
}

export function blockedReason(task: BoardTask): string {
    const reason = input(task).blockedReason;
    return typeof reason === "string" ? reason.trim() : "";
}

function ms(value: string | Date | null | undefined): number {
    if (!value) return 0;
    const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isFinite(time) ? time : 0;
}

/** True when the task waits on another task that is not done yet. */
export function isWaitingOnDependency(task: BoardTask, all: readonly BoardTask[]): boolean {
    const ids = Array.isArray(task.blockedByTaskIds) ? task.blockedByTaskIds as unknown[] : [];
    if (ids.length === 0) return false;
    return ids.some((id) => all.some((candidate) => candidate.id === id && candidate.state !== "done"));
}

/** Column for a non-recurring task. Queued counts as inbox. */
export function columnForTask(task: BoardTask): BoardColumnKey {
    switch (task.state) {
        case "in_progress": return "in_progress";
        case "review": return "review";
        case "blocked": return "blocked";
        case "done": return "done";
        case "failed":
        case "dead_letter": return "exceptions";
        default: return "inbox";
    }
}

export type ReviewBucket = "approval_needed" | "waiting_review" | "blocked" | "ready_to_close";
export const REVIEW_BUCKET_LABEL: Record<ReviewBucket, string> = {
    approval_needed: "Approval needed",
    waiting_review: "Waiting review",
    blocked: "Blocked",
    ready_to_close: "Ready to close",
};

export function reviewBucketFor(task: BoardTask, waitingOnDependency: boolean): ReviewBucket {
    if (waitingOnDependency) return "blocked";
    if (task.humanApprovalRequired) return "approval_needed";
    if (task.proofRequired) return "waiting_review";
    return "ready_to_close";
}

export type BoardGroups = {
    columns: Record<BoardColumnKey, BoardTask[]>;
    recurring: BoardTask[];
    attention: { deadLetter: BoardTask[]; failed: BoardTask[]; staleInbox: BoardTask[]; overdueReview: BoardTask[] };
    attentionCount: number;
    reviewCounts: Record<ReviewBucket, number>;
    waitingOnDependency: Set<string>;
};

const byPriorityThenRecent = (a: BoardTask, b: BoardTask) =>
    (b.priority ?? 0) - (a.priority ?? 0) || ms(b.updatedAt ?? b.createdAt) - ms(a.updatedAt ?? a.createdAt);

/** Group filtered tasks into board columns, recurring work and the needs-attention view. */
export function groupBoardTasks(tasks: readonly BoardTask[], nowMs: number): BoardGroups {
    const columns = Object.fromEntries(BOARD_COLUMNS.map((key) => [key, [] as BoardTask[]])) as Record<BoardColumnKey, BoardTask[]>;
    const recurring: BoardTask[] = [];
    const waitingOnDependency = new Set<string>();
    for (const task of tasks) {
        if (isWaitingOnDependency(task, tasks)) waitingOnDependency.add(task.id);
        if (isRecurringTask(task)) { recurring.push(task); continue; }
        columns[columnForTask(task)].push(task);
    }
    for (const key of BOARD_COLUMNS) {
        // Done is a log: most recently finished first. Review shows
        // dependency-blocked work last. Everything else by priority, then recency.
        columns[key].sort(key === "done"
            ? (a, b) => ms(b.updatedAt ?? b.createdAt) - ms(a.updatedAt ?? a.createdAt)
            : key === "review"
                ? (a, b) => Number(waitingOnDependency.has(a.id)) - Number(waitingOnDependency.has(b.id)) || byPriorityThenRecent(a, b)
                : byPriorityThenRecent);
    }
    const attention = {
        deadLetter: columns.exceptions.filter((task) => task.state === "dead_letter"),
        failed: columns.exceptions.filter((task) => task.state === "failed"),
        staleInbox: columns.inbox.filter((task) => nowMs - ms(task.createdAt) > STALE_INBOX_MS),
        overdueReview: columns.review.filter((task) => nowMs - ms(task.updatedAt) > OVERDUE_REVIEW_MS),
    };
    const reviewCounts: Record<ReviewBucket, number> = { approval_needed: 0, waiting_review: 0, blocked: 0, ready_to_close: 0 };
    for (const task of columns.review) reviewCounts[reviewBucketFor(task, waitingOnDependency.has(task.id))] += 1;
    return {
        columns,
        recurring,
        attention,
        attentionCount: attention.deadLetter.length + attention.failed.length + attention.staleInbox.length + attention.overdueReview.length,
        reviewCounts,
        waitingOnDependency,
    };
}

// ─── Cards ──────────────────────────────────────────────────────────────────

export type PriorityLevel = { label: string; tone: "low" | "medium" | "high" | "critical" };

/** Priority to show on a card, or null when none is set (no "No priority" noise). */
export function priorityLevel(priority: number | null | undefined): PriorityLevel | null {
    const p = Number(priority) || 0;
    if (p >= 100) return { label: "Urgent", tone: "critical" };
    if (p >= 75) return { label: "High", tone: "high" };
    if (p >= 50) return { label: "Medium", tone: "medium" };
    if (p >= 25) return { label: "Low", tone: "low" };
    return null;
}

/** "now", "12m", "5h", "3d", "2w", "4mo" since `from`. */
export function formatAge(from: string | Date | null | undefined, nowMs: number): string {
    const start = ms(from);
    if (!start) return "";
    const diff = Math.max(0, nowMs - start);
    const minutes = Math.floor(diff / 60_000);
    if (minutes < 1) return "now";
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    if (days < 14) return `${days}d`;
    if (days < 60) return `${Math.floor(days / 7)}w`;
    return `${Math.floor(days / 30)}mo`;
}

export type CardSignal = "failed" | "blocked" | "approval" | "needs_you" | "stalled" | "proof";
export const CARD_SIGNAL_LABEL: Record<CardSignal, string> = {
    failed: "Failed",
    blocked: "Blocked",
    approval: "Needs approval",
    needs_you: "Assigned to you",
    stalled: "Waiting too long",
    proof: "Proof required",
};

/**
 * Small state signals for a card. The column already says the state, so
 * these only carry what the column does not: a decision waiting on a person,
 * a dependency, a stall or a failure.
 */
export function cardSignals(task: BoardTask, context: { nowMs: number; waitingOnDependency?: boolean; currentMemberId?: string | null }): CardSignal[] {
    const signals: CardSignal[] = [];
    const state = task.state ?? "inbox";
    const open = state !== "done";
    if (state === "failed" || state === "dead_letter") signals.push("failed");
    // A blocked column card does not need a blocked icon; a dependency wait elsewhere does.
    if (context.waitingOnDependency && state !== "blocked") signals.push("blocked");
    if (open && task.humanApprovalRequired) signals.push("approval");
    if (open && context.currentMemberId && task.assignedMemberId === context.currentMemberId) signals.push("needs_you");
    const staleInbox = (state === "inbox" || state === "queued") && context.nowMs - ms(task.createdAt) > STALE_INBOX_MS;
    const overdueReview = state === "review" && context.nowMs - ms(task.updatedAt) > OVERDUE_REVIEW_MS;
    if (staleInbox || overdueReview) signals.push("stalled");
    if (open && state === "review" && task.proofRequired && !task.humanApprovalRequired) signals.push("proof");
    return signals;
}

/**
 * The muted context line under a card title. When the board is already
 * filtered to one project, repeating that project on every card is noise,
 * so only the customer (if any) is shown.
 */
export function cardContextLine(parts: { customerName?: string | null; projectName?: string | null; filteredToProject?: boolean; filteredToCustomer?: boolean }): string {
    const customer = parts.customerName?.trim() || "";
    const project = parts.projectName?.trim() || "";
    if (parts.filteredToProject) return parts.filteredToCustomer ? "" : customer;
    if (parts.filteredToCustomer) return project;
    // "Harbor Dental / Harbor Dental website relaunch" says the customer twice.
    if (customer && project.toLowerCase().startsWith(customer.toLowerCase())) {
        const rest = project.slice(customer.length).replace(/^[\s:·|/–—-]+/u, "");
        if (rest) return `${customer} / ${rest.charAt(0).toUpperCase()}${rest.slice(1)}`;
    }
    return [customer, project].filter(Boolean).join(" / ");
}

/** "AB" initials for an owner avatar. */
export function initialsOf(name: string | null | undefined): string {
    const words = (name ?? "").replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return "?";
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/** Sentence-case a snake/kebab key: "in_progress" becomes "In progress". */
export function sentenceCase(value: unknown): string {
    if (typeof value !== "string" || !value.trim()) return "";
    const text = value.replace(/[_:-]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
    return text.charAt(0).toUpperCase() + text.slice(1);
}

function stringList(value: unknown): string[] {
    if (Array.isArray(value)) return value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
    if (typeof value === "string" && value.trim()) return value.split("\n").map((line) => line.replace(/^\s*(?:[-*]\s+(?:\[[ xX]\]\s+)?)?/, "").trim()).filter(Boolean);
    return [];
}

/**
 * The task brief as one Markdown document: the description (or prompt), then
 * any structured fields a form or agent filled in (goal, acceptance criteria,
 * definition of done, deliverables) as short sections. Returns null when the
 * task carries no readable instructions.
 */
export function taskBriefMarkdown(task: BoardTask): string | null {
    const fields = input(task);
    const body = taskBody(task);
    const parts: string[] = [];
    if (body) parts.push(body);
    const goal = typeof fields.goal === "string" ? fields.goal.trim() : "";
    const title = taskTitle(task);
    if (goal && goal !== title && !(body ?? "").includes(goal)) parts.push(`**Goal:** ${goal}`);
    const criteria = stringList(fields.acceptanceCriteria);
    if (criteria.length > 0) parts.push(`**Done when**\n\n${criteria.map((line) => `- [ ] ${line}`).join("\n")}`);
    const dod = typeof fields.definitionOfDone === "string" ? fields.definitionOfDone.trim() : "";
    if (dod && !(body ?? "").includes(dod)) parts.push(`**Definition of done:** ${dod}`);
    const deliverables = stringList(fields.deliverables);
    if (deliverables.length > 0) parts.push(`**Deliverables**\n\n${deliverables.map((line) => `- ${line}`).join("\n")}`);
    return parts.length > 0 ? parts.join("\n\n") : null;
}

/**
 * Agents sometimes write HTML into Markdown. The renderer never executes raw
 * HTML (it shows it as text), so tidy the common cases before rendering:
 * `<details><summary>T</summary>body</details>` becomes a bold "T" line and
 * its body, and script/style/iframe elements are dropped with their content.
 * Fenced code blocks are left untouched.
 */
export function tidyAgentMarkdown(markdown: string): string {
    return markdown
        .split(/(^```[^\n]*\n[\s\S]*?^```[ \t]*$)/m)
        .map((part, index) => {
            if (index % 2 === 1) return part;
            return part
                .replace(/<(script|style|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
                .replace(/<\/?(script|style|iframe)\b[^>]*>/gi, "")
                .replace(/<details\b[^>]*>\s*(?:<summary\b[^>]*>([\s\S]*?)<\/summary>)?([\s\S]*?)<\/details\s*>/gi, (_match, summary: string | undefined, body: string) => {
                    const title = (summary ?? "Details").replace(/<[^>]+>/g, "").trim() || "Details";
                    return `\n\n**${title}**\n\n${body.trim()}\n\n`;
                })
                .replace(/<br\s*\/?>/gi, "  \n");
        })
        .join("")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
