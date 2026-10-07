import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
    agents,
    companyMembers,
    companyNotificationWebhooks,
    messageThreads,
    notificationPreferences,
    notifications,
    threadMessages,
    threadParticipants,
    users,
} from "@/db/schema";
import { isEmailConfigured, sendEmail } from "@/lib/email";
import { getAppUrl } from "@/lib/env";
import { mentionedAgentIds } from "@/lib/message-routing";
import { decryptSecretPayload } from "@/lib/secrets";

/**
 * Notifications: what a person needs to know without watching the app.
 *
 * Every notification lands in the in-app inbox. Email (per person, per kind,
 * when SMTP is configured) and one company webhook (Slack, Discord, or JSON)
 * are optional channels. Repeats collapse through a dedupe key, so a busy
 * thread produces one notification per window, not one per message.
 *
 * Delivery never breaks the action that caused it: every public `notify*`
 * catches its own failures.
 */

export const NOTIFICATION_KINDS = ["mention", "decision", "approval", "task_assigned", "agent_failed", "agent_down", "incident", "stall", "loop_paused", "doctrine"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_KIND_LABELS: Record<NotificationKind, string> = {
    mention: "An agent @mentions you",
    decision: "An agent is waiting on your decision",
    approval: "An approval is requested",
    task_assigned: "A task is assigned to you",
    agent_failed: "An agent could not process your message",
    agent_down: "An agent goes offline with work waiting",
    incident: "A serious incident opens",
    stall: "A task has stalled",
    loop_paused: "Agent conversation paused",
    doctrine: "New team doctrine available",
};

/** Default email kinds for someone who never changed their preferences. */
export const DEFAULT_EMAIL_KINDS: NotificationKind[] = [...NOTIFICATION_KINDS];

const DEDUPE_WINDOW_MS = 10 * 60 * 1000;

export interface NotificationInput {
    kind: NotificationKind;
    title: string;
    body?: string | null;
    link?: string | null;
    sourceType?: string | null;
    sourceId?: string | null;
    /** Repeats with the same key inside the window collapse into one. */
    dedupeKey?: string | null;
}

function windowBucket(now = Date.now()): number {
    return Math.floor(now / DEDUPE_WINDOW_MS);
}

function clip(text: string | null | undefined, max: number): string | null {
    if (!text) return null;
    const clean = text.replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim();
    return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean || null;
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]!));
}

// ─── Core ──────────────────────────────────────────────────────────────────

/**
 * Create notifications for `userIds` and fan them out to email and the
 * company webhook. Returns how many new notifications were created.
 */
export async function notify(companyId: string, userIds: string[], input: NotificationInput): Promise<number> {
    const recipients = [...new Set(userIds.filter(Boolean))];
    if (recipients.length === 0) return 0;
    try {
        const dedupeKey = input.dedupeKey ? `${input.dedupeKey}:${windowBucket()}` : null;
        const rows = await db.insert(notifications).values(recipients.map((userId) => ({
            companyId,
            userId,
            kind: input.kind,
            title: input.title.slice(0, 200),
            body: clip(input.body, 500),
            link: input.link ?? null,
            sourceType: input.sourceType ?? null,
            sourceId: input.sourceId ?? null,
            dedupeKey,
        }))).onConflictDoNothing().returning();
        if (rows.length === 0) return 0;

        await Promise.allSettled([
            deliverEmails(companyId, rows),
            deliverWebhook(companyId, input),
        ]);
        return rows.length;
    } catch (error) {
        console.warn("[notifications] notify failed:", error instanceof Error ? error.message : error);
        return 0;
    }
}

async function deliverEmails(companyId: string, rows: (typeof notifications.$inferSelect)[]) {
    if (!isEmailConfigured() || rows.length === 0) return;
    const userIds = rows.map((r) => r.userId);
    const [people, prefs] = await Promise.all([
        db.select({ id: users.id, email: users.email }).from(users).where(inArray(users.id, userIds)),
        db.select().from(notificationPreferences).where(and(eq(notificationPreferences.companyId, companyId), inArray(notificationPreferences.userId, userIds))),
    ]);
    const emailOf = new Map(people.map((p) => [p.id, p.email]));
    const kindsOf = new Map(prefs.map((p) => [p.userId, new Set(p.emailKinds)]));
    const base = getAppUrl();
    for (const row of rows) {
        const wanted = kindsOf.get(row.userId) ?? new Set<string>(DEFAULT_EMAIL_KINDS);
        const to = emailOf.get(row.userId);
        if (!to || !wanted.has(row.kind)) continue;
        const link = row.link ? `${base}${row.link.startsWith("/") ? "" : "/"}${row.link}` : base;
        const sent = await sendEmail({ to, subject: row.title, html: notificationEmailHtml(row.title, row.body, link) });
        if (sent) await db.update(notifications).set({ emailedAt: new Date() }).where(eq(notifications.id, row.id));
    }
}

export function notificationEmailHtml(title: string, body: string | null, link: string): string {
    return `
    <div style="font-family: -apple-system, Segoe UI, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #18181b;">
        <p style="margin: 0 0 4px; font-size: 12px; letter-spacing: .12em; text-transform: uppercase; color: #0891b2;">EmperorClaw</p>
        <h1 style="margin: 0 0 12px; font-size: 18px;">${escapeHtml(title)}</h1>
        ${body ? `<p style="margin: 0 0 20px; font-size: 14px; line-height: 1.5; color: #3f3f46;">${escapeHtml(body)}</p>` : ""}
        <a href="${escapeHtml(link)}" style="display: inline-block; background: #22d3ee; color: #083344; padding: 10px 16px; border-radius: 8px; font-weight: 600; text-decoration: none;">Open in EmperorClaw</a>
        <p style="margin: 24px 0 0; font-size: 12px; color: #71717a;">You can change which notifications you get by email in Settings → Notifications.</p>
    </div>`;
}

// ─── Webhook ───────────────────────────────────────────────────────────────

export type WebhookFormat = "slack" | "discord" | "generic";

export function detectWebhookFormat(url: string): WebhookFormat {
    try {
        const host = new URL(url).hostname;
        if (host === "hooks.slack.com") return "slack";
        if (host === "discord.com" || host === "discordapp.com" || host.endsWith(".discord.com")) return "discord";
    } catch { /* fall through */ }
    return "generic";
}

export function webhookPayload(format: WebhookFormat, input: NotificationInput, link: string | null) {
    const line = `*${input.title}*${input.body ? `\n${clip(input.body, 400)}` : ""}${link ? `\n${link}` : ""}`;
    if (format === "slack") return { text: line };
    if (format === "discord") return { content: line.replace(/^\*(.*)\*/, "**$1**").slice(0, 1900) };
    return { source: "emperorclaw", kind: input.kind, title: input.title, body: clip(input.body, 1000), link };
}

async function deliverWebhook(companyId: string, input: NotificationInput) {
    const [hook] = await db.select().from(companyNotificationWebhooks)
        .where(and(eq(companyNotificationWebhooks.companyId, companyId), eq(companyNotificationWebhooks.enabled, true)))
        .limit(1);
    if (!hook || !hook.kinds.includes(input.kind)) return;
    await postWebhook(hook, input);
}

/** Post one notification to a stored webhook; records the outcome on the row. */
export async function postWebhook(hook: typeof companyNotificationWebhooks.$inferSelect, input: NotificationInput): Promise<{ ok: boolean; error?: string }> {
    let url: string | null = null;
    try {
        const decrypted = decryptSecretPayload(hook.encryptedUrl) as { url?: string } | null;
        url = decrypted?.url ?? null;
    } catch {
        url = null;
    }
    if (!url) {
        await db.update(companyNotificationWebhooks).set({ lastError: "Webhook URL can't be decrypted (check EMPEROR_CLAW_MASTER_KEY)", updatedAt: new Date() }).where(eq(companyNotificationWebhooks.id, hook.id));
        return { ok: false, error: "Webhook URL can't be decrypted" };
    }
    const base = getAppUrl();
    const link = input.link ? `${base}${input.link.startsWith("/") ? "" : "/"}${input.link}` : null;
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(webhookPayload(hook.format as WebhookFormat, input, link)),
            signal: AbortSignal.timeout(8000),
            redirect: "error",
        });
        const error = res.ok ? null : `HTTP ${res.status}`;
        await db.update(companyNotificationWebhooks).set({ lastDeliveryAt: new Date(), lastError: error, updatedAt: new Date() }).where(eq(companyNotificationWebhooks.id, hook.id));
        return error ? { ok: false, error } : { ok: true };
    } catch (e) {
        const error = e instanceof Error ? e.message : "Request failed";
        await db.update(companyNotificationWebhooks).set({ lastError: error.slice(0, 300), updatedAt: new Date() }).where(eq(companyNotificationWebhooks.id, hook.id));
        return { ok: false, error };
    }
}

// ─── Recipients ────────────────────────────────────────────────────────────

/** Owners and admins: who hears about approvals and incidents. */
export async function companyAdminIds(companyId: string): Promise<string[]> {
    const rows = await db.select({ userId: companyMembers.userId }).from(companyMembers)
        .where(and(eq(companyMembers.companyId, companyId), inArray(companyMembers.role, ["owner", "admin"])));
    return rows.map((r) => r.userId);
}

/** Company people an agent's text @mentions, by display name or email name. */
export async function mentionedHumanIds(companyId: string, text: string): Promise<string[]> {
    if (!text.includes("@")) return [];
    const people = await db.select({ id: users.id, displayName: users.displayName, email: users.email })
        .from(companyMembers)
        .innerJoin(users, eq(users.id, companyMembers.userId))
        .where(and(eq(companyMembers.companyId, companyId), isNull(users.deletedAt)));
    const roster = people.flatMap((p) => [
        ...(p.displayName ? [{ id: p.id, name: p.displayName }] : []),
        { id: p.id, name: p.email.split("@")[0] },
    ]);
    return [...mentionedAgentIds(text, roster)];
}

function threadLink(thread: { id: string; type: string }, agentId: string | null): string {
    if (thread.type === "group") return `/messages?group=${thread.id}`;
    if (thread.type === "direct" && agentId) return `/messages?agent=${agentId}`;
    return "/messages";
}

// ─── Triggers ──────────────────────────────────────────────────────────────

/**
 * An agent posted: tell people it @mentioned, and — when the message carries
 * a ```choices block — the people it is waiting on.
 */
export async function notifyAgentMessage(companyId: string, message: typeof threadMessages.$inferSelect): Promise<void> {
    try {
        if (message.senderType !== "agent") return;
        const text = message.text || "";
        const hasChoices = /^\s*(`{3,}|~{3,})\s*choices\b/im.test(text);
        if (!text.includes("@") && !hasChoices) return;

        const [thread] = await db.select({ id: messageThreads.id, type: messageThreads.type, title: messageThreads.title })
            .from(messageThreads).where(eq(messageThreads.id, message.threadId)).limit(1);
        if (!thread) return;
        const [agent] = message.senderId
            ? await db.select({ id: agents.id, name: agents.name }).from(agents).where(eq(agents.id, message.senderId)).limit(1)
            : [];
        const agentName = agent?.name ?? "An agent";
        const where = thread.type === "group" ? ` in ${thread.title || "a group"}` : thread.type === "team" ? " in team chat" : "";
        const link = threadLink(thread, agent?.id ?? null);

        const mentioned = await mentionedHumanIds(companyId, text);
        // A decision is the more specific signal: whoever it is for gets that
        // one notification, not a second "mentioned you" for the same message.
        const decisionFor = hasChoices ? (mentioned.length ? mentioned : await threadHumans(companyId, thread)) : [];
        const mentionOnly = mentioned.filter((id) => !decisionFor.includes(id));

        if (mentionOnly.length) {
            await notify(companyId, mentionOnly, {
                kind: "mention",
                title: `${agentName} mentioned you${where}`,
                body: text,
                link,
                sourceType: "message",
                sourceId: message.id,
                dedupeKey: `mention:${thread.id}`,
            });
        }
        if (decisionFor.length) {
            await notify(companyId, decisionFor, {
                kind: "decision",
                title: `${agentName} is waiting on your decision${where}`,
                body: text,
                link,
                sourceType: "message",
                sourceId: message.id,
                dedupeKey: `decision:${thread.id}`,
            });
        }
    } catch (error) {
        console.warn("[notifications] agent message:", error instanceof Error ? error.message : error);
    }
}

/** The people a thread's decision is for: group members, or who spoke last in a direct thread. */
async function threadHumans(companyId: string, thread: { id: string; type: string }): Promise<string[]> {
    if (thread.type === "group") {
        const rows = await db.select({ ref: threadParticipants.participantRef }).from(threadParticipants).where(and(
            eq(threadParticipants.companyId, companyId),
            eq(threadParticipants.threadId, thread.id),
            eq(threadParticipants.participantType, "human"),
            sql`${threadParticipants.role} <> 'reader'`,
        ));
        return rows.map((r) => r.ref).filter((r): r is string => Boolean(r));
    }
    if (thread.type === "direct") {
        const [last] = await db.select({ senderId: threadMessages.senderId }).from(threadMessages).where(and(
            eq(threadMessages.companyId, companyId),
            eq(threadMessages.threadId, thread.id),
            eq(threadMessages.senderType, "human"),
        )).orderBy(desc(threadMessages.createdAt)).limit(1);
        return last?.senderId ? [last.senderId] : [];
    }
    return [];
}

/** A runtime gave up on someone's message after its retries. */
export async function notifyRuntimeFailure(companyId: string, message: typeof threadMessages.$inferSelect, agentId: string): Promise<void> {
    if (!message.senderId || message.senderType !== "human") return;
    const [agent] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, agentId)).limit(1);
    const [thread] = await db.select({ id: messageThreads.id, type: messageThreads.type }).from(messageThreads).where(eq(messageThreads.id, message.threadId)).limit(1);
    await notify(companyId, [message.senderId], {
        kind: "agent_failed",
        title: `${agent?.name ?? "An agent"} couldn't process your message`,
        body: `It gave up after several attempts: "${clip(message.text, 160) ?? ""}". Send it again, or check the agent's health.`,
        link: thread ? threadLink(thread, agentId) : "/messages",
        sourceType: "message",
        sourceId: message.id,
        dedupeKey: `agent_failed:${message.id}`,
    });
}

export async function notifyApprovalRequested(companyId: string, approval: { id: string; rationale: string | null; requesterAgentId: string | null; actionType: string }): Promise<void> {
    try {
        const [agent] = approval.requesterAgentId
            ? await db.select({ name: agents.name }).from(agents).where(eq(agents.id, approval.requesterAgentId)).limit(1)
            : [];
        await notify(companyId, await companyAdminIds(companyId), {
            kind: "approval",
            title: `${agent?.name ?? "An agent"} requests approval`,
            body: approval.rationale || `Action: ${approval.actionType}`,
            link: "/approvals",
            sourceType: "approval",
            sourceId: approval.id,
            dedupeKey: `approval:${approval.id}`,
        });
    } catch (error) {
        console.warn("[notifications] approval:", error instanceof Error ? error.message : error);
    }
}

/** A task got a human assignee (a company member). */
export async function notifyTaskAssigned(companyId: string, task: { id: string; projectId: string; assignedMemberId: string | null; inputJson: unknown; taskType: string }, previousMemberId?: string | null): Promise<void> {
    try {
        if (!task.assignedMemberId || task.assignedMemberId === previousMemberId) return;
        const [member] = await db.select({ userId: companyMembers.userId }).from(companyMembers)
            .where(and(eq(companyMembers.id, task.assignedMemberId), eq(companyMembers.companyId, companyId))).limit(1);
        if (!member) return;
        const input = task.inputJson && typeof task.inputJson === "object" ? task.inputJson as Record<string, unknown> : {};
        const title = typeof input.title === "string" && input.title.trim() ? input.title.trim() : task.taskType;
        await notify(companyId, [member.userId], {
            kind: "task_assigned",
            title: `Task assigned to you: ${title}`,
            body: typeof input.description === "string" ? input.description : null,
            link: `/projects?project=${task.projectId}&task=${task.id}`,
            sourceType: "task",
            sourceId: task.id,
            dedupeKey: `task_assigned:${task.id}`,
        });
    } catch (error) {
        console.warn("[notifications] task assigned:", error instanceof Error ? error.message : error);
    }
}

const SERIOUS_SEVERITIES = new Set(["high", "critical"]);

export async function notifyIncident(companyId: string, incident: { id: string; severity: string; summary: string; reasonCode: string }): Promise<void> {
    try {
        if (!SERIOUS_SEVERITIES.has(incident.severity)) return;
        await notify(companyId, await companyAdminIds(companyId), {
            kind: "incident",
            title: `${incident.severity === "critical" ? "Critical" : "High"} incident: ${incident.reasonCode.replace(/_/g, " ")}`,
            body: incident.summary,
            link: "/",
            sourceType: "incident",
            sourceId: incident.id,
            dedupeKey: `incident:${incident.id}`,
        });
    } catch (error) {
        console.warn("[notifications] incident:", error instanceof Error ? error.message : error);
    }
}

/** An agent stopped sending heartbeats while it had work waiting. */
export async function notifyAgentDown(companyId: string, agent: { id: string; name: string }, pending: { openTasks: number; waitingMessages: number }): Promise<void> {
    try {
        const parts = [
            pending.waitingMessages ? `${pending.waitingMessages} message${pending.waitingMessages === 1 ? "" : "s"} waiting` : null,
            pending.openTasks ? `${pending.openTasks} open task${pending.openTasks === 1 ? "" : "s"}` : null,
        ].filter(Boolean);
        await notify(companyId, await companyAdminIds(companyId), {
            kind: "agent_down",
            title: `${agent.name} went offline with work waiting`,
            body: `${parts.join(" and ")}. Its runtime stopped checking in; restart it or reassign the work.`,
            link: "/agents/health",
            sourceType: "agent",
            sourceId: agent.id,
            dedupeKey: `agent_down:${agent.id}`,
        });
    } catch (error) {
        console.warn("[notifications] agent down:", error instanceof Error ? error.message : error);
    }
}
