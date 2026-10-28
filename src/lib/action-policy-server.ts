// Agent action permissions, server side: load the maps, decide a call, and
// turn "ask" into an approval a person decides in the Inbox. Every governed
// call goes through enforceActionPolicy, whichever way it arrives:
//   - MCP tools (lib/mcp-server/index.ts wraps every registered tool),
//   - the agent REST API (verifyMcpToken in lib/mcp.ts),
//   - check_action, which agents call before an action outside Emperor.
// The rules themselves are pure: lib/action-policy.ts (catalog, resolution)
// and lib/action-policy-rules.ts (fingerprint, matching, expiry).

import { randomUUID } from "crypto";
import type { NextRequest } from "next/server";
import { and, count, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { agents, approvals, companies } from "@/db/schema";
import { broadcastMcpEvent } from "@/lib/pubsub";
import { notifyApprovalRequested } from "@/lib/notifications";
import {
    actionLabel, applyPolicyChanges, changedPolicyKeys, normalizePolicyMap, resolveActionMode, restActionForRequest, restActorRef,
    type ActionMode, type ActionPolicyMap,
} from "@/lib/action-policy";
import { humanActor, recordAudits } from "@/lib/audit";
import {
    ACTION_APPROVAL_KIND, ACTION_GRANT_TTL_MS, MAX_PENDING_ACTION_ASKS, actionBinding, hashActionArgs, matchActionApproval, previewActionArgs,
} from "@/lib/action-policy-rules";
import { isVerifiedReplyBy, mcpActingAgentId } from "@/lib/thread-access";
import { EXTERNAL_APPROVAL_TTL_MS } from "@/lib/approval-status";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ActionDecision =
    | { outcome: "allowed"; actionKey: string; mode: ActionMode; approvalId: string | null }
    | { outcome: "off"; actionKey: string; mode: "off"; message: string }
    | { outcome: "pending"; actionKey: string; mode: "ask"; approvalId: string; message: string }
    | { outcome: "refused"; actionKey: string; mode: "ask"; approvalId: string | null; message: string };

export async function loadActionPolicies(companyId: string, agentId: string | null): Promise<{ agent: ActionPolicyMap; company: ActionPolicyMap }> {
    const [company] = await db.select({ map: companies.actionPoliciesJson }).from(companies).where(eq(companies.id, companyId)).limit(1);
    const [agent] = agentId
        ? await db.select({ map: agents.actionPoliciesJson }).from(agents).where(and(eq(agents.id, agentId), eq(agents.companyId, companyId))).limit(1)
        : [];
    return { agent: normalizePolicyMap(agent?.map), company: normalizePolicyMap(company?.map) };
}

/**
 * Decide one call. The acting agent's own settings apply, else the company's;
 * a call no agent can be resolved for (a company-wide token naming none) gets
 * the company policy, never a free pass. "ask" is answered by an earlier
 * approval of this exact caller + action + arguments when there is one (an
 * approved one is used up here, atomically), otherwise a new approval is
 * created. `exempt` is consulted only when the mode is not "allowed".
 */
export async function enforceActionPolicy(input: {
    companyId: string;
    agentId: string | null;
    /** The token, when no agent acts: an agentless ask is bound to it. */
    tokenId?: string | null;
    actionKey: string;
    args: unknown;
    exempt?: () => Promise<boolean>;
    now?: Date;
}): Promise<ActionDecision> {
    const { companyId, agentId, actionKey } = input;
    const maps = await loadActionPolicies(companyId, agentId);
    const { mode } = resolveActionMode(actionKey, maps.agent, maps.company);
    const label = actionLabel(actionKey);
    if (mode === "allowed") return { outcome: "allowed", actionKey, mode, approvalId: null };
    if (input.exempt && await input.exempt()) return { outcome: "allowed", actionKey, mode, approvalId: null };
    const who = agentId ? "this agent" : "this connection (no agent named, so the company defaults apply)";
    if (mode === "off") {
        return {
            outcome: "off", actionKey, mode,
            message: `Not allowed: "${label}" (${actionKey}) is turned off for ${who}. Don't try it another way. Tell whoever asked that it needs a permission change in Emperor (the agent's Actions tab).`,
        };
    }

    const now = input.now ?? new Date();
    const argsHash = hashActionArgs(actionKey, input.args, actionBinding(agentId, input.tokenId ?? null));
    const call = { agentId, actionKey, argsHash };
    const since = new Date(now.getTime() - EXTERNAL_APPROVAL_TTL_MS - ACTION_GRANT_TTL_MS);
    // Only this exact call's asks (the hash binds caller, action and arguments).
    const rows = await db.select().from(approvals).where(and(
        eq(approvals.companyId, companyId),
        eq(approvals.actionType, actionKey),
        eq(approvals.argsHash, argsHash),
        gte(approvals.requestedAt, since),
    )).orderBy(desc(approvals.requestedAt)).limit(10);

    const match = matchActionApproval(rows, call, now.getTime());
    if (match.kind === "grant") {
        // Single use: only the call that flips consumed_at goes through.
        const [used] = await db.update(approvals).set({ consumedAt: now }).where(and(
            eq(approvals.id, match.approval.id),
            eq(approvals.companyId, companyId),
            eq(approvals.status, "approved"),
            isNull(approvals.consumedAt),
        )).returning({ id: approvals.id });
        if (used) return { outcome: "allowed", actionKey, mode, approvalId: used.id };
    }
    if (match.kind === "pending") {
        return { outcome: "pending", actionKey, mode, approvalId: match.approval.id, message: pendingMessage(label, actionKey, match.approval.id) };
    }
    if (match.kind === "refused") {
        const note = (rows.find((r) => r.id === match.approval.id)?.resolutionNote ?? "").trim();
        return {
            outcome: "refused", actionKey, mode, approvalId: match.approval.id,
            message: `A person ${match.approval.status} this exact request (${label})${note ? `: "${note}"` : ""}. Do NOT do it. Don't ask again unchanged; change what you were going to do or ask the person in chat.`,
        };
    }

    const preview = previewActionArgs(input.args);
    if (!preview.ok) {
        return {
            outcome: "refused", actionKey, mode, approvalId: null,
            message: `"${label}" (${actionKey}) needs a person's approval, but this call can't be shown for approval: ${preview.reason}. Nothing was done. Split it into smaller calls, or ask the person in chat.`,
        };
    }
    const waiting = await countPendingAsks(companyId, agentId, input.tokenId ?? null);
    if (waiting >= MAX_PENDING_ACTION_ASKS) {
        return {
            outcome: "refused", actionKey, mode, approvalId: null,
            message: `"${label}" (${actionKey}) needs a person's approval, but ${waiting} of your requests are already waiting (at most ${MAX_PENDING_ACTION_ASKS}). Nothing was done. Wait for those decisions before asking for more.`,
        };
    }
    const approval = await createActionApproval({ companyId, agentId, tokenId: input.tokenId ?? null, actionKey, argsHash, preview: preview.fields });
    return { outcome: "pending", actionKey, mode, approvalId: approval.id, message: pendingMessage(label, actionKey, approval.id) };
}

function pendingMessage(label: string, actionKey: string, approvalId: string): string {
    return `Approval needed: "${label}" (${actionKey}) is set to ask first, so nothing was done. Approval ${approvalId} is waiting for a person in the Inbox. Don't do it yet and don't work around it. When you are told it is approved, repeat the exact same call once, with the same arguments, within 24 hours.`;
}

/** Pending action asks of one agent (or, with no agent, of one token). */
async function countPendingAsks(companyId: string, agentId: string | null, tokenId: string | null): Promise<number> {
    const [row] = await db.select({ n: count() }).from(approvals).where(and(
        eq(approvals.companyId, companyId),
        eq(approvals.status, "pending"),
        sql`${approvals.metadataJson}->>'kind' = ${ACTION_APPROVAL_KIND}`,
        agentId ? eq(approvals.requesterAgentId, agentId)
            : and(isNull(approvals.requesterAgentId), sql`${approvals.metadataJson}->>'tokenId' IS NOT DISTINCT FROM ${tokenId}`),
    ));
    return Number(row?.n ?? 0);
}

async function createActionApproval(input: {
    companyId: string; agentId: string | null; tokenId: string | null; actionKey: string; argsHash: string;
    preview: { field: string; value: string }[];
}) {
    const label = actionLabel(input.actionKey);
    // Every argument on one line: the Inbox detail, dashboard and notification text (always shown as plain text).
    const rationale = input.preview.length > 0 ? input.preview.map((p) => `${p.field}: ${p.value}`).join(" · ") : "No details given";
    const [created] = await db.insert(approvals).values({
        id: randomUUID(),
        companyId: input.companyId,
        projectId: null,
        requesterAgentId: input.agentId,
        actionType: input.actionKey,
        argsHash: input.argsHash,
        rationale,
        metadataJson: { kind: ACTION_APPROVAL_KIND, actionKey: input.actionKey, actionLabel: label, tokenId: input.agentId ? null : input.tokenId, args: input.preview },
    }).onConflictDoNothing().returning();
    if (!created) {
        // A concurrent identical ask won the one-pending-per-call index: wait on that one.
        const [existing] = await db.select().from(approvals).where(and(
            eq(approvals.companyId, input.companyId), eq(approvals.actionType, input.actionKey),
            eq(approvals.argsHash, input.argsHash), eq(approvals.status, "pending"),
        )).limit(1);
        if (existing) return existing;
        throw new Error("Could not record the approval request");
    }
    await broadcastMcpEvent(input.companyId, { type: "approval_created", approval: created, taskIds: [] });
    await notifyApprovalRequested(input.companyId, created);
    return created;
}

/** A live agent of this company, or null. */
export async function findCompanyAgent(companyId: string, agentId: string): Promise<{ name: string } | null> {
    if (!UUID_RE.test(agentId)) return null;
    const [agent] = await db.select({ name: agents.name }).from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId), isNull(agents.deletedAt))).limit(1);
    return agent ?? null;
}

export class ActionPolicyError extends Error {
    constructor(message: string, public status: number) {
        super(message);
    }
}

/**
 * Change an agent's own permissions ({ key: mode | null }; null = back to the
 * company default) or, with agentId null, the company defaults. One activity
 * entry per action whose setting changed, with before and after.
 */
export async function updateActionPolicies(input: {
    companyId: string;
    agentId: string | null;
    changes: unknown;
    actorUserId: string;
}): Promise<{ agent: ActionPolicyMap; company: ActionPolicyMap }> {
    const { companyId, agentId } = input;
    const current = await loadActionPolicies(companyId, agentId);
    let agentName: string | null = null;
    if (agentId) {
        const exists = await findCompanyAgent(companyId, agentId);
        if (!exists) throw new ActionPolicyError("Agent not found", 404);
        agentName = exists.name;
    }
    const before = agentId ? current.agent : current.company;
    const applied = applyPolicyChanges(before, input.changes);
    if ("error" in applied) throw new ActionPolicyError(applied.error, 400);
    const changed = changedPolicyKeys(before, applied.map);
    if (changed.length === 0) return current;

    if (agentId) {
        await db.update(agents).set({ actionPoliciesJson: applied.map as Record<string, string> }).where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));
    } else {
        await db.update(companies).set({ actionPoliciesJson: applied.map as Record<string, string> }).where(eq(companies.id, companyId));
    }

    await recordAudits(changed.map((change) => ({
        companyId,
        actor: humanActor(input.actorUserId),
        action: agentId ? "agent.permission_changed" : "company.permission_changed",
        target: agentId ? { type: "agent" as const, id: agentId } : { type: "company" as const, id: companyId },
        before: { actionKey: change.key, permission: change.before },
        after: { actionKey: change.key, permission: change.after },
        meta: agentId ? { label: agentName } : null,
    })));
    return agentId ? { agent: applied.map, company: current.company } : { agent: {}, company: applied.map };
}

export type CheckActionResult = {
    action: string;
    label: string;
    decision: "allowed" | "off" | "approval_pending" | "refused";
    /** True only when the agent may do it now (and, for an approved ask, this uses the approval up). */
    mayProceed: boolean;
    approvalId: string | null;
    message: string;
};

/**
 * check_action: an agent asks before an action Emperor can't see (an email
 * sent with its own tool, a purchase, a deploy...). Same off / ask / allowed
 * rules as Emperor's own tools; `details` is what it is about to do and is
 * what an approval is bound to.
 */
export async function checkExternalAction(input: { companyId: string; agentId: string | null; tokenId?: string | null; action: string; details: unknown }): Promise<CheckActionResult> {
    const label = actionLabel(input.action);
    const decision = await enforceActionPolicy({ companyId: input.companyId, agentId: input.agentId, tokenId: input.tokenId ?? null, actionKey: input.action, args: input.details ?? {} });
    if (decision.outcome === "allowed") {
        return {
            action: input.action, label, decision: "allowed", mayProceed: true, approvalId: decision.approvalId,
            message: decision.approvalId
                ? `Approved by a person (approval ${decision.approvalId}). Go ahead once, exactly as described; check again before doing it another time.`
                : `Allowed: go ahead with "${label}".`,
        };
    }
    return {
        action: input.action, label, decision: decision.outcome === "pending" ? "approval_pending" : decision.outcome,
        mayProceed: false, approvalId: "approvalId" in decision ? decision.approvalId : null, message: decision.message,
    };
}

/**
 * The REST side of the gate, called by verifyMcpToken for every agent API
 * request. Returns null when the request may proceed, else the error to send.
 * The acting agent is the token's bound agent, else the agent the route
 * itself acts as, read the same way (lib/action-policy.ts restActorRef);
 * none resolved means the company policy applies.
 */
export async function enforceRestActionPolicy(
    req: NextRequest,
    token: { id: string; companyId: string; agentId?: string | null },
    parsedBody?: unknown,
): Promise<{ error: string; status: number } | null> {
    const pathname = req.nextUrl?.pathname ?? new URL(req.url).pathname;
    const route = restActionForRequest(req.method, pathname);
    if (!route) return null;
    // A route that read the body first hands it over; otherwise read a copy.
    const raw = parsedBody !== undefined ? parsedBody : req.bodyUsed ? null : await req.clone().json().catch(() => null);
    const body = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    const query = req.nextUrl?.searchParams ?? new URL(req.url).searchParams;
    const agentId = await mcpActingAgentId(token.companyId, token, restActorRef(route.actor, query, body));
    const decision = await enforceActionPolicy({
        companyId: token.companyId, agentId, tokenId: token.id, actionKey: route.key,
        args: { ...body, __route: pathname },
        // An agent's answer to a message it was sent (how the bridge delivers
        // every chat reply) is not held, once the server has verified it.
        exempt: pathname.replace(/\/+$/, "") === "/api/mcp/messages/send"
            ? () => isVerifiedReplyBy(token.companyId, agentId, typeof body?.thread_id === "string" ? body.thread_id : null, body?.replyToMessageId)
            : undefined,
    });
    if (decision.outcome === "allowed") return null;
    return { error: decision.message, status: decision.outcome === "pending" ? 409 : 403 };
}
