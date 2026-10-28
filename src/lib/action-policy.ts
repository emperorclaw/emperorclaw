// Agent action permissions: for each action an agent can take, "off",
// "ask" (a person approves each call first) or "allowed".
//
// Pure and client-safe (no DB or Node imports): the catalog and resolution
// rules are shared by the server enforcement (lib/action-policy-server.ts),
// the REST/MCP gate and the agent panel's Actions tab.
//
// Unit-tested in tests/unit/action-policy.test.ts.

export const ACTION_MODES = ["off", "ask", "allowed"] as const;
export type ActionMode = (typeof ACTION_MODES)[number];

/** Stored maps: { actionKey: mode }. A key left out falls back to the next level. */
export type ActionPolicyMap = Partial<Record<string, ActionMode>>;

export type ActionGroup = "emperor" | "external";

export type ActionCatalogEntry = {
    key: string;
    label: string;
    group: ActionGroup;
    /** The built-in default when neither the agent nor the company sets one. */
    defaultMode: ActionMode;
};

/**
 * Emperor tools that change something. The key is the MCP tool name; reads
 * (list_*, get_*, search_*) are always allowed and so are not listed, and
 * neither are request_approval and check_action, which are how an agent asks.
 */
const EMPEROR_ACTIONS: readonly ActionCatalogEntry[] = [
    // Replies to a message the agent was sent are always delivered (lib/action-policy-server.ts).
    { key: "send_message", label: "Send chat messages (not replies)" },
    { key: "create_task", label: "Create tasks" },
    { key: "update_task", label: "Update tasks" },
    { key: "add_task_note", label: "Add task notes" },
    { key: "claim_task", label: "Claim tasks" },
    { key: "create_project", label: "Create projects" },
    { key: "update_project", label: "Update projects" },
    { key: "create_knowledge_note", label: "Create knowledge notes" },
    { key: "update_knowledge_note", label: "Edit knowledge notes" },
    { key: "create_agent", label: "Hire agents" },
    { key: "update_agent", label: "Update agents" },
    { key: "create_group", label: "Create group chats" },
    { key: "update_group", label: "Edit group chats" },
    { key: "add_group_members", label: "Add group members" },
    { key: "remove_group_member", label: "Remove group members" },
    { key: "archive_group", label: "Archive group chats" },
    { key: "update_objective", label: "Set its objective" },
    { key: "create_view", label: "Create views" },
    { key: "update_view", label: "Edit views" },
    { key: "update_panel", label: "Update view panels" },
    { key: "archive_view", label: "Archive views" },
    { key: "send_agent_request", label: "Hand work to other agents" },
].map((entry) => ({ ...entry, group: "emperor" as const, defaultMode: "allowed" as const }));

/**
 * Things an agent does outside Emperor with its own tools (email, terminal,
 * browser...). Emperor cannot see those calls, so the agent checks first with
 * the check_action tool. Risky categories default to "ask".
 */
const EXTERNAL_ACTIONS: readonly ActionCatalogEntry[] = [
    { key: "send_email", label: "Send email", defaultMode: "ask" },
    { key: "post_social", label: "Post on social media", defaultMode: "ask" },
    { key: "spend_money", label: "Spend money or buy things", defaultMode: "ask" },
    { key: "delete_data", label: "Delete data or files", defaultMode: "ask" },
    { key: "deploy", label: "Deploy or release to production", defaultMode: "ask" },
    { key: "browse_web", label: "Browse the web", defaultMode: "allowed" },
    { key: "run_shell", label: "Run shell commands", defaultMode: "allowed" },
].map((entry) => ({ ...entry, group: "external" as const, defaultMode: entry.defaultMode as ActionMode }));

export const ACTION_CATALOG: readonly ActionCatalogEntry[] = [...EXTERNAL_ACTIONS, ...EMPEROR_ACTIONS];
export const EXTERNAL_ACTION_KEYS = EXTERNAL_ACTIONS.map((entry) => entry.key) as readonly string[];

const CATALOG_BY_KEY = new Map(ACTION_CATALOG.map((entry) => [entry.key, entry]));

export function actionCatalogEntry(key: string): ActionCatalogEntry | null {
    return CATALOG_BY_KEY.get(key) ?? null;
}

export function isActionKey(key: unknown): key is string {
    return typeof key === "string" && CATALOG_BY_KEY.has(key);
}

export function isActionMode(value: unknown): value is ActionMode {
    return typeof value === "string" && (ACTION_MODES as readonly string[]).includes(value);
}

export function actionLabel(key: string): string {
    return actionCatalogEntry(key)?.label ?? key.replace(/_/g, " ");
}

/** A stored map with unknown keys and invalid modes dropped. */
export function normalizePolicyMap(raw: unknown): ActionPolicyMap {
    const out: ActionPolicyMap = {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
    for (const [key, mode] of Object.entries(raw as Record<string, unknown>)) {
        if (isActionKey(key) && isActionMode(mode)) out[key] = mode;
    }
    return out;
}

export type ResolvedActionMode = { mode: ActionMode; source: "agent" | "company" | "default" | "unlisted" };

/**
 * The mode that applies to one action: the agent's own setting, else the
 * company default, else the built-in default. An action that is not in the
 * catalog (a read, or an unknown key) is not governed: "allowed".
 */
export function resolveActionMode(key: string, agentMap: unknown, companyMap: unknown): ResolvedActionMode {
    const entry = actionCatalogEntry(key);
    if (!entry) return { mode: "allowed", source: "unlisted" };
    const agentMode = normalizePolicyMap(agentMap)[key];
    if (agentMode) return { mode: agentMode, source: "agent" };
    const companyMode = normalizePolicyMap(companyMap)[key];
    if (companyMode) return { mode: companyMode, source: "company" };
    return { mode: entry.defaultMode, source: "default" };
}

/**
 * Apply a change request ({ key: mode | null }) to a stored map. null removes
 * the key (back to the next level). Unknown keys or modes are an error, so a
 * typo never silently does nothing.
 */
export function applyPolicyChanges(current: unknown, changes: unknown): { map: ActionPolicyMap } | { error: string } {
    if (!changes || typeof changes !== "object" || Array.isArray(changes)) return { error: "policies must be an object of { action: mode }" };
    const map = normalizePolicyMap(current);
    for (const [key, mode] of Object.entries(changes as Record<string, unknown>)) {
        if (!isActionKey(key)) return { error: `Unknown action: ${key}` };
        if (mode === null) delete map[key];
        else if (isActionMode(mode)) map[key] = mode;
        else return { error: `Mode for ${key} must be off, ask, allowed or null` };
    }
    return { map };
}

/** The keys whose stored setting differs between two maps, with both sides ("" = not set). */
export function changedPolicyKeys(before: ActionPolicyMap, after: ActionPolicyMap): { key: string; before: ActionMode | null; after: ActionMode | null }[] {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys
        .filter((key) => (before[key] ?? null) !== (after[key] ?? null))
        .map((key) => ({ key, before: before[key] ?? null, after: after[key] ?? null }));
}

// ─── Who acts ───────────────────────────────────────────────────────────────

/**
 * MCP tools whose `agentId` argument names the agent the call acts as (for an
 * operator connection). Every other governed tool's `agentId` is a target
 * (update_agent's subject, say), never the actor.
 */
export const MCP_ACTOR_ARG_TOOLS: ReadonlySet<string> = new Set(["send_message", "add_task_note", "claim_task", "create_group", "update_objective"]);

// ─── REST routes that are Emperor actions ──────────────────────────────────

/**
 * Where a REST route reads the agent it acts as, for a company-wide token
 * (a bound token always acts as its own agent). Mirrors each route exactly,
 * so the gate never judges a different agent than the route then acts as.
 */
export type RestActorSource = "body" | "query" | "sender" | "send" | "claim" | "none";

/**
 * Agent-facing REST endpoints (under /api/mcp) that perform a governed
 * Emperor action, mapped to the same key as the MCP tool. One table, read by
 * the single REST gate in verifyMcpToken (lib/mcp.ts). Routes not listed are
 * not governed (reads, deletes of tasks and files, uploads...).
 */
const REST_ACTION_ROUTES: readonly { method: string; pattern: RegExp; key: string; actor: RestActorSource }[] = [
    { method: "POST", pattern: /^\/api\/mcp\/messages\/send$/, key: "send_message", actor: "send" },
    { method: "POST", pattern: /^\/api\/mcp\/threads\/[^/]+\/messages$/, key: "send_message", actor: "sender" },
    { method: "POST", pattern: /^\/api\/mcp\/tasks$/, key: "create_task", actor: "body" },
    { method: "POST", pattern: /^\/api\/mcp\/tasks\/generate$/, key: "create_task", actor: "body" },
    { method: "PATCH", pattern: /^\/api\/mcp\/tasks\/(?!claim$|generate$|overview$)[^/]+$/, key: "update_task", actor: "body" },
    { method: "POST", pattern: /^\/api\/mcp\/tasks\/[^/]+\/assign$/, key: "update_task", actor: "claim" },
    { method: "POST", pattern: /^\/api\/mcp\/tasks\/[^/]+\/result$/, key: "update_task", actor: "body" },
    { method: "POST", pattern: /^\/api\/mcp\/tasks\/[^/]+\/notes$/, key: "add_task_note", actor: "body" },
    { method: "POST", pattern: /^\/api\/mcp\/tasks\/claim$/, key: "claim_task", actor: "body" },
    { method: "POST", pattern: /^\/api\/mcp\/projects$/, key: "create_project", actor: "body" },
    { method: "PATCH", pattern: /^\/api\/mcp\/projects\/[^/]+$/, key: "update_project", actor: "body" },
    // Knowledge notes are "resources" in the REST API.
    { method: "POST", pattern: /^\/api\/mcp\/resources$/, key: "create_knowledge_note", actor: "body" },
    { method: "PATCH", pattern: /^\/api\/mcp\/resources\/(?!context$|proposals$)[^/]+$/, key: "update_knowledge_note", actor: "body" },
    { method: "POST", pattern: /^\/api\/mcp\/agents$/, key: "create_agent", actor: "none" },
    { method: "PATCH", pattern: /^\/api\/mcp\/agents\/[^/]+$/, key: "update_agent", actor: "none" },
    { method: "POST", pattern: /^\/api\/mcp\/groups$/, key: "create_group", actor: "body" },
    { method: "PATCH", pattern: /^\/api\/mcp\/groups\/[^/]+$/, key: "update_group", actor: "body" },
    { method: "DELETE", pattern: /^\/api\/mcp\/groups\/[^/]+$/, key: "archive_group", actor: "body" },
    { method: "POST", pattern: /^\/api\/mcp\/groups\/[^/]+\/members$/, key: "add_group_members", actor: "body" },
    { method: "DELETE", pattern: /^\/api\/mcp\/groups\/[^/]+\/members$/, key: "remove_group_member", actor: "body" },
    { method: "POST", pattern: /^\/api\/mcp\/objectives$/, key: "update_objective", actor: "query" },
    { method: "POST", pattern: /^\/api\/mcp\/views$/, key: "create_view", actor: "query" },
    { method: "PATCH", pattern: /^\/api\/mcp\/views\/[^/]+$/, key: "update_view", actor: "query" },
    { method: "PUT", pattern: /^\/api\/mcp\/views\/[^/]+\/panels\/[^/]+$/, key: "update_panel", actor: "query" },
    { method: "POST", pattern: /^\/api\/mcp\/views\/[^/]+\/archive$/, key: "archive_view", actor: "query" },
    // The body's agent is the recipient; the caller is an operator or another platform.
    { method: "POST", pattern: /^\/api\/mcp\/requests$/, key: "send_agent_request", actor: "none" },
];

/** The governed action a REST request performs and where its actor is named, or null (not governed). */
export function restActionForRequest(method: string, pathname: string): { key: string; actor: RestActorSource } | null {
    const upper = method.toUpperCase();
    const path = pathname.replace(/\/+$/, "");
    const route = REST_ACTION_ROUTES.find((r) => r.method === upper && r.pattern.test(path));
    return route ? { key: route.key, actor: route.actor } : null;
}

export function actionKeyForRestRequest(method: string, pathname: string): string | null {
    return restActionForRequest(method, pathname)?.key ?? null;
}

/** The agent reference a company-wide token's request names, read the way its route reads it. */
export function restActorRef(source: RestActorSource, query: URLSearchParams | null, body: Record<string, unknown> | null): string | null {
    const str = (value: unknown) => (typeof value === "string" && value.trim() ? value : null);
    switch (source) {
        case "body": return str(body?.agentId);
        // POST /messages/send posts as from_user_id first, then agentId (lib/openclaw/messaging.ts).
        case "send": return str(body?.from_user_id) ?? str(body?.agentId);
        case "query": return str(query?.get("agentId"));
        // POST /threads/{id}/messages posts as senderId when senderType is "agent" (the default).
        case "sender": return (body?.senderType ?? "agent") === "agent" ? str(body?.senderId) : null;
        // POST /tasks/{id}/assign acts as agentId only in claim mode; otherwise agentId is the assignee.
        case "claim": return body?.mode === "claim" ? str(body?.agentId) : null;
        case "none": return null;
    }
}
