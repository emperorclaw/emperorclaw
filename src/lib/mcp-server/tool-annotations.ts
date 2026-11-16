// MCP tool annotations (spec 2025-03-26+): hints a client uses to decide which
// calls need the user's approval. Codex auto-runs a tool marked
// `readOnlyHint: true` and asks before (or, non-interactively, cancels) any
// other call, so a tool without annotations is treated as an unvetted write.
// Claude Code and claude.ai use the same hints to group read and write tools.
//
// Every tool registered in ./tools must appear here (tests/unit/mcp-tool-annotations.test.ts).
// They are hints, not permissions: the action-policy gate in ./index.ts still decides.

export type ToolAnnotations = {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
};

const READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
/** Adds something new (a task, a message, a note) and changes nothing that exists. */
const ADD: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
/** Overwrites, archives or removes what exists. */
const CHANGE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const CHANGE_IDEMPOTENT: ToolAnnotations = { ...CHANGE, idempotentHint: true };

export const TOOL_ANNOTATIONS: Readonly<Record<string, ToolAnnotations>> = {
    // Reads.
    get_agent: READ,
    get_agent_health: READ,
    get_agent_request: READ,
    get_emperor_manual: READ,
    get_group: READ,
    get_knowledge_context: READ,
    get_knowledge_note: READ,
    get_organization: READ,
    get_project: READ,
    get_task: READ,
    get_task_overview: READ,
    get_view: READ,
    list_agents: READ,
    list_automations: READ,
    list_groups: READ,
    list_knowledge: READ,
    list_knowledge_folders: READ,
    list_objectives: READ,
    list_pending_approvals: READ,
    list_projects: READ,
    list_storage_files: READ,
    list_tasks: READ,
    list_threads: READ,
    list_views: READ,
    read_thread: READ,
    search_knowledge: READ,
    wait_for_reply: READ,

    // Additive writes.
    add_group_members: ADD,
    add_task_note: ADD,
    // May open an approval request for the operator.
    check_action: ADD,
    claim_task: ADD,
    create_agent: ADD,
    create_group: ADD,
    create_knowledge_note: ADD,
    create_project: ADD,
    create_task: ADD,
    create_view: ADD,
    request_approval: ADD,
    send_agent_request: ADD,
    send_message: ADD,

    // Overwrites, archives, removals, decisions.
    archive_group: CHANGE_IDEMPOTENT,
    archive_view: CHANGE_IDEMPOTENT,
    decide_approval: CHANGE,
    remove_group_member: CHANGE_IDEMPOTENT,
    update_agent: CHANGE_IDEMPOTENT,
    update_group: CHANGE_IDEMPOTENT,
    update_knowledge_note: CHANGE_IDEMPOTENT,
    update_objective: CHANGE_IDEMPOTENT,
    update_panel: CHANGE_IDEMPOTENT,
    update_project: CHANGE_IDEMPOTENT,
    update_task: CHANGE_IDEMPOTENT,
    update_view: CHANGE_IDEMPOTENT,
    // Runs an automation, whose steps can reach outside Emperor.
    run_automation: { ...CHANGE, openWorldHint: true },
};

type Registrar = { registerTool: (...args: unknown[]) => unknown };

/**
 * Give every tool registered from now on its annotations (a tool's own
 * `annotations` win, key by key). A tool missing from TOOL_ANNOTATIONS is
 * registered as is, so the spec's defaults (a possibly destructive write) apply.
 */
export function annotateTools(server: Registrar) {
    const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
    server.registerTool = (name: unknown, config: unknown, ...rest: unknown[]) => {
        const hints = typeof name === "string" ? TOOL_ANNOTATIONS[name] : undefined;
        if (!hints || !config || typeof config !== "object") return register(name, config, ...rest);
        const own = (config as { annotations?: Record<string, unknown> }).annotations;
        return register(name, { ...config, annotations: { ...hints, ...own } }, ...rest);
    };
}
