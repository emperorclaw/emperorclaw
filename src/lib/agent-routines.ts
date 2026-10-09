import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { agents, approvalTaskLinks, approvals, companies, tasks } from "@/db/schema";
import { SLA_TRACKED_TASK_STATES } from "@/lib/task-state";

/**
 * The daily review: once a day, at the company's chosen local time, every
 * agent that has work gets a message in its direct thread listing its open
 * tasks and what to do with them — move each forward, keep its state and
 * notes current, close what is done, ask about what is blocked — and replies
 * with a short summary. Out of the box this is what makes the board stay
 * alive without a person nudging each agent.
 *
 * Agents with no open tasks get nothing, so the review costs no tokens for
 * idle agents. On by default; configurable per company in Settings.
 */

export interface RoutineSettings {
    enabled: boolean;
    stallRemindersEnabled: boolean;
    time: string; // "HH:MM", 24h, in `timezone`
    timezone: string; // IANA, e.g. "Europe/Madrid"
    weekdaysOnly: boolean;
}

export const DEFAULT_ROUTINE: RoutineSettings = { enabled: true, stallRemindersEnabled: true, time: "09:00", timezone: "UTC", weekdaysOnly: true };

const MAX_TASKS_IN_REVIEW = 15;

function validTimezone(tz: unknown): tz is string {
    if (typeof tz !== "string" || !tz) return false;
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

export function normalizeRoutine(raw: unknown): RoutineSettings {
    const input = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const time = typeof input.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(input.time) ? input.time : DEFAULT_ROUTINE.time;
    return {
        stallRemindersEnabled: typeof input.stallRemindersEnabled === "boolean" ? input.stallRemindersEnabled : true,
        enabled: typeof input.enabled === "boolean" ? input.enabled : DEFAULT_ROUTINE.enabled,
        time,
        timezone: validTimezone(input.timezone) ? input.timezone : DEFAULT_ROUTINE.timezone,
        weekdaysOnly: typeof input.weekdaysOnly === "boolean" ? input.weekdaysOnly : DEFAULT_ROUTINE.weekdaysOnly,
    };
}

/** The local date, time, and weekday in a timezone. Pure. */
export function localClock(now: Date, timezone: string): { date: string; time: string; weekday: number } {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        weekday: "short",
    }).formatToParts(now).map((p) => [p.type, p.value]));
    const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
    return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, weekday };
}

/** Is the review due right now for these settings? Pure. */
export function routineDue(settings: RoutineSettings, lastRunOn: string | null, now: Date): { due: boolean; localDate: string } {
    const clock = localClock(now, settings.timezone);
    if (!settings.enabled) return { due: false, localDate: clock.date };
    if (lastRunOn === clock.date) return { due: false, localDate: clock.date };
    if (settings.weekdaysOnly && (clock.weekday === 0 || clock.weekday === 6)) return { due: false, localDate: clock.date };
    return { due: clock.time >= settings.time, localDate: clock.date };
}

type ReviewTask = { id: string; state: string; title: string; dueAt: Date | null; pendingApproval: boolean };

function humanDue(due: Date | null, now: Date): string | null {
    if (!due) return null;
    const days = Math.round((due.getTime() - now.getTime()) / 86_400_000);
    if (days < 0) return `overdue by ${-days} day${days === -1 ? "" : "s"}`;
    if (days === 0) return "due today";
    if (days === 1) return "due tomorrow";
    return `due in ${days} days`;
}

/** The review message an agent receives. Pure; record links render as live cards. */
export function reviewMessage(agentTasks: ReviewTask[], now: Date): string {
    const shown = agentTasks.slice(0, MAX_TASKS_IN_REVIEW);
    const lines = shown.map((t) => {
        const extras = [t.state.replace(/_/g, " "), humanDue(t.dueAt, now), t.pendingApproval ? "waiting for approval" : null].filter(Boolean).join(", ");
        return `- [${t.title.replace(/[[\]]/g, "")}](emperor://task/${t.id}) — ${extras}`;
    });
    const more = agentTasks.length > shown.length ? `\n- …and ${agentTasks.length - shown.length} more (emperor_list_tasks)` : "";
    return [
        `Daily review (automatic). You have ${agentTasks.length} open task${agentTasks.length === 1 ? "" : "s"}:`,
        "",
        ...lines,
        more,
        "",
        "Go through them now:",
        "1. Move each task forward. When you start one, set it to in_progress; keep its state true.",
        "2. Add a task note with today's progress, or the exact blocker.",
        "3. Close a task (done) only when its acceptance criteria are met and the evidence is attached. If it needs a person's sign-off, request an approval instead of closing it.",
        "4. For anything blocked on a person, ask them one concrete question (by @name) and say so in the task note.",
        "",
        "Then reply here with a short summary: done, in progress, and blocked (and on whom). Skip tasks waiting for approval unless something changed.",
    ].filter((line, i, all) => !(line === "" && all[i - 1] === "")).join("\n").trim();
}

/** Run the daily review for every company where it is due. Returns agents reviewed. */
export async function runDailyRoutines(now = new Date()): Promise<number> {
    const rows = await db.select({ id: companies.id, routine: companies.agentRoutineJson, lastRunOn: companies.agentRoutineLastRunOn })
        .from(companies).where(isNull(companies.deletedAt));
    let reviewed = 0;
    for (const company of rows) {
        const settings = normalizeRoutine(company.routine);
        const { due, localDate } = routineDue(settings, company.lastRunOn, now);
        if (!due) continue;
        // Claim the day first, so a crash or a second server can't send twice.
        const claimed = await db.update(companies).set({ agentRoutineLastRunOn: localDate })
            .where(and(eq(companies.id, company.id), company.lastRunOn ? eq(companies.agentRoutineLastRunOn, company.lastRunOn) : isNull(companies.agentRoutineLastRunOn)))
            .returning({ id: companies.id });
        if (claimed.length === 0) continue;
        reviewed += await reviewCompany(company.id, now);
    }
    return reviewed;
}

/** Send today's review to each agent of one company that has open tasks. */
export async function reviewCompany(companyId: string, now = new Date()): Promise<number> {
    const { appendThreadMessage, ensureDirectThread } = await import("@/lib/control-plane");
    const openTasks = await db.select({ id: tasks.id, state: tasks.state, inputJson: tasks.inputJson, taskType: tasks.taskType, slaDueAt: tasks.slaDueAt, priority: tasks.priority, assignedAgentId: tasks.assignedAgentId })
        .from(tasks)
        .innerJoin(agents, eq(agents.id, tasks.assignedAgentId))
        .where(and(eq(tasks.companyId, companyId), inArray(tasks.state, [...SLA_TRACKED_TASK_STATES]), isNull(tasks.deletedAt), isNull(agents.deletedAt)));
    if (openTasks.length === 0) return 0;

    const pendingRows = await db.select({ taskId: approvalTaskLinks.taskId }).from(approvalTaskLinks)
        .innerJoin(approvals, eq(approvals.id, approvalTaskLinks.approvalId))
        .where(and(eq(approvalTaskLinks.companyId, companyId), eq(approvals.status, "pending"), inArray(approvalTaskLinks.taskId, openTasks.map((t) => t.id))));
    const pending = new Set(pendingRows.map((r) => r.taskId));

    const byAgent = new Map<string, ReviewTask[]>();
    for (const t of openTasks) {
        const input = t.inputJson && typeof t.inputJson === "object" ? t.inputJson as Record<string, unknown> : {};
        const title = typeof input.title === "string" && input.title.trim() ? input.title.trim() : t.taskType;
        const list = byAgent.get(t.assignedAgentId!) ?? [];
        list.push({ id: t.id, state: t.state, title, dueAt: t.slaDueAt, pendingApproval: pending.has(t.id) });
        byAgent.set(t.assignedAgentId!, list);
    }

    let sent = 0;
    for (const [agentId, list] of byAgent) {
        // Overdue first, then soonest due, then in-progress work.
        list.sort((a, b) => (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity) || (a.state === "in_progress" ? -1 : 1));
        const thread = await ensureDirectThread(companyId, agentId, null);
        await appendThreadMessage({
            companyId,
            threadId: thread.id,
            senderType: "system",
            targetAgentId: agentId,
            text: reviewMessage(list, now),
            // Queued, so runtimes pick it up and report on it like a person's message.
            deliveryState: "queued",
            metadataJson: { routine: "daily_review", taskCount: list.length },
        });
        sent += 1;
    }
    return sent;
}
