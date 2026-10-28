// Who may read a view (0.19, "Views phase A"). Pure: no database, safe for
// client components. lib/views.ts gathers the facts (is the caller inside the
// view's scope? is it on the share list?) and every read path goes through
// viewAccess: pages, /api/views, the MCP tools and their REST twin, Home pins
// and the realtime announce.
//
// Two separate axes:
// - scope (company / customer / project) is where the view lives and is the
//   CEILING: nobody outside it ever sees the view, whatever its visibility;
// - visibility is who sees it inside the scope: 'private' (the owner and the
//   maintaining agent), 'shared' (plus the people on view_shares) or 'scope'
//   (everyone who can see the scope, the behavior before 0.19).
//
// Owners and admins who are not part of a private/shared view get
// "metadata": title, owner, maintaining agent, scope and updated time, never
// its panels, values, description or history. Agents get "full" or "none".

export const VIEW_VISIBILITIES = ["private", "shared", "scope"] as const;
export type ViewVisibility = (typeof VIEW_VISIBILITIES)[number];

/** Visibilities an agent may pick (at creation only): sharing with people is a human action. */
export const AGENT_VIEW_VISIBILITIES = ["private", "scope"] as const;

export type ViewAccess = "full" | "metadata" | "none";

/** The caller, reduced to what the rule needs. */
export type ViewAccessSubject =
    | { kind: "member"; userId: string; isAdmin: boolean }
    /** agentId null = an operator token acting as no agent. */
    | { kind: "agent"; agentId: string | null };

/** The view, reduced to what the rule needs. */
export type ViewAccessFacts = {
    visibility: string;
    ownerUserId: string | null;
    createdByType: string;
    createdById: string | null;
    /** The people on view_shares (only consulted for 'shared'). */
    sharedWith: readonly string[];
};

export function maintainerAgentId(view: { createdByType: string; createdById: string | null }): string | null {
    return view.createdByType === "agent" ? view.createdById : null;
}

/**
 * The one read rule. `inScope` is the scope ceiling, computed by the caller
 * (member scope / agent scope); it is checked first, so a share, an owner or
 * the maintainer outside the scope sees nothing.
 */
export function viewAccess(subject: ViewAccessSubject, view: ViewAccessFacts, inScope: boolean): ViewAccess {
    if (!inScope) return "none";
    const visibility = (VIEW_VISIBILITIES as readonly string[]).includes(view.visibility) ? view.visibility as ViewVisibility : "private";
    if (subject.kind === "agent") {
        if (visibility === "scope") return "full";
        // The maintaining agent reads and writes its view whatever the visibility.
        return subject.agentId !== null && maintainerAgentId(view) === subject.agentId ? "full" : "none";
    }
    if (visibility === "scope") return "full";
    if (view.ownerUserId === subject.userId) return "full";
    if (visibility === "shared" && view.sharedWith.includes(subject.userId)) return "full";
    return subject.isAdmin ? "metadata" : "none";
}

/**
 * Visibility when the creator does not choose: a view made for one person in
 * their private chat is private; one made in team or project context, or with
 * nobody it is for, is open to the scope. A person creating one in Emperor
 * makes it for themselves.
 */
export function defaultViewVisibility(input: { ownerUserId: string | null; source: "private_thread" | "conversation" | "person" | "none" }): ViewVisibility {
    if (!input.ownerUserId) return "scope";
    return input.source === "private_thread" || input.source === "person" ? "private" : "scope";
}

export type OwnerPick = { ok: true; ownerUserId: string | null } | { ok: false; error: string };

/**
 * The owner of a view an agent creates. `derived` is the person whose private
 * chat the agent is answering (always wins when no explicit owner is named);
 * `candidates` are the people the agent demonstrably works with in that
 * conversation. An explicit ownerUserId must be one of them: an agent never
 * names an arbitrary person as owner.
 */
export function pickViewOwner(input: { explicit: string | null; derived: string | null; candidates: readonly string[] }): OwnerPick {
    if (!input.explicit) return { ok: true, ownerUserId: input.derived };
    if (input.explicit === input.derived || input.candidates.includes(input.explicit)) return { ok: true, ownerUserId: input.explicit };
    return { ok: false, error: "ownerUserId must be a person from the conversation you are answering (pass its threadId)" };
}

export const VIEW_REFRESH_MIN_MINUTES = 1;
export const VIEW_REFRESH_MAX_MINUTES = 60 * 24 * 31;

/** refreshEveryMinutes: a whole number of minutes, or null to clear it. undefined = not given. */
export function parseRefreshEveryMinutes(value: unknown): { ok: true; value: number | null | undefined } | { ok: false; error: string } {
    if (value === undefined) return { ok: true, value: undefined };
    if (value === null || value === "" || value === 0) return { ok: true, value: null };
    const n = typeof value === "string" ? Number(value) : value;
    if (typeof n !== "number" || !Number.isInteger(n) || n < VIEW_REFRESH_MIN_MINUTES || n > VIEW_REFRESH_MAX_MINUTES) {
        return { ok: false, error: `refreshEveryMinutes must be a whole number of minutes between ${VIEW_REFRESH_MIN_MINUTES} and ${VIEW_REFRESH_MAX_MINUTES} (or null for no schedule)` };
    }
    return { ok: true, value: n };
}

/** A value is overdue past this multiple of the promised interval. */
export const VIEW_STALE_FACTOR = 1.5;

export type ViewStaleness = { overdue: false } | { overdue: true; lastAt: string | null; expectedMinutes: number };

/**
 * Overdue when the last value is older than 1.5x the promised refresh
 * interval. `lastAt` null (no value yet) is measured from `since` (the
 * view's creation). No interval, no warning.
 */
export function viewStaleness(input: { lastAt: string | null; since: string; refreshEveryMinutes: number | null }, nowMs: number): ViewStaleness {
    const every = input.refreshEveryMinutes;
    if (!every || every <= 0) return { overdue: false };
    const from = Date.parse(input.lastAt ?? input.since);
    if (!Number.isFinite(from)) return { overdue: false };
    return nowMs - from > every * 60_000 * VIEW_STALE_FACTOR ? { overdue: true, lastAt: input.lastAt, expectedMinutes: every } : { overdue: false };
}

/** "every 15 min", "hourly", "every 6 h", "daily", "weekly", "every 3 d". */
export function refreshCadenceText(minutes: number): string {
    if (minutes === 60) return "hourly";
    if (minutes === 1440) return "daily";
    if (minutes === 10080) return "weekly";
    if (minutes < 60) return `every ${minutes} min`;
    if (minutes % 1440 === 0) return `every ${minutes / 1440} d`;
    if (minutes % 60 === 0) return `every ${minutes / 60} h`;
    return `every ${minutes} min`;
}
