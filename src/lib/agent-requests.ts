import { createHmac, randomUUID } from "crypto";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, ne, notInArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentRequests, agents, approvalTaskLinks, approvals, companyTokens, projects, tasks, threadMessages } from "@/db/schema";
import { getAppUrl } from "@/lib/env";
import { canManageSecrets, decryptSecretPayload, encryptSecretPayload } from "@/lib/secrets";
import { TASK_STATES } from "@/lib/task-state";

/**
 * Requests: an external platform (a customer's web app with a "send task to
 * agent" button) hands work to one agent. Each request becomes a task assigned
 * to the agent plus a system message in its direct chat, attributed to the
 * source ("Acme Portal (via API)") rather than to a person, so nobody in the
 * company is impersonated. The platform reads the request back for status and
 * result, or receives signed callbacks when its status changes.
 */

export const REQUEST_STATUSES = ["queued", "in_progress", "waiting_approval", "in_review", "done", "failed", "cancelled"] as const;
export type RequestStatus = typeof REQUEST_STATUSES[number];
const FINAL_STATUSES: RequestStatus[] = ["done", "failed", "cancelled"];

export const MAX_PROMPT_LENGTH = 20_000;
const MAX_FIELD = 200;
const MAX_REPLY_LENGTH = 8_000;

export class AgentRequestError extends Error {
    constructor(message: string, readonly status: number) {
        super(message);
    }
}

function clean(value: unknown, max = MAX_FIELD): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, max) : null;
}

/** First line of the prompt, as a task title. */
export function titleFromPrompt(prompt: string): string {
    const line = prompt.split("\n").map((l) => l.replace(/^#+\s*/, "").trim()).find(Boolean) ?? "Request";
    return line.length > 90 ? `${line.slice(0, 87)}...` : line;
}

/** The chat message the agent receives. Plain enough for any runtime. */
export function requestMessage(input: { source: string; requestedBy: string | null; externalRef: string | null; prompt: string; taskId: string; title: string }): string {
    const from = [
        `**Request from ${input.source}** (via API${input.requestedBy ? `, on behalf of ${input.requestedBy}` : ""}${input.externalRef ? ` · ref ${input.externalRef}` : ""})`,
    ];
    return [
        ...from,
        "",
        input.prompt.trim(),
        "",
        "---",
        `Tracked as [${input.title.replace(/[[\]]/g, "")}](emperor://task/${input.taskId}). ${input.source} sees this task's state and your replies here.`,
        "Work it like any request: move the task to in progress, reply here with the result (or one concrete question if something is missing), and set the task done when it is finished. Request an approval before spending, sending anything outside the company, publishing, or deleting.",
    ].join("\n");
}

/** Where a source's requests land when no project is given: one project per source. */
async function projectForSource(companyId: string, source: string): Promise<string> {
    const goal = `Requests from ${source}`;
    return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`request-project:${companyId}:${goal}`}))`);
        const [existing] = await tx.select({ id: projects.id }).from(projects)
            .where(and(eq(projects.companyId, companyId), eq(projects.goal, goal), isNull(projects.deletedAt), ne(projects.status, "killed")))
            .orderBy(asc(projects.createdAt)).limit(1);
        if (existing) return existing.id;
        const [created] = await tx.insert(projects).values({ id: randomUUID(), companyId, goal, status: "active" }).returning({ id: projects.id });
        return created.id;
    });
}

async function resolveRequestAgent(companyId: string, ref: string) {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref);
    const rows = await db.select({ id: agents.id, name: agents.name }).from(agents).where(and(
        eq(agents.companyId, companyId), isNull(agents.deletedAt),
        isUuid ? or(eq(agents.id, ref), eq(agents.name, ref)) : sql`lower(${agents.name}) = lower(${ref})`,
    )).limit(2);
    if (rows.length === 0) throw new AgentRequestError(`Agent not found: ${ref}`, 404);
    if (rows.length > 1 && !isUuid) throw new AgentRequestError(`More than one agent is called ${ref}; use its id`, 409);
    return rows[0];
}

export type CreateAgentRequestInput = {
    companyId: string;
    tokenId: string | null;
    source: string;
    agent: string;
    prompt: unknown;
    title?: unknown;
    requestedBy?: unknown;
    externalRef?: unknown;
    idempotencyKey?: unknown;
    projectId?: unknown;
    priority?: unknown;
};

/**
 * Create a request: claim the idempotency key first, so a double click or a
 * retried HTTP call returns the same request instead of creating a second task.
 */
export async function createAgentRequest(input: CreateAgentRequestInput): Promise<{ request: AgentRequestView; created: boolean }> {
    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    if (!prompt) throw new AgentRequestError("prompt is required", 400);
    if (prompt.length > MAX_PROMPT_LENGTH) throw new AgentRequestError(`prompt is longer than ${MAX_PROMPT_LENGTH} characters`, 400);
    const source = clean(input.source, 80);
    if (!source) throw new AgentRequestError("source is required", 400);
    const agent = await resolveRequestAgent(input.companyId, String(input.agent ?? "").trim());
    const idempotencyKey = clean(input.idempotencyKey);
    const requestedBy = clean(input.requestedBy);
    const externalRef = clean(input.externalRef);
    const title = clean(input.title, 120) ?? titleFromPrompt(prompt);

    let projectId: string;
    const requestedProject = clean(input.projectId);
    if (requestedProject) {
        const [project] = await db.select({ id: projects.id }).from(projects)
            .where(and(eq(projects.id, requestedProject), eq(projects.companyId, input.companyId), isNull(projects.deletedAt))).limit(1)
            .catch(() => []);
        if (!project) throw new AgentRequestError("Project not found", 404);
        projectId = project.id;
    } else {
        projectId = await projectForSource(input.companyId, source);
    }

    const id = randomUUID();
    const [claimed] = await db.insert(agentRequests).values({
        id, companyId: input.companyId, tokenId: input.tokenId, agentId: agent.id,
        source, requestedBy, externalRef, idempotencyKey, prompt,
    }).onConflictDoNothing().returning({ id: agentRequests.id });
    if (!claimed) {
        const [existing] = await db.select({ id: agentRequests.id }).from(agentRequests).where(and(
            eq(agentRequests.companyId, input.companyId), eq(agentRequests.source, source), eq(agentRequests.idempotencyKey, idempotencyKey!),
        )).limit(1);
        return { request: (await getAgentRequest(input.companyId, existing.id))!, created: false };
    }

    try {
        const { createTaskForProject } = await import("@/lib/openclaw/tasks");
        const { task } = await createTaskForProject({
            companyId: input.companyId,
            projectId,
            taskType: "request",
            priority: typeof input.priority === "number" && Number.isFinite(input.priority) ? Math.round(input.priority) : 0,
            assignedAgentId: agent.id,
            inputJson: {
                title,
                goal: prompt,
                request: { id, source, requestedBy, externalRef },
            },
            actorType: "system",
            source: "agent_request",
        });

        const { appendThreadMessage, ensureDirectThread } = await import("@/lib/control-plane");
        const thread = await ensureDirectThread(input.companyId, agent.id, null);
        const message = await appendThreadMessage({
            companyId: input.companyId,
            threadId: thread.id,
            senderType: "system",
            targetAgentId: agent.id,
            text: requestMessage({ source, requestedBy, externalRef, prompt, taskId: task.id, title }),
            // Queued like a person's message, so the runtime picks it up and
            // reports acting/resolved on it.
            deliveryState: "queued",
            metadataJson: {
                agentRequest: { id, source, requestedBy, externalRef, taskId: task.id },
                senderName: `${source} (via API)`,
            },
        });

        await db.update(agentRequests).set({ taskId: task.id, threadId: thread.id, messageId: message.id, updatedAt: new Date() })
            .where(eq(agentRequests.id, id));
    } catch (error) {
        // Never leave a half-made request holding the idempotency key.
        await db.delete(agentRequests).where(eq(agentRequests.id, id));
        throw error;
    }

    return { request: (await getAgentRequest(input.companyId, id))!, created: true };
}

export type AgentRequestView = {
    id: string;
    status: RequestStatus;
    source: string;
    requestedBy: string | null;
    externalRef: string | null;
    prompt: string;
    agent: { id: string; name: string } | null;
    task: { id: string; title: string; state: string; url: string } | null;
    chatUrl: string | null;
    result: { reply: string | null; output: unknown };
    replies: { id: string; text: string; createdAt: string }[];
    error: string | null;
    createdAt: string;
    updatedAt: string;
};

type Row = typeof agentRequests.$inferSelect;

/** What the platform sees: one status, derived from the task and the message. */
export function deriveRequestStatus(input: {
    taskState: string | null;
    taskDeleted: boolean;
    messageState: string | null;
    pendingApproval: boolean;
    runtimeFailed: boolean;
}): RequestStatus {
    if (!input.taskState || input.taskDeleted) return "cancelled";
    switch (input.taskState) {
        case TASK_STATES.done: return "done";
        case TASK_STATES.failed:
        case TASK_STATES.deadLetter: return "failed";
        case TASK_STATES.review: return input.pendingApproval ? "waiting_approval" : "in_review";
        case TASK_STATES.inProgress: return "in_progress";
    }
    // Still in the inbox: the message tells whether the agent has started.
    if (input.messageState === "cancelled") return input.runtimeFailed ? "failed" : "cancelled";
    if (input.messageState && input.messageState !== "queued") return "in_progress";
    return "queued";
}

async function viewsFor(rows: Row[]): Promise<AgentRequestView[]> {
    if (rows.length === 0) return [];
    const companyId = rows[0].companyId;
    const taskIds = rows.map((r) => r.taskId).filter((v): v is string => Boolean(v));
    const messageIds = rows.map((r) => r.messageId).filter((v): v is string => Boolean(v));
    const agentIds = [...new Set(rows.map((r) => r.agentId).filter((v): v is string => Boolean(v)))];

    const [taskRows, messageRows, agentRows] = await Promise.all([
        taskIds.length ? db.select({ id: tasks.id, state: tasks.state, inputJson: tasks.inputJson, outputJson: tasks.outputJson, projectId: tasks.projectId, deletedAt: tasks.deletedAt })
            .from(tasks).where(and(eq(tasks.companyId, companyId), inArray(tasks.id, taskIds))) : [],
        messageIds.length ? db.select({ id: threadMessages.id, threadId: threadMessages.threadId, deliveryState: threadMessages.deliveryState, metadataJson: threadMessages.metadataJson, createdAt: threadMessages.createdAt })
            .from(threadMessages).where(and(eq(threadMessages.companyId, companyId), inArray(threadMessages.id, messageIds))) : [],
        agentIds.length ? db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, agentIds)) : [],
    ]);
    const taskById = new Map(taskRows.map((t) => [t.id, t]));
    const messageById = new Map(messageRows.map((m) => [m.id, m]));
    const agentById = new Map(agentRows.map((a) => [a.id, a]));

    const pendingRows = taskIds.length ? await db.select({ taskId: approvalTaskLinks.taskId }).from(approvalTaskLinks)
        .innerJoin(approvals, eq(approvals.id, approvalTaskLinks.approvalId))
        .where(and(eq(approvalTaskLinks.companyId, companyId), eq(approvals.status, "pending"), inArray(approvalTaskLinks.taskId, taskIds))) : [];
    const pending = new Set(pendingRows.map((r) => r.taskId));

    const base = getAppUrl();
    const views: AgentRequestView[] = [];
    for (const row of rows) {
        const task = row.taskId ? taskById.get(row.taskId) : undefined;
        const message = row.messageId ? messageById.get(row.messageId) : undefined;
        const metadata = (message?.metadataJson ?? {}) as Record<string, unknown>;
        const replies = message && row.agentId ? await repliesTo(companyId, message, row.agentId) : [];
        const input = (task?.inputJson ?? {}) as Record<string, unknown>;
        const runtimeFailure = metadata.runtimeFailure as { reason?: string } | undefined;
        views.push({
            id: row.id,
            status: deriveRequestStatus({
                taskState: task?.state ?? null,
                taskDeleted: Boolean(task?.deletedAt),
                messageState: message?.deliveryState ?? null,
                pendingApproval: task ? pending.has(task.id) : false,
                runtimeFailed: Boolean(runtimeFailure),
            }),
            source: row.source,
            requestedBy: row.requestedBy,
            externalRef: row.externalRef,
            prompt: row.prompt,
            agent: row.agentId && agentById.get(row.agentId) ? { id: row.agentId, name: agentById.get(row.agentId)!.name } : null,
            task: task ? {
                id: task.id,
                title: typeof input.title === "string" ? input.title : "Request",
                state: task.state,
                url: `${base}/projects?project=${task.projectId}&task=${task.id}`,
            } : null,
            chatUrl: row.agentId ? `${base}/messages?agent=${row.agentId}` : null,
            result: { reply: replies.at(-1)?.text ?? null, output: task?.outputJson ?? null },
            replies,
            error: runtimeFailure ? (runtimeFailure.reason || "The agent's runtime could not process this request") : null,
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
        });
    }
    return views;
}

/**
 * The agent's replies to this request. Replies that name it (runtimes send
 * replyToMessageId) are exact; otherwise, the agent's messages after the
 * request and before the next message addressed to it in that chat.
 */
async function repliesTo(companyId: string, message: { id: string; threadId: string; createdAt: Date }, agentId: string) {
    const later = await db.select({ id: threadMessages.id, senderType: threadMessages.senderType, senderId: threadMessages.senderId, text: threadMessages.text, metadataJson: threadMessages.metadataJson, createdAt: threadMessages.createdAt })
        .from(threadMessages)
        .where(and(eq(threadMessages.companyId, companyId), eq(threadMessages.threadId, message.threadId), gt(threadMessages.createdAt, message.createdAt)))
        .orderBy(asc(threadMessages.createdAt)).limit(60);
    const fromAgent = later.filter((m) => m.senderType === "agent" && m.senderId === agentId);
    const exact = fromAgent.filter((m) => (m.metadataJson as Record<string, unknown>)?.replyToMessageId === message.id);
    let picked = exact;
    if (picked.length === 0) {
        picked = [];
        for (const m of later) {
            const linked = (m.metadataJson as Record<string, unknown>)?.replyToMessageId;
            if (m.senderType !== "agent") break; // the next prompt in the chat starts another exchange
            if (m.senderId === agentId && !linked) picked.push(m);
        }
    }
    return picked.slice(-5).map((m) => ({
        id: m.id,
        text: m.text.length > MAX_REPLY_LENGTH ? `${m.text.slice(0, MAX_REPLY_LENGTH)}…` : m.text,
        createdAt: m.createdAt.toISOString(),
    }));
}

/** One request; a requests token only sees the requests it created. */
export async function getAgentRequest(companyId: string, id: string, tokenId?: string | null): Promise<AgentRequestView | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const [row] = await db.select().from(agentRequests).where(and(
        eq(agentRequests.companyId, companyId), eq(agentRequests.id, id),
        tokenId ? eq(agentRequests.tokenId, tokenId) : undefined,
    )).limit(1);
    if (!row) return null;
    return (await viewsFor([row]))[0];
}

export async function listAgentRequests(companyId: string, options: { tokenId?: string | null; externalRef?: string | null; agentId?: string | null; status?: string | null; limit?: number } = {}) {
    const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
    const rows = await db.select().from(agentRequests).where(and(
        eq(agentRequests.companyId, companyId),
        options.tokenId ? eq(agentRequests.tokenId, options.tokenId) : undefined,
        options.externalRef ? eq(agentRequests.externalRef, options.externalRef) : undefined,
        options.agentId ? eq(agentRequests.agentId, options.agentId) : undefined,
    )).orderBy(desc(agentRequests.createdAt)).limit(options.status ? 100 : limit);
    const views = await viewsFor(rows);
    return (options.status ? views.filter((v) => v.status === options.status) : views).slice(0, limit);
}

// ── Callbacks ────────────────────────────────────────────────────────────────

/**
 * Signature over `${timestamp}.${body}`. The key is the SHA-256 hex of the
 * caller's own token, which the server stores and the caller can compute, so
 * no second secret has to be handed out.
 */
export function signCallback(tokenHash: string, timestamp: string, body: string): string {
    return `sha256=${createHmac("sha256", tokenHash).update(`${timestamp}.${body}`).digest("hex")}`;
}

const MAX_CALLBACK_ATTEMPTS = 8;

function backoffMs(attempts: number) {
    return Math.min(30_000 * 2 ** Math.max(attempts - 1, 0), 60 * 60_000);
}

/**
 * Post a callback for every request whose status changed since the last one
 * delivered. Runs in the lifecycle loop; failures retry with backoff and stop
 * after MAX_CALLBACK_ATTEMPTS for the same status (the platform can still
 * read the request).
 */
export async function deliverRequestCallbacks(now = new Date()): Promise<number> {
    const candidates = await db.select({ request: agentRequests, tokenHash: companyTokens.tokenHash, callback: companyTokens.callbackUrlEncrypted })
        .from(agentRequests)
        .innerJoin(companyTokens, eq(companyTokens.id, agentRequests.tokenId))
        .where(and(
            isNotNull(companyTokens.callbackUrlEncrypted),
            isNull(companyTokens.revokedAt),
            isNotNull(agentRequests.taskId),
            or(isNull(agentRequests.notifiedStatus), notInArray(agentRequests.notifiedStatus, FINAL_STATUSES)),
            lt(agentRequests.callbackAttempts, MAX_CALLBACK_ATTEMPTS),
            gt(agentRequests.createdAt, new Date(now.getTime() - 30 * 24 * 60 * 60_000)),
        ))
        .orderBy(asc(agentRequests.updatedAt))
        .limit(50);
    if (candidates.length === 0) return 0;

    let delivered = 0;
    for (const { request, tokenHash, callback } of candidates) {
        if (request.callbackAttempts > 0 && now.getTime() - request.updatedAt.getTime() < backoffMs(request.callbackAttempts)) continue;
        const view = (await viewsFor([request]))[0];
        if (view.status === request.notifiedStatus) continue;

        let url: string | null = null;
        try {
            url = (decryptSecretPayload(callback!) as { url?: string } | null)?.url ?? null;
        } catch {
            url = null;
        }
        if (!url) {
            await db.update(agentRequests).set({ callbackAttempts: MAX_CALLBACK_ATTEMPTS, callbackLastError: "Callback URL can't be decrypted (check EMPEROR_CLAW_MASTER_KEY)", updatedAt: now }).where(eq(agentRequests.id, request.id));
            continue;
        }

        const body = JSON.stringify({ event: "agent_request.updated", request: view });
        const timestamp = String(Math.floor(now.getTime() / 1000));
        let error: string | null = null;
        try {
            const res = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "User-Agent": "EmperorClaw-Requests/1",
                    "X-Emperor-Event": "agent_request.updated",
                    "X-Emperor-Request-Id": view.id,
                    "X-Emperor-Timestamp": timestamp,
                    "X-Emperor-Signature": signCallback(tokenHash, timestamp, body),
                },
                body,
                signal: AbortSignal.timeout(8000),
                redirect: "error",
            });
            if (!res.ok) error = `HTTP ${res.status}`;
        } catch (e) {
            error = e instanceof Error ? e.message.slice(0, 200) : "Callback failed";
        }

        if (error) {
            await db.update(agentRequests).set({ callbackAttempts: request.callbackAttempts + 1, callbackLastError: error, updatedAt: now }).where(eq(agentRequests.id, request.id));
        } else {
            delivered += 1;
            await db.update(agentRequests).set({ notifiedStatus: view.status, callbackAttempts: 0, callbackLastError: null, updatedAt: now }).where(eq(agentRequests.id, request.id));
        }
    }
    return delivered;
}

/**
 * Validate and encrypt a callback URL for a requests token. https only (plain
 * http just for localhost); the URL is a credential, so only a hint is shown.
 */
export function prepareCallbackUrl(raw: unknown): { encrypted: string; hint: string } | { error: string } {
    if (typeof raw !== "string" || !raw.trim()) return { error: "A callback URL is required" };
    if (!canManageSecrets()) return { error: "Set EMPEROR_CLAW_MASTER_KEY to store a callback URL: it is a credential and is kept encrypted." };
    let url: URL;
    try {
        url = new URL(raw.trim());
    } catch {
        return { error: "That isn't a valid URL" };
    }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
        return { error: "Callback URLs must use https" };
    }
    return { encrypted: encryptSecretPayload({ url: url.toString() })!.encryptedSecret, hint: `${url.protocol}//${url.hostname}/…${url.pathname.slice(-4)}` };
}

export { requestSourceLabel } from "@/lib/request-label";
