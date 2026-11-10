// Approval routing: who decides an agent's ask (docs/design/approval-routing.md).
//
// Pure and client-safe (no DB or Node imports): the settings shapes, the
// approver-chain resolver, the agent-authority rule and the "who may decide"
// rule. The server side (lib/approval-routing-server.ts) loads the org chart,
// the permissions and the members, and calls these.
//
// Unit-tested in tests/unit/approval-routing.test.ts.

import type { ActionMode } from "./action-policy";

// ─── Settings ───────────────────────────────────────────────────────────────

/** Who approves an agent's (or a team's) asks. "auto" = follow the org chart. */
export type ApproverSetting =
    | { mode: "auto" }
    | { mode: "agent"; agentId: string }
    | { mode: "people"; userIds: string[] };

/** companies.approval_settings_json. */
export type CompanyApprovalSettings = {
    /** Minutes the current approver has before the ask moves up the chain. */
    escalateAfterMinutes?: number;
    /** Approvers per org chart team (keyed by the team's group id). */
    teamApprovers?: Record<string, ApproverSetting>;
};

export const DEFAULT_ESCALATE_AFTER_MINUTES = 30;
export const MIN_ESCALATE_AFTER_MINUTES = 5;
/** A day: past that an ask waits on people who are not answering; the 48h expiry still applies. */
export const MAX_ESCALATE_AFTER_MINUTES = 24 * 60;
/** At most this many people per approver setting. */
export const MAX_APPROVER_PEOPLE = 20;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUTO: ApproverSetting = { mode: "auto" };

/** A stored setting as the app reads it, never throwing: anything malformed is "auto". */
export function normalizeApproverSetting(raw: unknown): ApproverSetting {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return AUTO;
    const value = raw as Record<string, unknown>;
    if (value.mode === "agent" && typeof value.agentId === "string" && UUID_RE.test(value.agentId)) return { mode: "agent", agentId: value.agentId };
    if (value.mode === "people" && Array.isArray(value.userIds)) {
        const userIds = [...new Set(value.userIds.filter((id): id is string => typeof id === "string" && UUID_RE.test(id)))].slice(0, MAX_APPROVER_PEOPLE);
        if (userIds.length) return { mode: "people", userIds };
    }
    return AUTO;
}

/** A setting sent by the UI, checked strictly (a typo is an error, never silently "auto"). */
export function parseApproverSetting(raw: unknown): { setting: ApproverSetting } | { error: string } {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "approvers must be an object" };
    const value = raw as Record<string, unknown>;
    if (value.mode === "auto") return { setting: AUTO };
    if (value.mode === "agent") {
        if (typeof value.agentId !== "string" || !UUID_RE.test(value.agentId)) return { error: "Choose the agent who approves" };
        return { setting: { mode: "agent", agentId: value.agentId } };
    }
    if (value.mode === "people") {
        if (!Array.isArray(value.userIds) || value.userIds.length === 0) return { error: "Choose at least one person who approves" };
        if (value.userIds.length > MAX_APPROVER_PEOPLE) return { error: `Choose at most ${MAX_APPROVER_PEOPLE} people` };
        if (value.userIds.some((id) => typeof id !== "string" || !UUID_RE.test(id))) return { error: "Invalid person" };
        return { setting: { mode: "people", userIds: [...new Set(value.userIds as string[])] } };
    }
    return { error: "mode must be auto, agent or people" };
}

/**
 * The stored escalation time, read the one way both JS and SQL read it
 * (lib/approvals.ts escalateStaleApprovals mirrors this in SQL): digits only,
 * clamped to [MIN, MAX]; anything else is the default.
 */
export const ESCALATE_MINUTES_PATTERN = "^[0-9]{1,5}$";
export function clampEscalateAfterMinutes(raw: unknown): number {
    const text = typeof raw === "number" || typeof raw === "string" ? String(raw) : "";
    if (!new RegExp(ESCALATE_MINUTES_PATTERN).test(text)) return DEFAULT_ESCALATE_AFTER_MINUTES;
    return Math.max(MIN_ESCALATE_AFTER_MINUTES, Math.min(MAX_ESCALATE_AFTER_MINUTES, Number(text)));
}

/** The stored company settings, normalized. */
export function normalizeCompanyApprovalSettings(raw: unknown): Required<CompanyApprovalSettings> {
    const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const teamApprovers: Record<string, ApproverSetting> = {};
    if (value.teamApprovers && typeof value.teamApprovers === "object" && !Array.isArray(value.teamApprovers)) {
        for (const [teamId, setting] of Object.entries(value.teamApprovers as Record<string, unknown>)) {
            const normalized = normalizeApproverSetting(setting);
            if (UUID_RE.test(teamId) && normalized.mode !== "auto") teamApprovers[teamId] = normalized;
        }
    }
    return {
        escalateAfterMinutes: clampEscalateAfterMinutes(value.escalateAfterMinutes),
        teamApprovers,
    };
}

/** What the approver pickers offer: live agents, and members who may decide. */
export type ApproverOptions = { agents: { id: string; name: string }[]; people: { id: string; name: string }[] };

/**
 * A saved setting against today's options: approvers who left (removed
 * members, deleted agents) are dropped, so the form can be saved again.
 * `cleared` says something was dropped (the UI says so).
 */
export function sanitizeApproverSetting(value: ApproverSetting, options: ApproverOptions | null): { value: ApproverSetting; cleared: boolean } {
    if (!options) return { value, cleared: false };
    if (value.mode === "agent") {
        return options.agents.some((agent) => agent.id === value.agentId) ? { value, cleared: false } : { value: { mode: "auto" }, cleared: true };
    }
    if (value.mode === "people") {
        const userIds = value.userIds.filter((id) => options.people.some((person) => person.id === id));
        if (userIds.length === value.userIds.length) return { value, cleared: false };
        return { value: userIds.length ? { mode: "people", userIds } : { mode: "auto" }, cleared: true };
    }
    return { value, cleared: false };
}

/** A timeout sent by the UI: a whole number of minutes in range, else an error. */
export function parseEscalateAfterMinutes(raw: unknown): { minutes: number } | { error: string } {
    const minutes = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
    if (!Number.isInteger(minutes) || minutes < MIN_ESCALATE_AFTER_MINUTES || minutes > MAX_ESCALATE_AFTER_MINUTES) {
        return { error: `The escalation time must be a whole number of minutes from ${MIN_ESCALATE_AFTER_MINUTES} to ${MAX_ESCALATE_AFTER_MINUTES}` };
    }
    return { minutes };
}

// ─── The chain ──────────────────────────────────────────────────────────────

/** Where a step of the chain came from (shown in the settings and the audit). */
export type ApproverSource = "agent_setting" | "team_setting" | "org_chart" | "agent_owner" | "fallback";

/** One step of an approval's approver chain. The last step is always "admins". */
export type ApproverStep =
    | { kind: "agent"; agentId: string; source: ApproverSource }
    | { kind: "users"; userIds: string[]; source: ApproverSource }
    | { kind: "admins"; source: "fallback" };

export type ChartRef = { kind: "agent" | "human"; id: string };

/**
 * The org chart as the resolver needs it. `managerOf` is the manager for this
 * piece of work (the line in the work's team, else the first line: the same
 * rule as chartManagerForTask); `managersOf` is every reporting line, for
 * "is X above Y".
 */
export type ChartLookup = {
    managerOf: (agentId: string) => ChartRef | null;
    managersOf: (agentId: string) => ChartRef[];
};

/** Every agent above `agentId` on any reporting line, transitively. Cycle-safe; never includes the agent itself. */
export function agentsAbove(agentId: string, chart: ChartLookup): Set<string> {
    const above = new Set<string>();
    const queue = [agentId];
    const seen = new Set<string>([agentId]);
    while (queue.length) {
        const current = queue.shift()!;
        for (const manager of chart.managersOf(current)) {
            if (manager.kind !== "agent" || seen.has(manager.id)) continue;
            seen.add(manager.id);
            above.add(manager.id);
            queue.push(manager.id);
        }
    }
    above.delete(agentId);
    return above;
}

export type AuthorityRefusal = "self" | "cycle" | "not_above" | "inactive" | "action_not_allowed" | "no_project_access" | "unknown_action";
export type AgentAuthority = { ok: true } | { ok: false; reason: AuthorityRefusal };

/**
 * May this agent decide this ask? All of:
 * - it is not the requester (no self-approval);
 * - chart-derived: it is above the requester in the chain of command, and the
 *   requester is not above it (a peer, a subordinate or a reporting loop never
 *   qualifies). Explicit (an owner or admin named it as the approver of this
 *   agent or its team): that choice is the grant, so no chart position is
 *   needed, but a direct mutual pair (each the other's explicit approver) is
 *   refused as a cycle;
 * - it is a live agent;
 * - for an action (an ask-first permission, or a send/spend/publish/delete/
 *   deploy ask), its OWN effective permission for that action is "allowed":
 *   a boss may approve only what it may do itself;
 * - for an ask about a project's tasks, it may use that project.
 * `actionMode` null: no governed action. `projectAccess` null: no project.
 */
export function mayAgentApprove(input: {
    approverAgentId: string;
    requesterAgentId: string | null;
    /** agentsAbove(requester). */
    requesterAbove: ReadonlySet<string>;
    /** agentsAbove(approver). */
    approverAbove: ReadonlySet<string>;
    approverLive: boolean;
    /** Named explicitly (agent or team setting) rather than found on the chart. */
    explicit?: boolean;
    /** Explicit only: the approver's own explicit approver is the requester. */
    mutualExplicit?: boolean;
    /** null: no governed action (plain task_done). "unknown": an action no agent may decide (fail closed). */
    actionMode: ActionMode | null | "unknown";
    projectAccess: boolean | null;
}): AgentAuthority {
    const { approverAgentId, requesterAgentId } = input;
    if (!requesterAgentId || approverAgentId === requesterAgentId) return { ok: false, reason: "self" };
    if (input.explicit) {
        if (input.mutualExplicit) return { ok: false, reason: "cycle" };
    } else {
        if (input.approverAbove.has(requesterAgentId)) {
            return { ok: false, reason: input.requesterAbove.has(approverAgentId) ? "cycle" : "not_above" };
        }
        if (!input.requesterAbove.has(approverAgentId)) return { ok: false, reason: "not_above" };
    }
    if (!input.approverLive) return { ok: false, reason: "inactive" };
    if (input.actionMode === "unknown") return { ok: false, reason: "unknown_action" };
    if (input.actionMode !== null && input.actionMode !== "allowed") return { ok: false, reason: "action_not_allowed" };
    if (input.projectAccess === false) return { ok: false, reason: "no_project_access" };
    return { ok: true };
}

/** Plain-language reason an agent was skipped or refused (agents and the settings read it). */
export function authorityRefusalText(reason: AuthorityRefusal): string {
    switch (reason) {
        case "self": return "an agent never approves its own request";
        case "cycle": return "the org chart has a reporting loop between them";
        case "not_above": return "it is not above the requester in the org chart";
        case "inactive": return "it is not an active agent";
        case "action_not_allowed": return "it is not allowed to do this action itself";
        case "no_project_access": return "it cannot use this project";
        case "unknown_action": return "only a person can approve this kind of action";
    }
}

/**
 * Aliases request_approval callers use for governed actions. A boss agent
 * may decide such an ask only when it may do the action itself.
 */
const TASK_ACTION_KEYS: Record<string, string> = {
    send_email: "send_email",
    email: "send_email",
    publish: "post_social",
    post_social: "post_social",
    spend: "spend_money",
    spend_money: "spend_money",
    delete: "delete_data",
    delete_data: "delete_data",
    deploy: "deploy",
    release: "deploy",
};

/** "Send Email", "send-email" → "send_email". */
export function normalizeActionType(actionType: string): string {
    return actionType.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/**
 * What an agent approver needs to be allowed to do for this ask:
 * - `{ key: null }`: nothing beyond the chart and the project (only the plain
 *   `task_done` close of a task);
 * - `{ key }`: that governed action must be "allowed" for the approver itself;
 * - `"unknown"`: an action Emperor cannot classify; no agent may decide it
 *   (fail closed), so it goes to people.
 * `isKnownKey` is the action catalog (lib/action-policy.ts isActionKey).
 */
export function approvalActionKey(approval: { actionType: string }, isActionAsk: boolean, isKnownKey: (key: string) => boolean): { key: string | null } | "unknown" {
    if (isActionAsk) return isKnownKey(approval.actionType) ? { key: approval.actionType } : "unknown";
    const type = normalizeActionType(approval.actionType);
    if (type === "task_done") return { key: null };
    const key = TASK_ACTION_KEYS[type] ?? (isKnownKey(type) ? type : null);
    return key ? { key } : "unknown";
}

export type ResolveChainInput = {
    requesterAgentId: string;
    /** a. The agent's own setting. */
    agentSetting: ApproverSetting;
    /** b. Its team's setting (the team of this work), or null. */
    teamSetting: ApproverSetting | null;
    chart: ChartLookup;
    /** The authority rule for one candidate agent (mayAgentApprove, preloaded); `explicit` for a named approver. */
    authority: (agentId: string, explicit: boolean) => AgentAuthority;
    /** d. agents.owner_user_id. */
    ownerUserId: string | null;
    /**
     * People who may approve this ask: current members with the member role
     * or above (never viewers) who can see it (a restricted member outside
     * its project or agent is not). Anyone else is dropped from the chain.
     */
    memberUserIds: ReadonlySet<string>;
};

export type ResolvedChain = {
    steps: ApproverStep[];
    /** Agents passed over, and why (shown in the settings, kept in the audit). */
    skipped: { agentId: string; reason: AuthorityRefusal | "cycle" }[];
};

/**
 * Resolve who decides an agent's ask, first match wins:
 *   a. approvers set on the agent;
 *   b. approvers set on its team;
 *   c. its manager in the org chart (agent or person);
 *   d. its owner;
 *   e. company owners and admins (always the last step).
 * An agent approver that lacks authority (mayAgentApprove) is skipped and the
 * walk goes on up that agent's chain; a person ends the agent part of the
 * chain. Escalation moves along the returned steps.
 */
export function resolveApproverChain(input: ResolveChainInput): ResolvedChain {
    const steps: ApproverStep[] = [];
    const skipped: ResolvedChain["skipped"] = [];
    const members = (ids: readonly string[]) => [...new Set(ids)].filter((id) => input.memberUserIds.has(id));
    const hasAgentStep = (agentId: string) => steps.some((step) => step.kind === "agent" && step.agentId === agentId);
    const noteSkip = (agentId: string, reason: ResolvedChain["skipped"][number]["reason"]) => {
        if (!skipped.some((s) => s.agentId === agentId && s.reason === reason)) skipped.push({ agentId, reason });
    };

    /** Walk up from `start`: each qualifying agent is a step; a person ends the walk. Adds steps; returns whether it added any. */
    const climb = (start: ChartRef | null, source: ApproverSource, explicitStart = false): boolean => {
        const before = steps.length;
        // Per walk: a loop stops the walk; the requester is never an approver.
        const visited = new Set<string>([input.requesterAgentId]);
        let current = start;
        let explicit = explicitStart;
        while (current) {
            if (current.kind === "human") {
                const people = members([current.id]);
                if (people.length) steps.push({ kind: "users", userIds: people, source });
                break;
            }
            if (visited.has(current.id)) {
                noteSkip(current.id, current.id === input.requesterAgentId ? "self" : "cycle");
                break;
            }
            visited.add(current.id);
            const authority = input.authority(current.id, explicit);
            if (!authority.ok) noteSkip(current.id, authority.reason);
            // Only the named approver itself is explicit; the managers above it are chart-derived.
            else if (!hasAgentStep(current.id)) steps.push({ kind: "agent", agentId: current.id, source: explicit ? source : "org_chart" });
            current = input.chart.managerOf(current.id);
            explicit = false;
        }
        return steps.length > before;
    };

    /** A setting that adds no usable step (only the requester, nobody eligible) falls through to the next level. */
    const fromSetting = (setting: ApproverSetting | null, source: ApproverSource): boolean => {
        if (!setting || setting.mode === "auto") return false;
        if (setting.mode === "people") {
            const people = members(setting.userIds);
            if (!people.length) return false;
            steps.push({ kind: "users", userIds: people, source });
            return true;
        }
        return climb({ kind: "agent", id: setting.agentId }, source, true);
    };

    if (!fromSetting(input.agentSetting, "agent_setting") && !fromSetting(input.teamSetting, "team_setting")) {
        climb(input.chart.managerOf(input.requesterAgentId), "org_chart");
    }
    if (!steps.some((step) => step.kind === "users") && input.ownerUserId && input.memberUserIds.has(input.ownerUserId)) {
        steps.push({ kind: "users", userIds: [input.ownerUserId], source: "agent_owner" });
    }
    steps.push({ kind: "admins", source: "fallback" });
    return { steps, skipped };
}

// ─── Deciding ───────────────────────────────────────────────────────────────

/** The routing columns of an approval row. */
export type RoutedApproval = {
    approverKind: string | null;
    approverAgentId?: string | null;
    approverUserIds?: unknown;
    approverChainJson?: unknown;
    escalationLevel?: number | null;
};

/** The stored chain, read defensively. */
export function approverChainOf(approval: Pick<RoutedApproval, "approverChainJson">): ApproverStep[] {
    const raw = approval.approverChainJson;
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((step): ApproverStep[] => {
        if (!step || typeof step !== "object") return [];
        const s = step as Record<string, unknown>;
        const source = (typeof s.source === "string" ? s.source : "fallback") as ApproverSource;
        if (s.kind === "agent" && typeof s.agentId === "string") return [{ kind: "agent", agentId: s.agentId, source }];
        if (s.kind === "users" && Array.isArray(s.userIds)) return [{ kind: "users", userIds: s.userIds.filter((id): id is string => typeof id === "string"), source }];
        if (s.kind === "admins") return [{ kind: "admins", source: "fallback" }];
        return [];
    });
}

/** The steps that may decide now: the current one and every earlier one (escalation adds deciders, never removes them). */
export function activeApproverSteps(approval: RoutedApproval): ApproverStep[] {
    const chain = approverChainOf(approval);
    const level = Math.max(0, Math.min(approval.escalationLevel ?? 0, chain.length - 1));
    return chain.slice(0, level + 1);
}

/** The current step (the one notified and named as "waiting on"). */
export function currentApproverStep(approval: RoutedApproval): ApproverStep | null {
    const chain = approverChainOf(approval);
    if (!chain.length) return null;
    return chain[Math.max(0, Math.min(approval.escalationLevel ?? 0, chain.length - 1))];
}

/** The routing columns for a chain at a level. */
export function approverColumns(steps: readonly ApproverStep[], level: number): { approverKind: "agent" | "users" | "admins"; approverAgentId: string | null; approverUserIds: string[] | null; escalationLevel: number } {
    const step = steps[level] ?? { kind: "admins" as const, source: "fallback" as const };
    return {
        approverKind: step.kind,
        approverAgentId: step.kind === "agent" ? step.agentId : null,
        approverUserIds: step.kind === "users" ? [...step.userIds] : null,
        escalationLevel: level,
    };
}

/**
 * May this person decide this approval (beyond seeing it and having write
 * access, which lib/approval-access.ts checks)? Owners and admins always may
 * (override). An ask from before routing: anyone with access, as before.
 * Otherwise only the people named in the steps reached so far.
 */
export function humanMayDecide(approval: RoutedApproval, viewer: { userId: string; isOwnerOrAdmin: boolean }): boolean {
    if (viewer.isOwnerOrAdmin) return true;
    if (!approval.approverKind) return true;
    return activeApproverSteps(approval).some((step) => step.kind === "users" && step.userIds.includes(viewer.userId));
}

/** Is this approval waiting on this person (not merely decidable by them as an override)? */
export function isAssignedToHuman(approval: RoutedApproval, viewer: { userId: string; isOwnerOrAdmin: boolean }): boolean {
    if (!approval.approverKind) return true;
    return activeApproverSteps(approval).some((step) =>
        (step.kind === "users" && step.userIds.includes(viewer.userId)) || (step.kind === "admins" && viewer.isOwnerOrAdmin));
}

/** The agents that may decide now (decide_approval), before the authority re-check. */
/** Was this agent named explicitly (agent or team setting) in the stored chain? */
export function isExplicitAgentStep(approval: Pick<RoutedApproval, "approverChainJson">, agentId: string): boolean {
    return approverChainOf(approval).some((step) => step.kind === "agent" && step.agentId === agentId && (step.source === "agent_setting" || step.source === "team_setting"));
}

export function agentDeciders(approval: RoutedApproval): string[] {
    return activeApproverSteps(approval).flatMap((step) => step.kind === "agent" ? [step.agentId] : []);
}

/** The next step to escalate to, from `level` (skipping agents `qualifies` rejects), or null at the top. */
export function nextEscalationLevel(steps: readonly ApproverStep[], level: number, qualifies: (agentId: string) => boolean): number | null {
    for (let next = level + 1; next < steps.length; next += 1) {
        const step = steps[next];
        if (step.kind === "agent" && !qualifies(step.agentId)) continue;
        return next;
    }
    return null;
}

/**
 * Who an approval waits on, for the UI to phrase ("Waiting on: Architect (agent)").
 * "hidden": a viewer who may not decide it learns only that it waits on an approver.
 */
export type WaitingOn = { kind: "agent" | "users" | "admins" | "hidden"; names: string[] };

/**
 * The same for an agent: agent approvers by name, people never (an agent does
 * not learn who in the company approves what): "a person", "an owner or admin".
 */
export function waitingOnTextForAgent(step: ApproverStep | null, agentName: (id: string) => string): string {
    if (!step || step.kind === "admins") return "an owner or admin";
    if (step.kind === "agent") return `${agentName(step.agentId)} (agent)`;
    return "a person";
}

export function waitingOnParts(step: ApproverStep | null, names: { agent: (id: string) => string; person: (id: string) => string }): WaitingOn {
    if (!step || step.kind === "admins") return { kind: "admins", names: [] };
    if (step.kind === "agent") return { kind: "agent", names: [names.agent(step.agentId)] };
    return { kind: "users", names: step.userIds.map(names.person) };
}

/** "Architect (agent)", "Jose, Luis", "an owner or admin": who an approval waits on, in plain English (agents, API errors). */
export function waitingOnText(step: ApproverStep | null, names: { agent: (id: string) => string; person: (id: string) => string }): string {
    const parts = waitingOnParts(step, names);
    if (parts.kind === "admins") return "an owner or admin";
    if (parts.kind === "agent") return `${parts.names[0]} (agent)`;
    return parts.names.join(", ");
}

/** The settings' plain chain: "Architect → Jose → owners and admins". */
export function chainText(steps: readonly ApproverStep[], names: { agent: (id: string) => string; person: (id: string) => string }): string {
    return steps.map((step) => step.kind === "admins" ? "owners and admins" : step.kind === "agent" ? names.agent(step.agentId) : step.userIds.map(names.person).join(", ")).join(" → ");
}
