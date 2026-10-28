// Who may use an agent (0.20). Pure: no database, safe for client components.
// Mirrors lib/view-access.ts, so there is nothing new to learn:
//
// - 'everyone' (the default, and the behavior before 0.20): every member who
//   can see the agent through their member scope;
// - 'people': its owner plus the people on agent_access;
// - 'owner': only its owner. Such an agent also never sees more data than its
//   owner (lib/agent-scope.ts applies the owner's member scope as a ceiling).
//
// "Use" means: see it in lists, open and chat in its DMs and private chats,
// mention it, assign it tasks. Member scope stays the CEILING: a person uses an
// agent only when both their scope and the agent's access allow it.
//
// Owners and admins who may not use it get "metadata": name, owner, status,
// cost — never its DMs, private-chat threads or their messages. They can still
// change who can use it, transfer it or delete it, but never in a way that
// lets themselves in (the 0.19 view self-transfer rule). Agents themselves
// (bridges acting as the agent) are not subjects of this rule.

export const AGENT_ACCESS_MODES = ["everyone", "people", "owner"] as const;
export type AgentAccessMode = (typeof AGENT_ACCESS_MODES)[number];

export const AGENT_ACCESS_LABELS: Record<AgentAccessMode, string> = {
    everyone: "Everyone",
    people: "Specific people",
    owner: "Only its owner",
};

export type AgentUse = "full" | "metadata" | "none";

/** The person asking, reduced to what the rule needs. */
export type AgentAccessSubject = { userId: string; isAdmin: boolean };

/** The agent, reduced to what the rule needs. */
export type AgentAccessFacts = {
    access: string;
    ownerUserId: string | null;
    /** The people on agent_access (only consulted for 'people'). */
    people: readonly string[];
};

export function isAgentAccessMode(value: unknown): value is AgentAccessMode {
    return typeof value === "string" && (AGENT_ACCESS_MODES as readonly string[]).includes(value);
}

/** An unknown stored value fails closed to 'owner'. */
export function normalizeAgentAccess(value: unknown): AgentAccessMode {
    return isAgentAccessMode(value) ? value : "owner";
}

/**
 * The one rule. `inScope` is the member-scope ceiling (lib/member-scope.ts
 * memberMaySeeAgent), computed by the caller and checked first.
 */
export function agentUse(subject: AgentAccessSubject, agent: AgentAccessFacts, inScope: boolean): AgentUse {
    if (!inScope) return "none";
    const mode = normalizeAgentAccess(agent.access);
    if (mode === "everyone") return "full";
    if (agent.ownerUserId === subject.userId) return "full";
    if (mode === "people" && agent.people.includes(subject.userId)) return "full";
    return subject.isAdmin ? "metadata" : "none";
}

/** True when the agent is limited to some people (shows a lock badge). */
export function agentIsLimited(agent: { access: string }): boolean {
    return normalizeAgentAccess(agent.access) !== "everyone";
}

export type AgentAccessChange = { ok: true } | { ok: false; error: string; status: 400 | 403 };

/**
 * Whether `actor` may change an agent's access (mode, people, owner) from
 * `before` to `after`. Its owner may; an admin may, as long as the change does
 * not let themselves in when they could not use it before; nobody else.
 * An 'owner' or 'people' agent always needs an owner.
 *
 * Orphans: when the owner of a limited agent has left the company
 * (`ownerGone`), an admin may recover it any way they need (a new owner,
 * everyone, or themselves). Its history stays out of reach: the old owner's
 * private chats are archived and owner-bound, and the server archives the
 * agent's shared direct threads on such a recovery.
 */
export function agentAccessChangeAllowed(actor: AgentAccessSubject, before: AgentAccessFacts, after: AgentAccessFacts, options: { ownerGone?: boolean } = {}): AgentAccessChange {
    if (!isAgentAccessMode(after.access)) return { ok: false, error: "access must be everyone, people or owner", status: 400 };
    if (after.access !== "everyone" && !after.ownerUserId) return { ok: false, error: "An agent limited to some people needs an owner", status: 400 };
    const isOwner = before.ownerUserId !== null && before.ownerUserId === actor.userId;
    if (!isOwner && !actor.isAdmin) return { ok: false, error: "Only its owner, owners and admins can change who can use this agent", status: 403 };
    if (options.ownerGone && normalizeAgentAccess(before.access) !== "everyone") return { ok: true };
    if (!isOwner && agentUse(actor, before, true) !== "full" && agentUse(actor, after, true) === "full") {
        return { ok: false, error: "You can't give yourself access to an agent you can't use; ask its owner", status: 403 };
    }
    return { ok: true };
}

/** Text for the agent list: "Only Ana", "Ana + 2 people". */
export function agentAccessSummary(agent: { access: string; ownerName: string | null; peopleCount: number }): string {
    const owner = agent.ownerName ?? "its owner";
    const mode = normalizeAgentAccess(agent.access);
    if (mode === "everyone") return "Everyone";
    if (mode === "owner" || agent.peopleCount === 0) return `Only ${owner}`;
    return `${owner} + ${agent.peopleCount} ${agent.peopleCount === 1 ? "person" : "people"}`;
}
