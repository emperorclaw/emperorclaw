// Ask-first approvals for agent actions: how a call is fingerprinted, how it
// is shown to the person deciding, and which earlier approval (if any)
// answers it. Pure (Node crypto only, no DB) so the binding, expiry and
// single-use rules are unit-tested directly (tests/unit/action-policy.test.ts).
// The DB side is lib/action-policy-server.ts.

import { createHash } from "crypto";
import { redactSensitive, REDACT_INPUT_MAX } from "@/lib/redact-sensitive";

/** metadata_json.kind of an approval created by an "ask" action permission. */
export const ACTION_APPROVAL_KIND = "action_policy";

/** An approved ask can be used this long after the decision, once. */
export const ACTION_GRANT_TTL_MS = 24 * 60 * 60 * 1000;

/** At most this many asks of one agent (or one agentless token) wait at a time. */
export const MAX_PENDING_ACTION_ASKS = 20;

/** JSON with object keys sorted at every level, so equal arguments always hash the same. */
export function stableStringify(value: unknown): string {
    if (value === undefined) return "null";
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
    if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/**
 * Delivery bookkeeping a runtime adds per turn or per attempt (the message a
 * reply answers, run and session ids). Not part of what the action does, and
 * different on the retry after approval, so left out of the fingerprint and
 * the preview. Top level only: the same names deeper down are real content.
 */
export const VOLATILE_ARG_KEYS: ReadonlySet<string> = new Set(["replyToMessageId", "ack", "runId", "sessionId", "submissionId", "sessionGeneration", "idempotencyKey"]);

function withoutVolatile(args: unknown): unknown {
    if (!args || typeof args !== "object" || Array.isArray(args)) return args;
    return Object.fromEntries(Object.entries(args as Record<string, unknown>).filter(([key]) => !VOLATILE_ARG_KEYS.has(key)));
}

/**
 * Who an approval is for: the acting agent, or (when a company-wide token
 * names none) that token. Part of the fingerprint, so one caller's approval
 * never answers another's call.
 */
export function actionBinding(agentId: string | null, tokenId: string | null): string {
    return agentId ? `agent:${agentId}` : `token:${tokenId ?? "none"}`;
}

/** The fingerprint an approval is bound to: one caller, one action, these exact arguments. */
export function hashActionArgs(actionKey: string, args: unknown, binding: string): string {
    return createHash("sha256").update(`${binding}\n${actionKey}\n${stableStringify(withoutVolatile(args ?? {}))}`).digest("hex");
}

/** Bounds on what a person can be asked to approve: every field is shown in full, or the ask is refused. */
export const PREVIEW_MAX_FIELDS = 20;
export const PREVIEW_MAX_CHARS = 8_000;

export type ActionPreview = { ok: true; fields: { field: string; value: string }[] } | { ok: false; reason: string };

const UUID_OR_EMAIL_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9._%+-]{1,64}@[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){1,10}/gi;

/**
 * Redact secrets, links and paths, but keep email addresses and ids: the
 * person approving must see who an email goes to and which record changes.
 */
export function redactForApproval(text: string): string {
    // Kept values hide behind private-use sentinels the redactor never produces, so only those are
    // restored and digits in the text stay as written. Input that already holds a sentinel is just redacted.
    if (/[\uE000\uE001]/.test(text)) return redactSensitive(text);
    const kept: string[] = [];
    const masked = text.replace(UUID_OR_EMAIL_RE, (match) => `\uE000${kept.push(match) - 1}\uE001`);
    return redactSensitive(masked).replace(/\uE000(\d+)\uE001/g, (whole, i: string) => kept[Number(i)] ?? whole);
}

/**
 * What a person sees on the approval card: every argument (bookkeeping
 * aside) as "field: value", in full, keys and values redacted. Null and empty
 * values are shown too. Arguments too large to show in full are refused
 * rather than cut, since the approval covers exactly what was shown.
 */
export function previewActionArgs(args: unknown): ActionPreview {
    if (args === null || args === undefined) return { ok: true, fields: [] };
    const entries: [string, unknown][] = typeof args === "object" && !Array.isArray(args)
        ? Object.entries(withoutVolatile(args) as Record<string, unknown>).filter(([, v]) => v !== undefined)
        : [["details", args]];
    if (entries.length > PREVIEW_MAX_FIELDS) {
        return { ok: false, reason: `it has ${entries.length} fields (at most ${PREVIEW_MAX_FIELDS} can be shown for approval)` };
    }
    const fields: { field: string; value: string }[] = [];
    let total = 0;
    for (const [key, value] of entries) {
        const raw = typeof value === "string" ? value : stableStringify(value);
        if (raw.length > REDACT_INPUT_MAX || key.length > 200) {
            return { ok: false, reason: `"${key.slice(0, 60)}" is too long to show in full (at most ${REDACT_INPUT_MAX} characters per field)` };
        }
        total += key.length + raw.length;
        if (total > PREVIEW_MAX_CHARS) {
            return { ok: false, reason: `its arguments are too large to show in full (at most ${PREVIEW_MAX_CHARS} characters)` };
        }
        fields.push({ field: redactForApproval(key), value: redactForApproval(raw) });
    }
    return { ok: true, fields };
}

/** The arguments stored on an ask-first approval (metadata_json.args), for the Inbox and Approvals page. */
export function storedActionArgs(metadata: unknown): { field: string; value: string }[] {
    const args = metadata && typeof metadata === "object" ? (metadata as { args?: unknown }).args : null;
    if (!Array.isArray(args)) return [];
    return args.flatMap((a) => {
        const item = a && typeof a === "object" ? a as { field?: unknown; value?: unknown } : {};
        return typeof item.field === "string" && typeof item.value === "string" ? [{ field: item.field, value: item.value }] : [];
    });
}

/** The parts of an approval row the matching needs. */
export type ActionApprovalRecord = {
    id: string;
    status: string;
    requesterAgentId: string | null;
    actionType: string;
    argsHash: string | null;
    metadataJson: unknown;
    requestedAt: Date;
    resolvedAt: Date | null;
    consumedAt: Date | null;
};

export type ActionCall = { agentId: string | null; actionKey: string; argsHash: string };

export function isActionApproval(approval: { metadataJson: unknown }): boolean {
    const meta = approval.metadataJson && typeof approval.metadataJson === "object" ? approval.metadataJson as Record<string, unknown> : {};
    return meta.kind === ACTION_APPROVAL_KIND;
}

/** Does this approval belong to exactly this caller, action and argument set? */
export function approvalMatchesCall(approval: ActionApprovalRecord, call: ActionCall): boolean {
    return isActionApproval(approval)
        && approval.requesterAgentId === call.agentId
        && approval.actionType === call.actionKey
        && approval.argsHash === call.argsHash;
}

/** May an approved ask still be used? Approved, unused and decided within the TTL. */
export function isUsableGrant(approval: ActionApprovalRecord, nowMs: number): boolean {
    return approval.status === "approved"
        && approval.consumedAt === null
        && approval.resolvedAt !== null
        && nowMs - approval.resolvedAt.getTime() <= ACTION_GRANT_TTL_MS;
}

export type ActionApprovalMatch =
    | { kind: "grant"; approval: ActionApprovalRecord }
    | { kind: "pending"; approval: ActionApprovalRecord }
    | { kind: "refused"; approval: ActionApprovalRecord }
    | { kind: "none" };

/**
 * Which earlier ask answers this call (rows may be in any order):
 * - an approved, unused, unexpired one: the call may run (and uses it up);
 * - a pending one: keep waiting on it rather than asking twice;
 * - a rejection or dismissal decided within the TTL: refused, do not re-ask
 *   the same thing;
 * - otherwise none: ask a person.
 * Used, expired and other callers' / other arguments' approvals never count.
 */
export function matchActionApproval(rows: readonly ActionApprovalRecord[], call: ActionCall, nowMs: number): ActionApprovalMatch {
    const mine = rows.filter((row) => approvalMatchesCall(row, call))
        .sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime());
    const grant = mine.find((row) => isUsableGrant(row, nowMs));
    if (grant) return { kind: "grant", approval: grant };
    const pending = mine.find((row) => row.status === "pending");
    if (pending) return { kind: "pending", approval: pending };
    const latest = mine[0];
    if (latest && (latest.status === "rejected" || latest.status === "dismissed")
        && latest.resolvedAt && nowMs - latest.resolvedAt.getTime() <= ACTION_GRANT_TTL_MS) {
        return { kind: "refused", approval: latest };
    }
    return { kind: "none" };
}
