import { and, count, desc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { agents, companies, projects, scopedResources, tasks, users } from "@/db/schema";
import { SLA_TRACKED_TASK_STATES } from "@/lib/task-state";
import { CUSTOM_LLM_PROVIDER, normalizeLlmBaseUrl } from "@/lib/llm-endpoint";
import { checkLlmEndpointHost, pinnedGet, type LookupAll } from "@/lib/llm-endpoint-policy";

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
export async function validateLlmKey(provider: string, apiKey: string, options: { baseUrl?: string; model?: string } = {}): Promise<KeyCheck> {
    const key = apiKey.trim();
    if (provider === CUSTOM_LLM_PROVIDER) return validateCustomEndpoint(options.baseUrl, key, options.model);
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
        if (!res.ok) return { ok: null, error: "The provider couldn't confirm this key right now; you can continue and the agent will retry." };
        const data = await res.json().catch(() => null) as { data?: { label?: string; limit_remaining?: number | null; is_free_tier?: boolean } } | null;
        const label = data?.data?.label;
        return { ok: true, detail: label ? `Key "${label}" works.` : "Key works." };
    } catch {
        return { ok: null, error: "Couldn't reach the provider from this server to check the key. You can continue; the agent will use it directly." };
    }
}

const CUSTOM_ENDPOINT_TIMEOUT_MS = 5000;

/**
 * Check a custom OpenAI-compatible endpoint: GET {baseUrl}/models with the key
 * (when there is one). The host must pass the endpoint policy
 * (src/lib/llm-endpoint-policy.ts) and the request connects to the address
 * that was checked. The answer is one of four outcomes, never the upstream
 * status or body: works, key rejected, not an OpenAI-compatible endpoint, or
 * unreachable from this server ("unknown", not a stop: the agent's container
 * may see hosts this server does not, such as host.docker.internal).
 */
export async function validateCustomEndpoint(rawBaseUrl: string | undefined, key: string, model?: string, deps: { lookup?: LookupAll } = {}): Promise<KeyCheck> {
    const checked = normalizeLlmBaseUrl(rawBaseUrl);
    if (!checked.ok) return { ok: false, error: checked.error };
    const hint = checked.hint ? ` ${checked.hint}` : "";
    const unreachable: KeyCheck = { ok: null, error: `Couldn't reach the endpoint from this server. You can continue; the agent's container connects to it directly.${hint}` };
    const target = await checkLlmEndpointHost(checked.url, { lookup: deps.lookup });
    if (!target.ok) return target.reason === "blocked" ? { ok: false, error: target.error } : unreachable;
    let res: { status: number; body: string };
    try {
        res = await pinnedGet(`${checked.url}/models`, target.addresses[0], key ? { Authorization: `Bearer ${key}` } : {}, CUSTOM_ENDPOINT_TIMEOUT_MS);
    } catch {
        return unreachable;
    }
    if (res.status === 401 || res.status === 403) return { ok: false, error: key ? "The endpoint rejected this key." : "The endpoint needs an API key." };
    let data: { data?: unknown } | null = null;
    if (res.status >= 200 && res.status < 300) {
        try { data = JSON.parse(res.body) as { data?: unknown }; } catch { data = null; }
    }
    if (!data || !Array.isArray(data.data)) {
        return { ok: null, error: "This doesn't look like an OpenAI-compatible endpoint (no model list at /models). Check the base URL; it usually ends in /v1." };
    }
    const ids = (data.data as { id?: unknown }[]).map((m) => (typeof m?.id === "string" ? m.id : "")).filter(Boolean);
    const wanted = model?.trim();
    if (wanted && ids.length && !ids.includes(wanted)) {
        return { ok: null, error: `The endpoint answered, but it doesn't list "${wanted.slice(0, 80)}". Check the model name; you can continue anyway.` };
    }
    return { ok: true, detail: "Endpoint works." };
}

/**
 * A team this old was not created by a launch still in progress.
 *
 * The setup wizard stays open until the person finishes or skips it, because
 * the launch step saves each agent before its runtime exists (hiding the
 * wizard as soon as an agent row appeared cut off the launch progress, its
 * errors and retries, and the lead's first job). Workspaces set up before
 * that rule have agents but no onboarding state on the user. They are settled
 * lazily instead of by a migration: the first time the dashboard computes the
 * wizard for an owner or admin of a company with a profile and an agent older
 * than this, that user's onboarding is marked completed, once. The same rule
 * covers an admin invited later to an established workspace.
 */
export const ESTABLISHED_TEAM_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * True (after recording it) when `userId`'s onboarding is settled by an
 * established team: the company has a live agent created more than
 * ESTABLISHED_TEAM_AGE_MS ago. Only writes when the user has no onboarding
 * state yet, so it never overrides a dismissal or a completion time.
 */
export async function settleOnboardingForEstablishedTeam(userId: string, companyId: string, now: Date = new Date()): Promise<boolean> {
    const [established] = await db.select({ id: agents.id }).from(agents).where(and(
        eq(agents.companyId, companyId),
        isNull(agents.deletedAt),
        lt(agents.createdAt, new Date(now.getTime() - ESTABLISHED_TEAM_AGE_MS)),
    )).limit(1);
    if (!established) return false;
    await db.update(users).set({ onboardingCompletedAt: now })
        .where(and(eq(users.id, userId), isNull(users.onboardingCompletedAt), isNull(users.onboardingDismissedAt)));
    return true;
}

export const DOCUMENT_TASK_KIND = "document_company";

// userId: who asked; in private direct-chat mode the brief lands in their own chat with the agent.
type DocumentInput = { companyId: string; agentId: string; website: string | null; userId?: string | null };

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
    const thread = await ensureDirectThread(input.companyId, input.agentId, input.userId ?? null);
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
