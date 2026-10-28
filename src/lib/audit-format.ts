// The activity / audit log (roadmap 11.3): the redaction allowlist every
// audit_log payload passes through, and the "<Actor> <verb> <target>" sentence
// the Activity page shows. Pure and client-safe (no DB or Node imports); the
// writer lives in lib/audit.ts and the reader in lib/audit-reads.ts.
//
// Unit-tested in tests/unit/audit.test.ts.

import { clipForRedaction, redactSensitive } from "@/lib/redact-sensitive";
import { taskHref } from "@/lib/task-story";
import { actionLabel } from "@/lib/action-policy";

export type AuditActorType = "human" | "agent" | "system";

/** Who did it. A company-wide MCP token with no agent is "system" plus its token id. */
export type AuditActor = { type: AuditActorType; id: string | null; tokenId?: string | null };

export const AUDIT_TARGET_TYPES = [
    "agent", "task", "approval", "member", "invitation", "company", "organization", "project", "customer", "knowledge_note",
    "pricing", "view",
] as const;
export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number];

export type AuditFields = Record<string, unknown>;
export type AuditPayload = { before?: AuditFields; after?: AuditFields; meta?: AuditFields };

/** How a stored field is checked: anything that fails the check is dropped. */
type FieldKind =
    | "id"      // a uuid
    | "ids"     // a list of uuids
    | "label"   // a short name/title (secrets and links are scrubbed)
    | "person"  // a person's label: kept as is when it is their email, else a label
    | "enum"    // a short machine word (state, role, mode, model id)
    | "email"
    | "number"
    | "bool";

const COMMON_META: Record<string, FieldKind> = {
    tokenId: "id",
    label: "label",
    batch: "id",
    count: "number",
    via: "enum",
};

/**
 * Targets that are people: their label is the person's name or, failing that,
 * their email, which is the identity itself (and the Activity page is admin
 * only), so an email label is not redacted. Free text still is.
 */
const PERSON_META: Partial<Record<AuditTargetType, Record<string, FieldKind>>> = {
    member: { label: "person" },
    invitation: { label: "person" },
};

/**
 * THE REDACTION ALLOWLIST. Only the fields listed for a target type are
 * stored (in before, after and meta); everything else is dropped. Titles, ids,
 * states, names and numbers only: never message or chat text, note bodies,
 * prompts, memory, doctrine, secrets, tokens or keys.
 */
export const AUDIT_FIELD_ALLOWLIST: Record<AuditTargetType, Record<string, FieldKind>> = {
    agent: {
        name: "label", role: "label", provider: "enum", deploymentMode: "enum",
        llmProvider: "enum", llmModel: "enum", concurrencyLimit: "number",
        // Where the model calls go (host name only, never the path, query or key) and whether the key was replaced.
        llmEndpointHost: "enum", llmKeyChanged: "bool",
        monthlyBudgetCents: "number", budgetStatus: "enum",
        scopeMode: "enum", scopeCustomerIds: "ids", scopeProjectIds: "ids", scopeAgentIds: "ids",
        // An action permission change (lib/action-policy.ts): which action, and off / ask / allowed (null = default).
        actionKey: "enum", permission: "enum",
        // Who can use it (0.20, lib/agent-access.ts).
        access: "enum", ownerUserId: "id", accessCount: "number", toName: "label",
    },
    task: {
        title: "label", state: "enum", priority: "number", projectId: "id",
        assigneeType: "enum", assigneeId: "id", archived: "bool",
    },
    approval: { status: "enum", actionType: "enum", taskIds: "ids", projectId: "id" },
    member: {
        name: "label", email: "email", role: "enum", instanceRole: "enum",
        scopeMode: "enum", scopeCustomerIds: "ids", scopeAgentIds: "ids",
        // Access to one customer or project (0.20, lib/resource-roles.ts).
        resourceType: "enum", resourceId: "id", resourceRole: "enum", resourceName: "label",
    },
    invitation: { email: "email", role: "enum", resourceType: "enum", resourceId: "id", resourceRole: "enum", resourceName: "label" },
    company: {
        setting: "enum", directChatMode: "enum", registrationMode: "enum", instanceName: "label",
        agentRoutineEnabled: "bool", routineTime: "enum", timezone: "enum", weekdaysOnly: "bool", stallRemindersEnabled: "bool",
        actionKey: "enum", permission: "enum",
        // Settings → Modules (lib/modules.ts): one on/off per module, and the template that set them.
        customersModule: "bool", automationsModule: "bool", timelineModule: "bool", costsModule: "bool",
        approvalsModule: "bool", viewsModule: "bool", displaysModule: "bool", template: "enum",
    },
    organization: { leaderKind: "enum", leaderId: "id", nodeCount: "number", teamCount: "number" },
    project: {
        name: "label", status: "enum", customerId: "id", leadAgentId: "id",
        requireApprovalForDone: "bool", maxActiveAgents: "number", archived: "bool",
    },
    customer: { name: "label", status: "enum" },
    knowledge_note: { title: "label", path: "label" },
    // llm_pricing is instance-wide; the entry lands in the editing admin's company.
    pricing: {
        provider: "enum", model: "enum", inputPricePer1k: "number", outputPricePer1k: "number", active: "bool",
    },
    // A view's title, scope and shape only: never panel values.
    view: {
        title: "label", scopeType: "enum", scopeId: "id", panelCount: "number", version: "number",
        archived: "bool", pinnedToHome: "bool", fromVersion: "number",
        visibility: "enum", ownerUserId: "id", sharedCount: "number", toName: "label",
        ownerSource: "enum", threadId: "id",
    },
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENUM_RE = /^[\w .:/@+-]{1,120}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}$/;
const LABEL_MAX = 160;
const IDS_MAX = 100;

export function isAuditTargetType(value: unknown): value is AuditTargetType {
    return typeof value === "string" && (AUDIT_TARGET_TYPES as readonly string[]).includes(value);
}

function cleanValue(kind: FieldKind, value: unknown): unknown {
    if (value === null) return null;
    switch (kind) {
        case "id":
            return typeof value === "string" && UUID_RE.test(value) ? value : undefined;
        case "ids":
            return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && UUID_RE.test(v)).slice(0, IDS_MAX) : undefined;
        case "label": {
            if (typeof value !== "string" && typeof value !== "number") return undefined;
            // Clip before redacting: a label is short, the input may not be.
            const text = redactSensitive(clipForRedaction(String(value), LABEL_MAX * 4).replace(/\s+/g, " ").trim());
            if (!text) return undefined;
            return text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1)}…` : text;
        }
        case "person":
            if (typeof value === "string" && EMAIL_RE.test(value.trim())) return value.trim().toLowerCase();
            return cleanValue("label", value);
        case "enum":
            return typeof value === "string" && ENUM_RE.test(value) ? value : undefined;
        case "email":
            return typeof value === "string" && EMAIL_RE.test(value.trim()) ? value.trim().toLowerCase() : undefined;
        case "number":
            return typeof value === "number" && Number.isFinite(value) ? value : undefined;
        case "bool":
            return typeof value === "boolean" ? value : undefined;
    }
}

function cleanFields(allowed: Record<string, FieldKind>, input: unknown): AuditFields | undefined {
    if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
    const out: AuditFields = {};
    for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
        const kind = Object.prototype.hasOwnProperty.call(allowed, key) ? allowed[key] : undefined;
        if (!kind || raw === undefined) continue;
        const value = cleanValue(kind, raw);
        if (value !== undefined) out[key] = value;
    }
    return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The stored payload: before/after/meta with every field not on the target's
 * allowlist removed and every kept value checked. Also applied on read, so a
 * legacy row (lib/mcp.ts logAudit) never shows more than the allowlist.
 */
export function redactAuditPayload(targetType: string, payload: unknown): AuditPayload {
    const allowed = isAuditTargetType(targetType) ? AUDIT_FIELD_ALLOWLIST[targetType] : {};
    const p = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    const out: AuditPayload = {};
    const before = cleanFields(allowed, p.before);
    const after = cleanFields(allowed, p.after);
    const personMeta = isAuditTargetType(targetType) ? PERSON_META[targetType] : undefined;
    const meta = cleanFields({ ...allowed, ...COMMON_META, ...personMeta }, p.meta);
    if (before) out.before = before;
    if (after) out.after = after;
    if (meta) out.meta = meta;
    return out;
}

/** Just the fields that changed between two snapshots (both sides kept). */
export function changedFields(before: AuditFields, after: AuditFields): { before: AuditFields; after: AuditFields } {
    const b: AuditFields = {};
    const a: AuditFields = {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (after[key] === undefined) continue;
        if (JSON.stringify(before[key] ?? null) === JSON.stringify(after[key] ?? null)) continue;
        b[key] = before[key] ?? null;
        a[key] = after[key];
    }
    return { before: b, after: a };
}

/** An agent or member scope_json flattened into allowlisted fields. */
export function scopeAuditFields(scopeJson: unknown): AuditFields {
    const s = scopeJson && typeof scopeJson === "object" ? scopeJson as Record<string, unknown> : {};
    const ids = (value: unknown) => (Array.isArray(value) ? [...value].filter((v) => typeof v === "string").sort() : undefined);
    return {
        scopeMode: typeof s.mode === "string" ? s.mode : "all",
        scopeCustomerIds: ids(s.customerIds) ?? [],
        scopeProjectIds: ids(s.projectIds) ?? [],
        scopeAgentIds: ids(s.agentIds) ?? null,
    };
}

// ─── Sentence ───────────────────────────────────────────────────────────────

const TARGET_NOUNS: Record<string, string> = {
    agent: "agent", task: "task", approval: "approval", member: "", invitation: "an invitation for",
    company: "", organization: "", project: "project", customer: "customer", knowledge_note: "note",
    pricing: "pricing for", view: "view",
};

/** "<verb> <noun> <label>"; a verb with "{target}" places the target itself. */
const VERBS: Record<string, string> = {
    "agent.created": "created",
    "agent.updated": "updated",
    "agent.paused": "paused",
    "agent.resumed": "resumed",
    "agent.deleted": "deleted",
    "agent.scope_changed": "changed the data scope of",
    "agent.budget_changed": "changed the budget of",
    "agent.permission_changed": "changed an action permission of",
    "agent.access_changed": "changed who can use",
    "agent.owner_transferred": "transferred",
    "company.permission_changed": "changed a company action permission",
    "task.state_changed": "moved",
    "task.assigned": "reassigned",
    "task.archived": "archived",
    "task.unarchived": "restored",
    "approval.approved": "approved",
    "approval.rejected": "rejected",
    "approval.dismissed": "dismissed",
    "member.role_changed": "changed the role of",
    "member.scope_changed": "changed the access of",
    "member.removed": "removed",
    "member.invited": "invited",
    "member.access_granted": "gave",
    "member.access_changed": "changed the access of",
    "member.access_removed": "removed the access of",
    "invitation.revoked": "revoked",
    "company.settings_changed": "changed company settings",
    "organization.updated": "edited the org chart",
    "project.created": "created",
    "project.updated": "updated",
    "project.archived": "archived",
    "customer.created": "added",
    "customer.updated": "updated",
    "customer.deleted": "deleted",
    "knowledge_note.created": "created",
    "knowledge_note.moved": "moved",
    "knowledge_note.deleted": "deleted",
    "pricing.created": "added",
    "pricing.updated": "changed",
    "view.created": "created",
    "view.updated": "updated",
    "view.archived": "archived",
    "view.restored": "restored",
    "view.reverted": "reverted",
    "view.visibility_changed": "changed who can see",
    "view.owner_transferred": "transferred",
    "view.deleted": "deleted",
    "view.read_unbound_token": "opened with a company-wide token",
    // Rows written before 0.14 by lib/mcp.ts logAudit.
    register_agent: "created",
    delete_agent: "deleted",
    hire_hermes_agent: "hired",
    "company.direct_chat_mode_changed": "changed company settings",
};

const SETTING_LABELS: Record<string, string> = {
    directChatMode: "direct chat mode", contextNotes: "company context", agentRoutine: "daily agent routine", instance: "instance settings", modules: "modules",
};

const STATE_LABELS: Record<string, string> = {
    inbox: "Inbox", queued: "Queued", in_progress: "In progress", review: "Review", blocked: "Blocked",
    done: "Done", failed: "Failed", dead_letter: "Dead letter",
};

export type AuditEntryInput = {
    action: string;
    targetType: string;
    targetId: string;
    payload: AuditPayload;
    actorType: string;
    actorName: string | null;
};

export type AuditSentence = {
    actor: string;
    verb: string;
    /** "" when the verb already names what changed ("changed company settings"). */
    noun: string;
    label: string | null;
    detail: string | null;
};

/** Words for anything not on the verb list, e.g. "create_incident" → "create incident". */
function fallbackVerb(action: string): string {
    return action.replace(/^[a-z_]+\./, "").replace(/[._]+/g, " ").trim() || "changed";
}

const RESOURCE_ROLE_WORDS: Record<string, string> = { admin: "Admin", editor: "Can edit", viewer: "Can view" };

const PERMISSION_WORDS: Record<string, string> = { off: "off", ask: "ask first", allowed: "allowed" };

/** An action permission as words; null means the setting was removed (back to the default). */
function permissionWord(value: unknown): string {
    return typeof value === "string" ? PERMISSION_WORDS[value] ?? value : "default";
}

export function formatCents(cents: number): string {
    return `$${(cents / 100).toFixed(2)}`;
}

function detailFor(action: string, payload: AuditPayload, names: Readonly<Record<string, string>>): string | null {
    const after = payload.after ?? {};
    const meta = payload.meta ?? {};
    switch (action) {
        case "task.state_changed":
            return typeof after.state === "string" ? `to ${STATE_LABELS[after.state] ?? after.state}` : null;
        case "task.assigned": {
            const id = typeof after.assigneeId === "string" ? after.assigneeId : null;
            return id ? `to ${names[id] ?? (after.assigneeType === "member" ? "a person" : "an agent")}` : "to nobody";
        }
        case "member.role_changed":
            return typeof after.role === "string" ? `to ${after.role}` : null;
        case "member.invited":
            if (typeof meta.resourceName === "string" && typeof after.resourceRole === "string") return `to ${meta.resourceName} as ${RESOURCE_ROLE_WORDS[after.resourceRole] ?? after.resourceRole}`;
            return typeof after.role === "string" ? `as ${after.role}` : null;
        case "member.access_granted":
        case "member.access_changed": {
            const where = typeof meta.resourceName === "string" ? meta.resourceName : "a client or project";
            const role = typeof after.resourceRole === "string" ? RESOURCE_ROLE_WORDS[after.resourceRole] ?? after.resourceRole : null;
            return action === "member.access_granted" ? `access to ${where}${role ? ` (${role})` : ""}` : `on ${where}${role ? ` to ${role}` : ""}`;
        }
        case "member.access_removed":
            return typeof meta.resourceName === "string" ? `on ${meta.resourceName}` : null;
        case "agent.access_changed": {
            const word = after.access === "everyone" ? "everyone" : after.access === "people" ? "specific people" : after.access === "owner" ? "only its owner" : null;
            return word ? `(${word})` : null;
        }
        case "agent.owner_transferred":
            return typeof meta.toName === "string" && meta.toName ? `to ${meta.toName}` : null;
        case "company.settings_changed": {
            const setting = typeof meta.setting === "string" ? SETTING_LABELS[meta.setting] ?? null : null;
            return setting ? `(${setting})` : null;
        }
        case "agent.permission_changed":
        case "company.permission_changed": {
            const key = typeof after.actionKey === "string" ? after.actionKey : null;
            return key ? `(${actionLabel(key)}: ${permissionWord(after.permission)})` : null;
        }
        case "agent.budget_changed":
            return typeof after.monthlyBudgetCents === "number"
                ? after.monthlyBudgetCents > 0 ? `to ${formatCents(after.monthlyBudgetCents)} a month` : "to no limit"
                : null;
        case "view.reverted":
            return typeof meta.fromVersion === "number" ? `to version ${meta.fromVersion}` : null;
        case "view.visibility_changed": {
            const word = after.visibility === "private" ? "only its owner" : after.visibility === "shared" ? "shared people" : after.visibility === "scope" ? "everyone in scope" : null;
            return word ? `(${word})` : null;
        }
        case "view.owner_transferred":
            return typeof meta.toName === "string" && meta.toName ? `to ${meta.toName}` : null;
        case "knowledge_note.moved":
            return typeof after.path === "string" ? `to ${after.path}` : "to the top level";
        case "approval.approved":
        case "approval.rejected":
        case "approval.dismissed":
            return typeof meta.count === "number" && meta.count > 1 ? `(${meta.count} tasks)` : null;
        default:
            return null;
    }
}

/**
 * The parts of "<Actor> <verb> <noun> <label> <detail>", e.g. "Ana moved task
 * Fix login to Review". `names` resolves ids in the payload (assignees).
 */
export function describeAuditEntry(entry: AuditEntryInput, names: Readonly<Record<string, string>> = {}): AuditSentence {
    const meta = entry.payload.meta ?? {};
    const after = entry.payload.after ?? {};
    const before = entry.payload.before ?? {};
    const actor = entry.actorName
        ?? (entry.actorType === "agent" ? "An agent" : entry.actorType === "human" ? "Someone" : "System");
    const verb = VERBS[entry.action] ?? fallbackVerb(entry.action);
    const sentenceNamesTarget = entry.targetType === "company" || entry.targetType === "organization";
    const label = sentenceNamesTarget ? null : pickLabel(meta, after, before);
    const noun = sentenceNamesTarget ? "" : TARGET_NOUNS[entry.targetType] ?? entry.targetType.replace(/_/g, " ");
    return { actor, verb, noun, label: label ?? (sentenceNamesTarget ? null : "(untitled)"), detail: detailFor(entry.action, entry.payload, names) };
}

/** A label that redaction emptied ("[email]"); an older member row stored one. */
const PLACEHOLDER_LABEL_RE = /^(?:\[(?:link|email|secret|path)\]\s*)+$/;

function pickLabel(...sources: AuditFields[]): string | null {
    for (const source of sources) {
        for (const key of ["label", "name", "title", "email"]) {
            const value = source[key];
            if (typeof value === "string" && value && !PLACEHOLDER_LABEL_RE.test(value)) return value;
        }
    }
    return null;
}

/** The whole sentence as plain text (aria labels, tests). */
export function auditSentenceText(sentence: AuditSentence): string {
    return [sentence.actor, sentence.verb, sentence.noun, sentence.label, sentence.detail].filter(Boolean).join(" ");
}

/** Where the target opens in the app; null when it has no page (or is gone). */
export function auditTargetHref(targetType: string, targetId: string, payload: AuditPayload): string | null {
    const after = payload.after ?? {};
    const meta = payload.meta ?? {};
    switch (targetType) {
        case "task": return taskHref(targetId);
        case "agent": return `/agents?agent=${encodeURIComponent(targetId)}`;
        case "project": return `/projects?project=${encodeURIComponent(targetId)}`;
        case "customer": return "/customers";
        case "knowledge_note": return `/resources?resource=${encodeURIComponent(targetId)}`;
        case "approval": {
            const taskIds = Array.isArray(after.taskIds) ? after.taskIds : Array.isArray(meta.taskIds) ? meta.taskIds : [];
            return typeof taskIds[0] === "string" ? taskHref(taskIds[0]) : "/approvals";
        }
        case "member":
        case "invitation": return "/settings/members";
        case "organization": return "/agents/organization";
        case "pricing": return "/costs?tab=budgets";
        case "view": return `/views/${encodeURIComponent(targetId)}`;
        default: return null;
    }
}

/** Human labels for the fields a diff popover lists. */
export const AUDIT_FIELD_LABELS: Record<string, string> = {
    name: "Name", role: "Role", provider: "Runtime", deploymentMode: "Deployment", llmProvider: "LLM provider",
    llmModel: "Model", llmEndpointHost: "Model endpoint", llmKeyChanged: "API key replaced", concurrencyLimit: "Concurrency", monthlyBudgetCents: "Monthly budget", budgetStatus: "Budget state",
    scopeMode: "Scope", scopeCustomerIds: "Customers", scopeProjectIds: "Projects", scopeAgentIds: "Agents",
    title: "Title", state: "State", priority: "Priority", assigneeType: "Assignee type", assigneeId: "Assignee",
    status: "Status", instanceRole: "Instance role", email: "Email", directChatMode: "Direct chat mode",
    customerId: "Customer", leadAgentId: "Lead agent", requireApprovalForDone: "Approval before done",
    maxActiveAgents: "Max active agents", path: "Folder", archived: "Archived", timezone: "Timezone",
    nodeCount: "Chart nodes", teamCount: "Teams", leaderKind: "Leader type", leaderId: "Leader",
    model: "Model", inputPricePer1k: "Input price", outputPricePer1k: "Output price", active: "Active",
    scopeType: "Scope", scopeId: "Scope", panelCount: "Panels", version: "Version", pinnedToHome: "Pinned to Home",
    actionKey: "Action", permission: "Permission",
    customersModule: "Customers module", automationsModule: "Automations module", timelineModule: "Timeline module", costsModule: "Costs module",
    approvalsModule: "Approval history module", viewsModule: "Views module", displaysModule: "Display screens module", template: "Template",
};

/** One value of a diff, as text. Lists of ids collapse to a count. */
export function formatAuditValue(key: string, value: unknown, names: Readonly<Record<string, string>> = {}): string {
    if (value === null || value === undefined) return key === "scopeAgentIds" ? "all" : key === "permission" ? "default" : "none";
    if (key === "permission") return permissionWord(value);
    if (key === "actionKey" && typeof value === "string") return actionLabel(value);
    if (Array.isArray(value)) {
        if (value.length === 0) return "none";
        const named = value.map((v) => (typeof v === "string" ? names[v] : undefined)).filter(Boolean);
        return named.length === value.length && value.length <= 4 ? named.join(", ") : `${value.length} selected`;
    }
    if (key === "monthlyBudgetCents" && typeof value === "number") return value > 0 ? formatCents(value) : "no limit";
    // Model prices are stored as cents per 1M tokens.
    if ((key === "inputPricePer1k" || key === "outputPricePer1k") && typeof value === "number") return `${formatCents(value)} per 1M tokens`;
    if (key === "state" && typeof value === "string") return STATE_LABELS[value] ?? value;
    if (key.endsWith("Module") && typeof value === "boolean") return value ? "on" : "off";
    if (typeof value === "boolean") return value ? "yes" : "no";
    if (typeof value === "string" && UUID_RE.test(value)) return names[value] ?? "(removed)";
    return String(value);
}
