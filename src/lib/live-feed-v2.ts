import { createHash } from "crypto";
import type { CharacterAppearance } from "@/lib/character/model";
import type { CharacterExpression } from "@/lib/character/draw";
import { mentionedAgentIds, type RosterAgent } from "@/lib/message-routing";
import {
    activityText, assignIdleRoutines, classifyIncident, deriveBehavior, expressionForActivity, isIncidentStale, sceneStatus,
    type AttentionEntry, type DashboardMember, type DashboardTask, type SceneActivity,
} from "@/lib/team-scene";

/**
 * Pure helpers for the live feed v2 keys (`look`, `act`, `mood`, `thought`,
 * `events`, `needs`). See devices/throne-display/V2_PLAN.md, "Feed v2
 * contract" — the shapes here are a frozen firmware contract.
 */

/** Thoughts and events older than this never reach a screen. */
export const LIVE_RECENT_MS = 10 * 60 * 1000;
export const THOUGHT_MAX = 140;
/** A cleaned thought shorter than this is a stub ("ok", "Thinking...") and is skipped. */
export const THOUGHT_MIN = 20;
export const EVENT_TITLE_MAX = 56;
export const LIVE_MAX_EVENTS = 10;
export const LIVE_MAX_NEEDS = 3;
/** The whole serialized feed must fit the device's JSON buffer. */
export const LIVE_PAYLOAD_BUDGET_BYTES = 12 * 1024;

// ─── look ──────────────────────────────────────────────────────────────────

export interface LiveLook {
    k: "r" | "h";
    u: number;
    v: number;
    s: number;
    /** Hair color index into HAIR_COLORS. */
    h: number;
    /** Hair style index 0-3, exactly as draw.ts computes it. */
    hs: number;
    a: "-" | "g" | "h" | "c" | "b";
}

const ACCESSORY_CODE: Record<CharacterAppearance["accessory"], LiveLook["a"]> = {
    none: "-", glasses: "g", headset: "h", cap: "c", bow: "b",
};

/**
 * Compact character spec. draw.ts derives hair color as `hair % 8` and style
 * as `(hair + variant) % 4` — not the contract's `floor(h / 8) % 6` packing —
 * so, per the contract, `h` is the color index and `hs` the style index.
 */
export function packLook(appearance: CharacterAppearance): LiveLook {
    return {
        k: appearance.kind === "human" ? "h" : "r",
        u: appearance.hue,
        v: appearance.variant,
        s: appearance.skin,
        h: appearance.hair % 8,
        hs: (appearance.hair + appearance.variant) % 4,
        a: ACCESSORY_CODE[appearance.accessory] ?? "-",
    };
}

// ─── act + mood ────────────────────────────────────────────────────────────

export type LiveAct =
    | "typing" | "writing" | "reviewing" | "presenting" | "talking" | "thinking"
    | "waiting" | "blocked" | "celebrate" | "coffee" | "nap" | "stretch" | "offline" | "idle";
export type LiveMood = CharacterExpression;

/** Scene activity → contract `act`. The scene's two generic kinds fold into the enum. */
export function liveActFor(kind: SceneActivity): LiveAct {
    if (kind === "available") return "idle";
    if (kind === "working") return "typing";
    return kind;
}

export interface ActInput {
    id: string;
    name: string;
    health: DashboardMember["health"];
    /** The visible (possibly masked) live activity line, or null. */
    activity: string | null;
    working: { id: string; title: string; taskType: string | null }[];
    waiting: { id: string; title: string; taskType: string | null }[];
    /** An open "problem" incident on one of the agent's tasks. */
    incident: { id: string; taskId: string | null; title: string; reason: string } | null;
    /** A pending approval this agent requested. */
    approval: { id: string; title: string } | null;
    /** The agent finished a task in the last 10 minutes. */
    justDone: boolean;
}

function dashTask(t: { id: string; title: string; taskType: string | null }, state: string): DashboardTask {
    return { id: t.id, projectId: "", projectName: null, title: t.title, state, taskType: t.taskType, assigneeKey: null, updatedAt: "", dueAt: null };
}

function asMember(a: ActInput): DashboardMember {
    return {
        key: `agent:${a.id}`, kind: "agent", id: a.id, name: a.name, role: null, avatarUrl: null, skills: [],
        health: a.health, healthReasons: [], activity: a.activity, href: "", createdAt: null, doneToday: 0,
        working: a.working.map((t) => dashTask(t, "in_progress")), waiting: a.waiting.map((t) => dashTask(t, "review")), next: [],
        spendTodayCents: 0, monthlyCostCents: 0, monthlyBudgetCents: 0, lastActivityAt: null,
    };
}

/**
 * What each agent is acting out, with the same rules as the web office scene
 * (deriveSceneAgents in team-scene.ts): sceneStatus → deriveBehavior with the
 * agent's blocking incident or pending approval as attention, idle routines
 * for idle agents, and the scene's expression for the mood.
 */
export function deriveActs(inputs: ActInput[]): Map<string, { act: LiveAct; mood: LiveMood }> {
    const members = inputs.map((input) => {
        const member = asMember(input);
        const attention: AttentionEntry | null = input.incident
            ? { id: `incident:${input.incident.id}`, kind: "incident", title: input.incident.title, reason: input.incident.reason, memberKey: member.key, memberName: input.name, area: null, at: "", actionLabel: "", href: "", taskId: input.incident.taskId }
            : input.approval
                ? { id: `approval:${input.approval.id}`, kind: "approval", title: input.approval.title, memberKey: member.key, memberName: input.name, area: null, at: "", actionLabel: "", href: "", approvalId: input.approval.id }
                : null;
        return { input, member, attention, status: sceneStatus(member, attention) };
    });
    const idleRoutines = assignIdleRoutines(members.filter((m) => sceneStatus(m.member) === "idle").map((m) => m.member.key));
    const out = new Map<string, { act: LiveAct; mood: LiveMood }>();
    for (const { input, member, attention, status } of members) {
        const behavior = deriveBehavior({
            status,
            activity: activityText(member, status, attention),
            memberKey: member.key,
            attention,
            justDone: input.justDone,
            taskType: member.working[0]?.taskType ?? member.waiting[0]?.taskType ?? null,
            idleRoutine: status === "idle" ? idleRoutines.get(member.key) ?? null : null,
            liveActivity: Boolean(member.activity),
        });
        out.set(input.id, { act: liveActFor(behavior.kind), mood: expressionForActivity(behavior.kind) });
    }
    return out;
}

/** Is an open incident a live "stuck" problem, as the dashboard decides it? */
export function isLiveProblemIncident(i: { reasonCode: string; summary: string; taskState: string | null; taskDeleted: boolean; createdAt: Date }): boolean {
    const classification = classifyIncident(i.reasonCode, i.summary);
    if (classification !== "problem") return false;
    return !isIncidentStale({ classification, taskState: i.taskState, incidentCreatedAt: i.createdAt.toISOString(), currentAssignmentAt: null, taskDeleted: i.taskDeleted });
}

// ─── Redaction + thoughts ──────────────────────────────────────────────────

const REDACTIONS: [RegExp, string][] = [
    // URLs (any scheme) and bare www. hosts.
    [/\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s<>"'`)\]]+/gi, "[link]"],
    [/\bwww\.[^\s<>"'`)\]]+/gi, "[link]"],
    // Emails.
    [/[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi, "[email]"],
    // PEM blocks and bearer credentials.
    [/-----BEGIN [A-Z ]+-----[\s\S]*?(?:-----END [A-Z ]+-----|$)/g, "[secret]"],
    [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [secret]"],
    // key=value / key: value credentials.
    [/\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|auth)\b(["']?\s*[:=]\s*)["']?[^\s"',;]+/gi, "$1$2[secret]"],
    // "password hunter2", "token abc123xyz": a keyword followed by a value that
    // is not a plain word (it has a digit or a symbol), so prose like "the key
    // insight" survives. Placeholders from earlier rules ("[link]") are kept.
    [/\b(password|passwd|pwd|secret|token|key)(\s+)(?=[^\s"',;]{6,})(?![a-z]+\b)(?!\[)["']?[^\s"',;]+/gi, "$1$2[secret]"],
    // Known token prefixes: Emperor Claw, GitHub, OpenAI/Anthropic, Slack, Stripe, AWS, Google, JWTs.
    [/\b(?:ec|ghp|gho|ghu|ghs|ghr|glpat|xox[abposr]|sk|pk|rk|whsec)[_-][A-Za-z0-9_-]{6,}/g, "[secret]"],
    [/\bgithub_pat_[A-Za-z0-9_]{10,}/g, "[secret]"],
    [/\bsk-[A-Za-z0-9_-]{6,}/g, "[secret]"],
    [/\b(?:AKIA|ASIA)[A-Z0-9]{12,}/g, "[secret]"],
    [/\bAIza[A-Za-z0-9_-]{20,}/g, "[secret]"],
    [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?/g, "[secret]"],
    // Home-directory and system paths (POSIX, macOS, ~) and any Windows drive path.
    [/(?<![\w.])\/(?:home|Users|root|var|etc|opt|srv)(?:\/[^\s"'`<>|]*)?/g, "[path]"],
    [/\b[A-Za-z]:[\\/][^\s"'`<>|]*/g, "[path]"],
    [/(?<![\w~])~[\\/][^\s"'`<>|]*/g, "[path]"],
];

/**
 * A long run of hex, or of base64/url-safe chars containing both letters and
 * digits (keys, ids, hashes). "/" is not part of a run so ordinary relative
 * paths survive; real base64 keys rarely split into short pieces.
 */
const OPAQUE_RUN_RE = /[A-Za-z0-9+=_-]{24,}/g;

/**
 * Is a long run a key, hash or id rather than a word? Hex (dashes allowed:
 * uuids), anything mixing upper case, lower case and digits, or an unbroken
 * letters+digits run with no kebab/snake separators. Identifiers such as
 * `thread_message_reasoning_v2_index` or `live-feed-budget-check-24` are kept.
 */
export function isOpaqueRun(run: string): boolean {
    if (/^[0-9a-f-]{24,}$/i.test(run) && /[0-9]/.test(run) && run.replace(/-/g, "").length >= 24) return true;
    const upper = /[A-Z]/.test(run), lower = /[a-z]/.test(run), digit = /[0-9]/.test(run);
    if (upper && lower && digit) return true;
    return !/[_-]/.test(run) && digit && (upper || lower);
}

function redactOpaqueRuns(text: string): string {
    return text.replace(OPAQUE_RUN_RE, (run) => (isOpaqueRun(run) ? "[secret]" : run));
}

/** Remove URLs, emails, credentials, tokens, opaque ids/keys and home paths. */
export function redactSensitive(input: string): string {
    let text = input;
    for (const [re, replacement] of REDACTIONS) text = text.replace(re, replacement);
    return redactOpaqueRuns(text);
}

/** Collapse whitespace, redact, then truncate by code point with an ASCII "...". */
export function cleanSnippet(input: string, max: number): string {
    const text = redactSensitive(input.replace(/\s+/g, " ").trim()).replace(/\s+/g, " ").trim();
    const chars = Array.from(text);
    if (chars.length <= max) return text;
    return `${chars.slice(0, Math.max(0, max - 3)).join("").trimEnd()}...`;
}

const STUB_RE = /^(?:\(?no (?:reasoning|thoughts?)\)?|thinking\.*|reasoning\.*|\.+|\[[a-z]+\])$/i;

/**
 * The newest substantive line of one reasoning transcript, or null. Reasoning
 * is read from its end (the latest thought); `truncatedHead` says the text was
 * cut from a longer transcript, so its first line may be a fragment and is
 * dropped (a half key would slip past the redaction patterns).
 */
export function thoughtFromReasoning(reasoning: string, truncatedHead = false, max = THOUGHT_MAX): string | null {
    let text = reasoning.replace(/\r\n?/g, "\n");
    if (truncatedHead) {
        const nl = text.indexOf("\n");
        text = nl === -1 ? "" : text.slice(nl + 1);
    }
    // Code fences are output, not thinking.
    text = text.replace(/```[\s\S]*?(?:```|$)/g, "\n");
    const paragraphs = text.split(/\n\s*\n|\n(?=[-*#>] |\d+[.)] )/);
    for (let i = paragraphs.length - 1; i >= 0; i--) {
        const plain = paragraphs[i].replace(/^[\s#>*-]+/gm, "").replace(/[*_`]{1,3}/g, "");
        const cleaned = cleanSnippet(plain, Number.MAX_SAFE_INTEGER);
        const substance = cleaned.replace(/\[(?:link|email|secret|path)\]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
        if (cleaned.length < THOUGHT_MIN || substance.length < THOUGHT_MIN / 2 || STUB_RE.test(cleaned)) continue;
        return cleanSnippet(plain, max);
    }
    return null;
}

export interface ReasoningRow {
    agentId: string;
    messageId: string;
    threadType: string;
    createdAtMs: number;
    reasoning: string;
    truncatedHead: boolean;
}

/**
 * Each agent's thought: the newest row (≤10 minutes old) that yields a
 * substantive snippet. A row is eligible only from a team/group thread, or —
 * on a screen carrying its creator's private chats — when the message is one
 * of the agent's replies to the creator that `dm` itself shows. Anything else
 * (another member's direct chat, platform requests, any other thread type) is
 * never read into a thought.
 */
export function pickThoughts(rows: ReasoningRow[], options: { nowMs: number; creatorReplyIds: ReadonlySet<string> }): Map<string, { thought: string; ageSec: number }> {
    const out = new Map<string, { thought: string; ageSec: number }>();
    const sorted = [...rows].sort((a, b) => b.createdAtMs - a.createdAtMs || (a.messageId < b.messageId ? 1 : -1));
    for (const row of sorted) {
        if (out.has(row.agentId)) continue;
        const age = options.nowMs - row.createdAtMs;
        if (age > LIVE_RECENT_MS) continue;
        const visible = row.threadType === "team" || row.threadType === "group" || (row.threadType === "direct" && options.creatorReplyIds.has(row.messageId));
        if (!visible) continue;
        const thought = thoughtFromReasoning(row.reasoning, row.truncatedHead);
        if (!thought) continue;
        out.set(row.agentId, { thought, ageSec: Math.max(0, Math.floor(age / 1000)) });
    }
    return out;
}

// ─── events + needs ────────────────────────────────────────────────────────

export type LiveEventType = "handoff" | "task_done" | "needs_you" | "blocked";

export interface LiveEvent {
    id: string;
    t: LiveEventType;
    a: string;
    b?: string;
    title?: string;
    ageSec: number;
}

export interface LiveNeed {
    agentId: string;
    title: string;
}

export interface HandoffRow {
    id: string;
    senderId: string | null;
    targetAgentId: string | null;
    text: string;
    createdAtMs: number;
}

export interface TaskTransitionRow {
    id: string;
    /** "done" or "blocked". */
    state: string;
    actorType: string;
    actorId: string | null;
    assignedAgentId: string | null;
    title: string;
    createdAtMs: number;
}

export interface PendingApprovalRow {
    id: string;
    requesterAgentId: string | null;
    title: string;
    requestedAtMs: number;
}

const humanize = (value: string) => value.replace(/_/g, " ");

/** The dashboard's approval title ("Approve <task>"), cleaned for a screen. */
export function approvalTitle(input: { actionType: string; rationale: string | null; taskTitle: string | null }): string {
    const what = input.taskTitle?.trim() || input.rationale?.trim() || humanize(input.actionType);
    const raw = input.actionType === "task_done" ? `Approve ${what}` : `Approve ${humanize(input.actionType)}: ${what}`;
    return screenTitle(raw);
}

/** One line, redacted, ≤56 characters. */
export function screenTitle(input: string): string {
    return cleanSnippet(input.replace(/[*_`#>]+/g, " "), EVENT_TITLE_MAX);
}

/** The recipient of an agent-to-agent handoff: its target, else the first other agent it @mentions. */
export function handoffRecipient(row: HandoffRow, roster: RosterAgent[]): string | null {
    if (!row.senderId) return null;
    if (row.targetAgentId && row.targetAgentId !== row.senderId && roster.some((a) => a.id === row.targetAgentId)) return row.targetAgentId;
    for (const id of mentionedAgentIds(row.text, roster)) {
        if (id !== row.senderId) return id;
    }
    return null;
}

/** The agent a task transition belongs to: the acting agent, else the task's assignee. */
function transitionAgent(row: TaskTransitionRow, known: ReadonlySet<string>): string | null {
    if (row.actorType === "agent" && row.actorId && known.has(row.actorId)) return row.actorId;
    return row.assignedAgentId && known.has(row.assignedAgentId) ? row.assignedAgentId : null;
}

/** Agents with a task_done transition in the window (the scene's "just finished"). */
export function recentlyDoneAgents(rows: TaskTransitionRow[], known: ReadonlySet<string>, nowMs: number): Set<string> {
    const out = new Set<string>();
    for (const row of rows) {
        if (row.state !== "done" || nowMs - row.createdAtMs > LIVE_RECENT_MS) continue;
        const agent = transitionAgent(row, known);
        if (agent) out.add(agent);
    }
    return out;
}

/**
 * `events`: handoffs, task done/blocked transitions and newly requested
 * approvals from the last 10 minutes, newest first, at most 10. Ids are
 * derived from the event type and source row id (see liveEventId), so a
 * device plays each event once. Only
 * agents the screen shows appear in `a`/`b`. Titles are task or approval
 * titles — never message text — so no thread content reaches a title.
 */
/**
 * Stable, compact event id: "evt-" + type letter + 10 base64url chars of a
 * hash of the source row id. A raw uuid would cost ~26 more bytes per event
 * on a 12 KB budget; 60 bits is ample to keep ≤10 live events distinct.
 */
export function liveEventId(type: LiveEventType, rowId: string): string {
    const letter = type === "handoff" ? "h" : type === "task_done" ? "d" : type === "needs_you" ? "n" : "b";
    return `evt-${letter}-${createHash("sha256").update(`${type}:${rowId}`).digest("base64url").slice(0, 10)}`;
}

export function deriveEvents(input: {
    handoffs: HandoffRow[];
    transitions: TaskTransitionRow[];
    approvals: PendingApprovalRow[];
    roster: RosterAgent[];
    shown: ReadonlySet<string>;
    nowMs: number;
}): LiveEvent[] {
    const { roster, shown, nowMs } = input;
    const fresh = (ms: number) => nowMs - ms <= LIVE_RECENT_MS;
    const ageSec = (ms: number) => Math.max(0, Math.floor((nowMs - ms) / 1000));
    const all: { at: number; event: LiveEvent }[] = [];
    for (const row of input.handoffs) {
        if (!fresh(row.createdAtMs) || !row.senderId || !shown.has(row.senderId)) continue;
        const to = handoffRecipient(row, roster);
        if (!to || !shown.has(to)) continue;
        all.push({ at: row.createdAtMs, event: { id: liveEventId("handoff", row.id), t: "handoff", a: row.senderId, b: to, ageSec: ageSec(row.createdAtMs) } });
    }
    for (const row of input.transitions) {
        if (!fresh(row.createdAtMs) || (row.state !== "done" && row.state !== "blocked")) continue;
        const agent = transitionAgent(row, shown);
        if (!agent) continue;
        const t: LiveEventType = row.state === "done" ? "task_done" : "blocked";
        all.push({ at: row.createdAtMs, event: { id: liveEventId(t, row.id), t, a: agent, title: screenTitle(row.title), ageSec: ageSec(row.createdAtMs) } });
    }
    for (const row of input.approvals) {
        if (!fresh(row.requestedAtMs) || !row.requesterAgentId || !shown.has(row.requesterAgentId)) continue;
        all.push({ at: row.requestedAtMs, event: { id: liveEventId("needs_you", row.id), t: "needs_you", a: row.requesterAgentId, title: row.title, ageSec: ageSec(row.requestedAtMs) } });
    }
    all.sort((x, y) => y.at - x.at || (x.event.id < y.event.id ? -1 : 1));
    return all.slice(0, LIVE_MAX_EVENTS).map((e) => e.event);
}

/** `needs`: the newest pending approvals, at most 3. An approval with no requesting agent has agentId "". */
export function deriveNeeds(approvals: PendingApprovalRow[]): LiveNeed[] {
    return [...approvals]
        .sort((a, b) => b.requestedAtMs - a.requestedAtMs || (a.id < b.id ? -1 : 1))
        .slice(0, LIVE_MAX_NEEDS)
        .map((a) => ({ agentId: a.requesterAgentId ?? "", title: a.title }));
}

// ─── Payload budget ────────────────────────────────────────────────────────

const THOUGHT_STEPS = [140, 100, 72];
const THOUGHT_FLOOR_MAX = 48;
/** Thoughts kept even when the rest of the feed alone exceeds the budget. */
export const LIVE_MIN_THOUGHTS = 3;

function shorten(value: string, max: number): string {
    const chars = Array.from(value);
    if (chars.length <= max) return value;
    return `${chars.slice(0, Math.max(0, max - 3)).join("").trimEnd()}...`;
}

/**
 * Keep the serialized feed under `budget` bytes. Only thoughts flex — every
 * other key is bounded by its own cap and v1 keys are never trimmed:
 *  1. shorten every thought 140 → 100 → 72 chars;
 *  2. drop the oldest thoughts, keeping the LIVE_MIN_THOUGHTS newest;
 *  3. shorten those to 48 chars.
 * When the feed without thoughts is already over budget (24 agents with every
 * v1 string near its cap), the result can exceed it by those few short
 * thoughts (~250 bytes) rather than lose thoughts entirely. Mutates and
 * returns the feed.
 */
export function fitThoughtsToBudget<F extends { agents: { thought?: string; thoughtAgeSec?: number }[] }>(feed: F, budget = LIVE_PAYLOAD_BUDGET_BYTES): F {
    const size = () => Buffer.byteLength(JSON.stringify(feed), "utf8");
    if (size() <= budget) return feed;
    for (const max of THOUGHT_STEPS.slice(1)) {
        for (const agent of feed.agents) if (agent.thought) agent.thought = shorten(agent.thought, max);
        if (size() <= budget) return feed;
    }
    const oldestFirst = feed.agents.filter((a) => a.thought).sort((x, y) => (y.thoughtAgeSec ?? 0) - (x.thoughtAgeSec ?? 0));
    for (const agent of oldestFirst.slice(0, Math.max(0, oldestFirst.length - LIVE_MIN_THOUGHTS))) {
        delete agent.thought;
        delete agent.thoughtAgeSec;
        if (size() <= budget) return feed;
    }
    for (const agent of feed.agents) if (agent.thought) agent.thought = shorten(agent.thought, THOUGHT_FLOOR_MAX);
    return feed;
}
