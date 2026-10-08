import { and, count, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { companies, projects, scopedResources, tasks } from "@/db/schema";
import { SLA_TRACKED_TASK_STATES } from "@/lib/task-state";

/**
 * First-run setup: what kind of company this is (to suggest a team), a check
 * that the model key actually works before agents are started with it, and
 * the lead agent's first job — documenting the company in Knowledge & Rules.
 */

export { BUSINESS_TYPES, TEAM_TEMPLATES, planTeam } from "@/lib/onboarding-shared";

export type KeyCheck = { ok: true; detail: string | null } | { ok: false; error: string } | { ok: null; error: string };

/**
 * Ask the provider whether the key is valid. A network failure is "unknown"
 * (ok: null), never a hard stop: the operator may be offline from here but
 * not from the agent's container.
 */
export async function validateLlmKey(provider: string, apiKey: string): Promise<KeyCheck> {
    const key = apiKey.trim();
    if (!key) return { ok: false, error: "Enter your API key." };
    const endpoints: Record<string, string> = {
        openrouter: "https://openrouter.ai/api/v1/auth/key",
        deepseek: "https://api.deepseek.com/user/balance",
    };
    const url = endpoints[provider];
    if (!url) return { ok: null, error: "This provider's key can't be checked here; it will be tried when the agent starts." };
    try {
        const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000), redirect: "error" });
        if (res.status === 401 || res.status === 403) return { ok: false, error: "The provider rejected this key. Check that you copied all of it." };
        if (!res.ok) return { ok: null, error: `The provider answered HTTP ${res.status}; you can continue and the agent will retry.` };
        const data = await res.json().catch(() => null) as { data?: { label?: string; limit_remaining?: number | null; is_free_tier?: boolean } } | null;
        const label = data?.data?.label;
        return { ok: true, detail: label ? `Key "${label}" works.` : "Key works." };
    } catch {
        return { ok: null, error: "Couldn't reach the provider from this server to check the key. You can continue; the agent will use it directly." };
    }
}

export const DOCUMENT_TASK_KIND = "document_company";

type DocumentInput = { companyId: string; agentId: string; website: string | null };

function documentationPrompt(input: { companyName: string; taskId: string; website: string | null }) {
    return [
        `**Welcome to ${input.companyName}.** Your first job: document the company so every agent works from the same facts.`,
        "",
        `Tracked as [Document ${input.companyName} in Knowledge & Rules](emperor://task/${input.taskId}).`,
        "",
        "1. Read the company profile in your instructions (what we do, type of business, house rules).",
        input.website
            ? `2. Read the website (${input.website}) if your tools allow it: products or services, customers, pricing, tone.`
            : "2. There is no website on file; work from the profile.",
        "3. Rewrite the starter notes in Knowledge & Rules with real content: **company-overview** (what we do, for whom, what makes us different) and **brand-voice** (how we write). Add **products-and-services** and **customers-and-market** notes under Company. Keep each short and factual; mark anything you inferred as an assumption.",
        "4. Ask the owner here, in this chat, for the three most important facts you could not find (one message, numbered questions).",
        "5. Reply here with a short summary listing the notes you created or updated, then set the task done.",
        "",
        "Move the task to in_progress when you start. Don't invent prices, numbers, or promises.",
    ].join("\n");
}

/** Start (or return) the lead agent's documentation task. Idempotent per company. */
export async function startCompanyDocumentation(input: DocumentInput): Promise<{ taskId: string; created: boolean }> {
    const [existing] = await db.select({ id: tasks.id }).from(tasks).where(and(
        eq(tasks.companyId, input.companyId), isNull(tasks.deletedAt),
        sql`${tasks.inputJson}->>'onboarding' = ${DOCUMENT_TASK_KIND}`,
        sql`${tasks.state} IN (${sql.join(SLA_TRACKED_TASK_STATES.map((s) => sql`${s}`), sql`, `)})`,
    )).limit(1);
    if (existing) return { taskId: existing.id, created: false };

    const [company] = await db.select({ name: companies.name }).from(companies).where(eq(companies.id, input.companyId)).limit(1);
    const companyName = company?.name ?? "your company";

    const projectId = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`onboarding-project:${input.companyId}`}))`);
        const [project] = await tx.select({ id: projects.id }).from(projects)
            .where(and(eq(projects.companyId, input.companyId), eq(projects.goal, "Getting started"), isNull(projects.deletedAt))).limit(1);
        if (project) return project.id;
        const [created] = await tx.insert(projects).values({ companyId: input.companyId, goal: "Getting started", status: "active" }).returning({ id: projects.id });
        return created.id;
    });

    const { createTaskForProject } = await import("@/lib/openclaw/tasks");
    const { task } = await createTaskForProject({
        companyId: input.companyId,
        projectId,
        taskType: "documentation",
        priority: 2,
        assignedAgentId: input.agentId,
        inputJson: {
            title: `Document ${companyName} in Knowledge & Rules`,
            goal: "Turn the company profile (and website, if any) into short, factual Knowledge & Rules notes every agent can rely on.",
            acceptanceCriteria: [
                "company-overview and brand-voice notes have real content instead of the starter placeholders",
                "products-and-services and customers-and-market notes exist under Company",
                "open questions were asked to the owner in the agent's direct chat",
            ],
            onboarding: DOCUMENT_TASK_KIND,
        },
        actorType: "system",
        source: "onboarding",
        // This flow posts its own targeted brief below; skip the generic wake.
        wake: false,
    });

    const { appendThreadMessage, ensureDirectThread } = await import("@/lib/control-plane");
    const thread = await ensureDirectThread(input.companyId, input.agentId, null);
    await appendThreadMessage({
        companyId: input.companyId,
        threadId: thread.id,
        senderType: "system",
        targetAgentId: input.agentId,
        text: documentationPrompt({ companyName, taskId: task.id, website: input.website }),
        deliveryState: "queued",
        metadataJson: { onboarding: DOCUMENT_TASK_KIND, taskId: task.id },
    });
    return { taskId: task.id, created: true };
}

/** Progress for the wizard: task state and how many notes the agent has written. */
export async function documentationProgress(companyId: string, taskId: string) {
    const [task] = await db.select({ id: tasks.id, state: tasks.state, createdAt: tasks.createdAt, projectId: tasks.projectId, assignedAgentId: tasks.assignedAgentId })
        .from(tasks).where(and(eq(tasks.companyId, companyId), eq(tasks.id, taskId))).limit(1);
    if (!task) return null;
    const notes = await db.select({ name: scopedResources.name, displayName: scopedResources.displayName, updatedAt: scopedResources.updatedAt })
        .from(scopedResources)
        .where(and(
            eq(scopedResources.companyId, companyId),
            eq(scopedResources.resourceType, "knowledge_base"),
            isNull(scopedResources.deletedAt),
            gte(scopedResources.updatedAt, task.createdAt),
        ))
        .orderBy(desc(scopedResources.updatedAt)).limit(20);
    const [{ value: total }] = await db.select({ value: count() }).from(scopedResources)
        .where(and(eq(scopedResources.companyId, companyId), eq(scopedResources.resourceType, "knowledge_base"), isNull(scopedResources.deletedAt)));
    return {
        taskId: task.id,
        state: task.state,
        agentId: task.assignedAgentId,
        taskUrl: `/projects?project=${task.projectId}&task=${task.id}`,
        notesTouched: notes.map((n) => n.displayName || n.name),
        totalNotes: Number(total) || 0,
    };
}
