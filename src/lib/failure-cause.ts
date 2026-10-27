/**
 * Failure copy per cause (roadmap 11.6): every failure the inbox, the task
 * page and the agent's "Right now" card show reads as ONE plain cause and ONE
 * fix, never a bare "failed".
 *
 * Pure and client-safe. The inputs are the raw strings Emperor already
 * stores: agent_runs.error and exit_reason (the Hermes bridge writes a short
 * classification such as `provider_credits_exhausted: HTTP 402`,
 * `idle_timeout`, `runtime_restart`, `not_admitted: GatewayUnavailable`),
 * threadMessages.metadataJson.runtimeFailure.reason (the bridge's
 * `LLM provider out of credits (HTTP 402): ...` or its error code), and the
 * provider error text Hermes passes through (`Error code: 402 - {...}`).
 * Unit-tested from those real strings in tests/unit/failure-cause.test.ts.
 *
 * Classification reads the raw text; anything shown (the unknown cause's
 * detail) is redacted first with the same redactor the live feed and the run
 * ledger use, because a provider error can quote a key, a bearer token or a
 * signed URL back.
 */
import { redactSensitive } from "@/lib/redact-sensitive";

export type FailureCause =
    | "provider_credits"
    | "provider_auth"
    | "rate_limited"
    | "model_unavailable"
    | "budget"
    | "runtime_offline"
    | "stalled"
    | "scope_denied"
    | "unknown";

/** Who is looking: viewers see the cause only; owners and admins also get the admin-only fixes. */
export type FixAudience = "admin" | "member" | "viewer";

export function fixAudience(input: { canAct: boolean; isOwnerOrAdmin: boolean }): FixAudience {
    if (!input.canAct) return "viewer";
    return input.isOwnerOrAdmin ? "admin" : "member";
}

export type FixAction =
    | { kind: "link"; href: string }
    /** POST /api/chat/messages/:id (only the sender may retry their message). */
    | { kind: "retry_message"; messageId: string }
    /** POST /api/chat to the agent: a task directive asking it to continue ("nudge") or try again ("retry"). */
    | { kind: "message_agent"; agentId: string; taskId: string | null; mode: "nudge" | "retry" }
    /** POST /api/agents/:id/recreate-runtime (local Hermes agents only). */
    | { kind: "restart_runtime"; agentId: string };

export interface FailureFix {
    label: string;
    action: FixAction;
    /** Rate limits: the fix is offered but held until this instant (ISO). */
    notBefore?: string | null;
}

export interface FailureView {
    cause: FailureCause;
    /** The one plain cause line. */
    headline: string;
    /** The short raw error, only when the cause is unknown (otherwise the headline says it all). */
    detail: string | null;
    /** Null for viewers, and when nothing the viewer may do would help. */
    fix: FailureFix | null;
}

/** Where provider API keys live: the agent runtime, not Emperor (docs: "Where do API keys go?"). */
export const PROVIDER_KEY_DOC_HREF = "/docs/v1.1/troubleshooting";
/** Rate limits: wait this long after the failure before Retry is enabled. */
export const RATE_LIMIT_RETRY_DELAY_MS = 60_000;

const DETAIL_MAX = 90;

// Same classification as the bridge's ledger.is_credits_failure and
// agent-health providerIssueFromReason, plus the providers' own wording.
const CREDITS_RE = /insufficient[ _](?:credits|balance|funds|quota)|out of credits|credits? (?:are |is )?exhausted|credits_exhausted|billing or credits|credit balance is too low|requires more credits|exceeded your current quota|payment required|\bHTTP 402\b|error code: 402\b|status(?:=| |: ?)402\b|\b402 (?:payment|-)/i;
const AUTH_RE = /invalid[ _-]?(?:x-)?api[ _-]?key|incorrect api key|api key not valid|no auth credentials|authentication[ _]?(?:error|failed)|unauthori[sz]ed|\b(?:HTTP|error code:?|status(?:=| |: ?))\s*40[13]\b|permission[ _]denied.*key|\bkey (?:revoked|expired)/i;
const MODEL_RE = /model[ _]not[ _]found|unknown model|unsupported model|model .{0,80}(?:does not exist|not found|is not (?:supported|available))|not a valid model|no endpoints found|invalid model|model pricing required/i;
const RATE_RE = /rate[ _-]?limit|too many requests|\b(?:HTTP|error code:?|status(?:=| |: ?))\s*429\b|ratelimiterror|overloaded/i;
const BUDGET_RE = /budget (?:exhausted|exceeded|unavailable|check denied|limit)|budget_(?:exhausted|exceeded|paused)|over budget|budget is paused/i;
const SCOPE_RE = /outside (?:this agent's|your|the agent's) scope|out[ _]of[ _]scope|not in (?:the agent's |this agent's )?scope|bound to a different agent/i;
const OFFLINE_RE = /runtime[ _](?:restart|offline|stopped|not connected|lost)|stopped reporting|bridge (?:not connected|offline|disconnected)|duplicate runtime|gateway(?:_error|unavailable| unavailable| down)|not_admitted|econnrefused|connection refused|no heartbeat/i;
const TIMEOUT_RE = /idle[ _]timeout|timed out|\btimeout\b|no progress/i;

/** One short, redacted line of the raw failure text, for the unknown cause. */
export function shortFailureText(text: string | null | undefined, max = DETAIL_MAX): string | null {
    const clean = redactSensitive((text ?? "").replace(/\s+/g, " ").trim()).replace(/\s+/g, " ").trim();
    if (!clean) return null;
    return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export interface FailureSignal {
    /** Every raw string about the failure (error, exit reason, runtimeFailure.reason); empty ones are ignored. */
    texts?: readonly (string | null | undefined)[];
    /** agent_runs.status when the failure is a run: failed | timeout | lost. */
    runStatus?: string | null;
    /** The agent's budget status (agents.budget_status); "paused" blocks every turn. */
    budgetStatus?: string | null;
    /** The agent's runtime is not connected (no heartbeat, no open run). */
    offline?: boolean;
    /** The run is still open but has made no progress (stall signal). */
    stalled?: boolean;
}

/**
 * The one cause. Text evidence wins over status (a 402 inside a "failed" run
 * is a credits problem, not a generic failure); account problems the agent
 * cannot fix itself (credits, key, model) win over transient ones.
 */
export function classifyFailure(signal: FailureSignal): FailureCause {
    const text = (signal.texts ?? []).filter((t): t is string => typeof t === "string" && t.trim().length > 0).join(" | ");
    if (text) {
        if (CREDITS_RE.test(text)) return "provider_credits";
        if (SCOPE_RE.test(text)) return "scope_denied";
        if (AUTH_RE.test(text)) return "provider_auth";
        if (MODEL_RE.test(text)) return "model_unavailable";
        if (RATE_RE.test(text)) return "rate_limited";
        if (BUDGET_RE.test(text)) return "budget";
        if (OFFLINE_RE.test(text)) return "runtime_offline";
        if (TIMEOUT_RE.test(text)) return "stalled";
    }
    if (signal.budgetStatus === "paused") return "budget";
    if (signal.runStatus === "lost" || signal.offline) return "runtime_offline";
    if (signal.runStatus === "timeout" || signal.stalled) return "stalled";
    return "unknown";
}

const HEADLINE: Record<Exclude<FailureCause, "stalled">, string> = {
    provider_credits: "LLM provider is out of credits",
    provider_auth: "The model provider rejected the API key",
    rate_limited: "Rate limited by the model provider",
    model_unavailable: "This model isn't available",
    budget: "Budget limit reached",
    runtime_offline: "Agent runtime is offline",
    scope_denied: "Agent needs access to this project",
    unknown: "Run failed",
};

/** "No progress for 12 min"; without a measured idle time, "No progress before it timed out". */
export function stalledHeadline(idleMs: number | null | undefined): string {
    if (idleMs == null || !Number.isFinite(idleMs) || idleMs <= 0) return "No progress before it timed out";
    const minutes = Math.max(1, Math.round(idleMs / 60_000));
    if (minutes < 120) return `No progress for ${minutes} min`;
    return `No progress for ${Math.round(minutes / 60)} h`;
}

export function failureHeadline(cause: FailureCause, options: { idleMs?: number | null } = {}): string {
    return cause === "stalled" ? stalledHeadline(options.idleMs) : HEADLINE[cause];
}

/** Which fixes need an owner or admin: provider keys and money and data scope. */
export const ADMIN_ONLY_CAUSES: ReadonlySet<FailureCause> = new Set(["provider_credits", "provider_auth", "budget", "scope_denied"]);

export interface FixContext {
    audience: FixAudience;
    agentId?: string | null;
    taskId?: string | null;
    /**
     * The task's CURRENT assignee (tasks.assigned_agent_id). Nudge and task
     * Retry go to it, not to whoever ran the failed run: the task may have been
     * reassigned since. Null or absent (unassigned) falls back to agentId.
     */
    taskAssigneeId?: string | null;
    /** A failed message the viewer sent (only the sender may retry it). */
    retryMessageId?: string | null;
    /** Local Hermes runtime: Emperor can recreate it in place. */
    canRestartRuntime?: boolean;
    /** When the failure happened (ISO), for the rate-limit delay. */
    failedAt?: string | null;
}

/** Who a task directive (Nudge, task Retry) goes to: the task's current assignee, else the run's agent. */
function taskDirectiveAgent(ctx: FixContext): string | null {
    if (!ctx.taskId) return null;
    return ctx.taskAssigneeId || ctx.agentId || null;
}

/** "Retry": the message again when the viewer sent it, else a retry directive on the task, else nothing. */
function retryFix(ctx: FixContext, label = "Retry"): FailureFix | null {
    if (ctx.retryMessageId) return { label, action: { kind: "retry_message", messageId: ctx.retryMessageId } };
    const target = taskDirectiveAgent(ctx);
    if (target && ctx.taskId) return { label, action: { kind: "message_agent", agentId: target, taskId: ctx.taskId, mode: "retry" } };
    return null;
}

const agentHref = (agentId: string, tab?: string) => `/agents?agent=${encodeURIComponent(agentId)}${tab ? `&tab=${tab}` : ""}`;

/**
 * The one fix button for a cause, or null. Viewers never get one; members get
 * the fixes they can act on; provider keys, budgets and agent scope are owner
 * and admin only (the routes behind them refuse anyone else).
 */
export function failureFix(cause: FailureCause, ctx: FixContext): FailureFix | null {
    if (ctx.audience === "viewer") return null;
    if (ADMIN_ONLY_CAUSES.has(cause) && ctx.audience !== "admin") return null;
    const agentId = ctx.agentId ?? null;
    switch (cause) {
        case "provider_credits":
            return agentId ? { label: "Open provider settings", action: { kind: "link", href: agentHref(agentId) } } : null;
        case "provider_auth":
            return { label: "Update key", action: { kind: "link", href: PROVIDER_KEY_DOC_HREF } };
        case "budget":
            return { label: "Raise budget", action: { kind: "link", href: "/budgets" } };
        case "scope_denied":
            return agentId ? { label: "Open agent scope", action: { kind: "link", href: agentHref(agentId, "scope") } } : null;
        case "model_unavailable":
            return agentId ? { label: "Choose a model", action: { kind: "link", href: agentHref(agentId) } } : null;
        case "runtime_offline":
            if (!agentId) return null;
            return ctx.canRestartRuntime
                ? { label: "Reconnect runtime", action: { kind: "restart_runtime", agentId } }
                : { label: "Reconnect runtime", action: { kind: "link", href: agentHref(agentId) } };
        case "rate_limited": {
            const fix = retryFix(ctx);
            if (!fix) return null;
            const at = ctx.failedAt ? Date.parse(ctx.failedAt) : NaN;
            return { ...fix, notBefore: Number.isFinite(at) ? new Date(at + RATE_LIMIT_RETRY_DELAY_MS).toISOString() : null };
        }
        case "stalled": {
            const target = taskDirectiveAgent(ctx);
            if (target && ctx.taskId) return { label: "Nudge", action: { kind: "message_agent", agentId: target, taskId: ctx.taskId, mode: "nudge" } };
            return retryFix(ctx);
        }
        case "unknown":
            return retryFix(ctx);
    }
}

/** Cause, headline, detail and fix in one call: what every failure surface renders. */
export function describeFailure(signal: FailureSignal & { idleMs?: number | null }, ctx: FixContext): FailureView {
    const cause = classifyFailure(signal);
    const raw = (signal.texts ?? []).find((t): t is string => typeof t === "string" && t.trim().length > 0);
    return {
        cause,
        headline: failureHeadline(cause, { idleMs: signal.idleMs }),
        detail: cause === "unknown" ? shortFailureText(raw) : null,
        fix: failureFix(cause, ctx),
    };
}

/** The directive text a "Nudge" or task "Retry" sends to the agent (same shape as the task page's note directive). */
export function agentFixMessage(action: Extract<FixAction, { kind: "message_agent" }>): string {
    const body = action.mode === "nudge"
        ? "No progress for a while. Continue this task, or add a note saying what is blocking you."
        : "Your last run on this task failed. Please try it again.";
    return action.taskId ? `Task Directive for TASK-${action.taskId}:\n${body}` : body;
}
