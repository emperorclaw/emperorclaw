/**
 * Pure model for the "Your team, in motion" dashboard: status mapping, zone
 * assignment, the isometric office layout and the copy derived from real
 * agent/task data. No React, no database — everything here is unit-tested.
 */

import { deriveAppearance, hashString, type CharacterAppearance } from "@/lib/character/model";

export { hashString };

export type HealthStatus = "healthy" | "attention" | "down" | "idle";
export type SceneStatus = "working" | "waiting" | "blocked" | "idle" | "offline";
export type WorkZoneId = "research" | "content" | "engineering" | "qa" | "operations";
export type ZoneId = WorkZoneId | "lounge";
export type KpiFilter = "working" | "waiting" | "done" | "attention";
export type LabelMode = "full" | "name" | "dot";

export interface DashboardTask {
    id: string;
    projectId: string;
    projectName: string | null;
    title: string;
    state: string;
    /** Raw task type, used to pick the right working animation (e.g. "content"). */
    taskType: string | null;
    assigneeKey: string | null;
    updatedAt: string;
    dueAt: string | null;
}

export interface DashboardMember {
    key: string;
    kind: "agent" | "human";
    id: string;
    name: string;
    role: string | null;
    avatarUrl: string | null;
    /** Optional override of the agent's drawn appearance. */
    avatarAppearance?: CharacterAppearance | null;
    skills: string[];
    health: HealthStatus | null;
    healthReasons: string[];
    /** Live "typing" activity reported by the runtime, if any. */
    activity: string | null;
    href: string;
    /** When the agent was created, used for the brand-new "wave on first render". */
    createdAt: string | null;
    doneToday: number;
    working: DashboardTask[];
    waiting: DashboardTask[];
    next: DashboardTask[];
    /** Spend and budget (cents) for the cost cards and list column. */
    spendTodayCents: number;
    monthlyCostCents: number;
    monthlyBudgetCents: number;
    /** Last runtime heartbeat, for "last activity". */
    lastActivityAt: string | null;
    /** Connection evidence is independent of work and health. */
    runtimeOnline?: boolean;
    canRestartRuntime?: boolean;
}

export type AttentionKind = "approval" | "incident" | "message" | "agent" | "late" | "not_started" | "paused";

/**
 * An incident's classification, derived from its structured `reasonCode`
 * (primary) with a summary-pattern fallback. Watchdog SLA/queue alerts are
 * never a "stuck" problem: they are "late" (still working) or "not_started".
 */
export type IncidentClass = "late" | "not_started" | "problem";

export interface AttentionEntry {
    id: string;
    kind: AttentionKind;
    /** Primary actionable copy: the task title, or approval/reply copy. */
    title: string;
    /** Short reason for "incident" items (e.g. "max retries exceeded"). */
    reason?: string | null;
    memberKey: string | null;
    memberName: string | null;
    area: string | null;
    at: string;
    actionLabel: string;
    href: string;
    /** Action targets for the inline actions in "Needs your attention". */
    taskId?: string | null;
    approvalId?: string | null;
    agentId?: string | null;
    threadId?: string | null;
    /** Explicit override for delivery failures and queue items. */
    actionRequired?: boolean;
    canRestartRuntime?: boolean;
}

export interface CollaborationEvent {
    id: string;
    fromKey: string;
    toKey: string;
    kind: "handoff" | "review";
    taskTitle: string;
    at: string;
}

export interface ActivityEvent {
    id: string;
    eventType: string;
    actorKey: string | null;
    actorName: string;
    targetName: string | null;
    targetKey: string | null;
    taskTitle: string;
    taskId: string | null;
    projectId: string | null;
    at: string;
}

export interface DashboardData {
    generatedAt: string;
    members: DashboardMember[];
    board: { inProgress: DashboardTask[]; review: DashboardTask[]; done: DashboardTask[] };
    attention: AttentionEntry[];
    collaborations: CollaborationEvent[];
    activity: ActivityEvent[];
    cost: CostSummary;
    throughput: ThroughputSummary;
    feed: FeedEvent[];
}

/* ── Cost & throughput summaries ─────────────────────────────────────── */

export interface AgentCost {
    key: string;
    name: string;
    spendTodayCents: number;
    monthCents: number;
    budgetCents: number;
}

export interface CostSummary {
    spendTodayCents: number;
    spendMonthCents: number;
    budgetCents: number;
    /** Top agents by month spend, for the "who is spending" strip. */
    agents: AgentCost[];
}

export interface ThroughputSummary {
    doneToday: number;
    doneThisWeek: number;
    /** Tasks done per day for the last 7 days, oldest first. */
    sparkline: number[];
    /** Median assigned→done time (ms) over the last 7 days, or null. */
    medianCycleMs: number | null;
    blocked: number;
}

/** A single line in the "What's moving" feed. */
export interface FeedEvent {
    id: string;
    kind: "handoff" | "review" | "done" | "claim" | "note" | "pair";
    actorKey: string | null;
    actorName: string | null;
    targetKey: string | null;
    targetName: string | null;
    text: string;
    href: string | null;
    at: string;
}

/* ── Status ─────────────────────────────────────────────────────────── */

/** A task problem or unavailable runtime can prevent work. Decisions are overlays. */
export function isBlockingAttention(kind: AttentionKind): boolean {
    return kind === "incident" || kind === "agent";
}

/** Timing and delivery observations do not imply that a human owes a response. */
export function requiresHumanAction(entry: AttentionEntry): boolean {
    return entry.actionRequired ?? ["approval", "incident", "agent", "paused"].includes(entry.kind);
}

export function attentionForMember(entries: AttentionEntry[], memberKey: string): AttentionEntry[] {
    return entries.filter((entry) => entry.memberKey === memberKey);
}

/**
 * Urgency for ordering "Needs your attention": stuck > offline > SLA late >
 * approval > reply > paused loop > not started. Lower is more urgent.
 */
export function attentionUrgency(kind: AttentionKind): number {
    switch (kind) {
        case "incident": return 0;
        case "agent": return 1;
        case "late": return 2;
        case "approval": return 3;
        case "message": return 4;
        case "paused": return 5;
        case "not_started": return 6;
    }
}

/**
 * Classify an incident from its structured `reasonCode`, falling back to a
 * summary pattern when the code is absent. Watchdog queue/SLA alerts are not
 * problems — they are "late" or "not_started".
 */
export function classifyIncident(reasonCode: string | null | undefined, summary?: string | null): IncidentClass {
    const code = (reasonCode ?? "").trim();
    if (code === "sla_breach" || code.startsWith("sla_")) return "late";
    if (code === "unclaimed_stale") return "not_started";
    // Fallback discriminator when the structured field is missing.
    if (!code) {
        const text = (summary ?? "").toLowerCase();
        if (text.includes("breached sla") || text.includes("sla deadline")) return "late";
        if (text.includes("unclaimed") || text.includes("inbox")) return "not_started";
    }
    return "problem";
}

/** Task states that still count as "open" for incident staleness. */
const OPEN_TASK_STATES = new Set(["inbox", "in_progress", "review"]);

export function isOpenTaskState(state: string | null | undefined): boolean {
    return typeof state === "string" && OPEN_TASK_STATES.has(state);
}

/**
 * A watchdog (or stale) incident is only meaningful while it still reflects
 * the current situation. The exact rule depends on the classification:
 *  - "not_started" clears once the task is claimed (leaves the inbox);
 *  - "late" clears once the task leaves the SLA-tracked open states;
 *  - "problem" only clears when the task is actually done (or the task was
 *    cancelled/deleted) — a failed/dead-letter task still needs a human.
 * The "created before the current assignment" rule applies only to the
 * assignment-scoped kinds (late / not_started): those belong to a previous
 * owner. A "problem" is about the task itself, so reassigning it must not
 * hide a failed/dead-letter task.
 */
export function isIncidentStale(input: {
    classification: IncidentClass;
    taskState: string | null;
    incidentCreatedAt: string;
    currentAssignmentAt: string | null;
    taskDeleted?: boolean;
}): boolean {
    if (input.classification !== "problem" && input.currentAssignmentAt) {
        const created = new Date(input.incidentCreatedAt).getTime();
        const assigned = new Date(input.currentAssignmentAt).getTime();
        if (!Number.isNaN(created) && !Number.isNaN(assigned) && created < assigned) return true;
    }
    switch (input.classification) {
        case "not_started": return input.taskState !== "inbox";
        case "late": return !isOpenTaskState(input.taskState);
        case "problem": return input.taskState === "done" || input.taskDeleted === true;
    }
}

/** A loop-guard pause notice, with whether it belongs to a private pair thread. */
export interface PausedNotice {
    id: string;
    threadId: string;
    createdAt: string;
    isPairThread: boolean;
}

/**
 * Keep only the pause notices that still need attention. A notice is dropped
 * when a "Resume" marker (loopGuardResume) is newer than it, and pair-thread
 * notices are hidden from anyone who is not an owner/admin (pair threads are
 * private agent conversations). One notice per thread, newest first.
 */
export function filterPausedNotices(
    notices: PausedNotice[],
    latestResumeByThread: Map<string, string>,
    isOwnerOrAdmin: boolean,
): PausedNotice[] {
    const seen = new Set<string>();
    const out: PausedNotice[] = [];
    for (const notice of notices) {
        if (seen.has(notice.threadId)) continue;
        seen.add(notice.threadId);
        if (notice.isPairThread && !isOwnerOrAdmin) continue;
        const resumeAt = latestResumeByThread.get(notice.threadId);
        if (resumeAt && resumeAt > notice.createdAt) continue;
        out.push(notice);
    }
    return out;
}

/** The one-line "Stuck: <reason>" caption, the only truly-stuck state. */
export function stuckCaption(attention: AttentionEntry): string {
    const reason = attention.reason?.trim();
    return reason ? `Stuck: ${sentence(reason)}` : "Stuck";
}

/** The highest-priority entry per member, blocking kinds first. */
export function attentionByMember(entries: AttentionEntry[]): Map<string, AttentionEntry> {
    const map = new Map<string, AttentionEntry>();
    for (const entry of entries) {
        if (entry.memberKey && !map.has(entry.memberKey)) map.set(entry.memberKey, entry);
    }
    return map;
}

export interface MemberAttention {
    /** A task problem or unavailable runtime, if any. */
    blocking: AttentionEntry | null;
    /** A pending decision, timing observation, or delivery signal. */
    overlay: AttentionEntry | null;
}

/** Split a member's attention into blocking vs. non-blocking overlays. */
export function memberAttention(entries: AttentionEntry[], memberKey: string): MemberAttention {
    let blocking: AttentionEntry | null = null;
    let overlay: AttentionEntry | null = null;
    for (const entry of entries) {
        if (entry.memberKey !== memberKey) continue;
        if (isBlockingAttention(entry.kind)) {
            if (!blocking || attentionUrgency(entry.kind) < attentionUrgency(blocking.kind)) blocking = entry;
        } else if (!overlay || attentionUrgency(entry.kind) < attentionUrgency(overlay.kind)) {
            overlay = entry;
        }
    }
    return { blocking, overlay };
}

export function sceneStatus(member: DashboardMember, attention?: AttentionEntry | null): SceneStatus {
    // Fresh runtime evidence wins over the slower health scan.
    if (member.activity) return "working";
    if (member.health === "down") return "offline";
    // A problem in one task does not stop unrelated work assigned to this agent.
    const unaffectedWork = member.working.some((task) =>
        attention?.kind !== "incident" || (Boolean(attention.taskId) && task.id !== attention.taskId));
    if (unaffectedWork) return "working";
    if (attention && isBlockingAttention(attention.kind)) return "blocked";
    if (member.waiting.length > 0 || attention?.kind === "approval") return "waiting";
    return "idle";
}

const BLOCKED_COPY: Record<AttentionKind, string> = {
    approval: "Waiting for approval",
    incident: "Stuck",
    message: "Awaiting agent response",
    agent: "Needs a check-in",
    late: "Running late",
    not_started: "Hasn't started",
    paused: "Conversation paused",
};

function sentence(text: string): string {
    const trimmed = text.trim().replace(/[.…]+$/, "");
    return trimmed ? trimmed[0].toUpperCase() + trimmed.slice(1) : trimmed;
}

/** The one-line "what is this agent doing" shown on the floating label. */
export function activityText(member: DashboardMember, status: SceneStatus, attention?: AttentionEntry | null): string {
    switch (status) {
        case "offline":
            return "No recent connection with work waiting";
        case "blocked":
            if (attention?.kind === "incident") return stuckCaption(attention);
            if (attention) return BLOCKED_COPY[attention.kind];
            return member.healthReasons[0] ? sentence(member.healthReasons[0]) : "Needs you";
        case "working":

            if (member.activity && !/^working…?$/i.test(member.activity.trim())) return sentence(member.activity);
            return member.working[0]?.title ?? "Working";
        case "waiting":
            return "Waiting for review";
        default:
            if (attention?.kind === "not_started") return `Hasn't started ${attention.title}`;
            return "Available";
    }
}

export const STATUS_LABEL: Record<SceneStatus, string> = {
    working: "Working",
    waiting: "In review",
    blocked: "Task blocked",
    idle: "Available",
    offline: "Connection stale",
};

export function matchesKpi(filter: KpiFilter | null, member: DashboardMember, status: SceneStatus): boolean {
    if (!filter) return true;
    if (filter === "working") return status === "working";
    if (filter === "waiting") return status === "waiting";
    if (filter === "done") return member.doneToday > 0;
    return status === "blocked" || status === "offline";
}

/** How busy someone is: used to sort desks and pick the default selection. */
export function activityScore(member: DashboardMember, status: SceneStatus): number {
    const base = { working: 400, blocked: 300, waiting: 200, offline: 100, idle: 0 }[status];
    return base + member.working.length * 6 + member.waiting.length * 4 + member.next.length + member.doneToday * 2 + (member.activity ? 10 : 0);
}

/* ── Zones ──────────────────────────────────────────────────────────── */

export interface ZoneMeta {
    id: ZoneId;
    label: string;
    sign: string;
    blurb: string;
    /** Neon accent used for the wall sign and the floor tint. */
    hue: number;
}

export const ZONES: Record<ZoneId, ZoneMeta> = {
    research: { id: "research", label: "Research", sign: "RESEARCH", blurb: "Finds leads, gathers sources and turns data into insight.", hue: 275 },
    content: { id: "content", label: "Content", sign: "CONTENT", blurb: "Writes, optimizes and publishes content.", hue: 205 },
    engineering: { id: "engineering", label: "Engineering", sign: "ENGINEERING", blurb: "Builds, ships and maintains the product.", hue: 190 },
    qa: { id: "qa", label: "QA & Testing", sign: "QA · TESTING", blurb: "Reviews changes and tests before anything ships.", hue: 150 },
    operations: { id: "operations", label: "Operations", sign: "OPERATIONS", blurb: "Keeps the day-to-day running.", hue: 35 },
    lounge: { id: "lounge", label: "Lounge", sign: "COFFEE", blurb: "Available for new work.", hue: 28 },
};

export const WORK_ZONE_ORDER: WorkZoneId[] = ["research", "content", "engineering", "qa", "operations"];

// Checked in order; the first zone with a matching keyword wins.
const ZONE_KEYWORDS: Array<[WorkZoneId, string[]]> = [
    ["qa", ["qa", "test", "quality", "verif", "audit", "review"]],
    ["engineering", ["engineer", "develop", "dev", "code", "coder", "architect", "api", "backend", "frontend", "infra", "build", "software", "programm", "tech"]],
    ["research", ["research", "analy", "data", "scout", "lead", "intel", "insight", "prospect", "investig"]],
    ["content", ["content", "writ", "copy", "market", "growth", "social", "seo", "blog", "editor", "brand", "design", "creative", "media", "newsletter"]],
];

export function workZoneFor(member: Pick<DashboardMember, "name" | "role" | "skills">): WorkZoneId {
    const haystacks = [member.role ?? "", member.skills.join(" "), member.name].map((s) => s.toLowerCase());
    // Role is the strongest signal, then skills, then the name.
    for (const text of haystacks) {
        for (const [zone, words] of ZONE_KEYWORDS) {
            if (words.some((w) => new RegExp(`(^|[^a-z])${w}`).test(text))) return zone;
        }
    }
    return "operations";
}

/** Idle agents take a break in the lounge; everyone else sits in their work zone. */
export function zoneFor(member: DashboardMember, status: SceneStatus): ZoneId {
    return status === "idle" ? "lounge" : workZoneFor(member);
}

/* ── Avatar variant ─────────────────────────────────────────────────── */

export interface AvatarVariant {
    body: "robot" | "human";
    hue: number;
    skin: number;
    hair: number;
    accessory: "none" | "glasses" | "headset" | "cap";
}

/**
 * Legacy slim view of a character, kept for callers that only need body/hue.
 * Derived from the shared appearance model so the office scene and the app
 * avatars never drift apart.
 */
export function avatarVariant(id: string, kind: "agent" | "human"): AvatarVariant {
    const appearance = deriveAppearance(id, kind === "human" ? "human" : undefined);
    const accessory = appearance.accessory === "bow" ? "none" : appearance.accessory;
    return { body: appearance.kind, hue: appearance.hue, skin: appearance.skin, hair: appearance.hair, accessory };
}

/* ── Scene activity (the animation a character plays) ───────────────── */

export type SceneActivity =
    | "typing" | "writing" | "reviewing" | "presenting" | "talking" | "thinking"
    | "waiting"      // approval / reply pending — the agent needs the human
    | "blocked"      // error / incident — the agent is stuck
    | "celebrate"    // just finished a task
    | "coffee" | "nap" | "stretch" // idle routines
    | "available" | "working"
    | "offline";

export type IdleRoutine = "coffee" | "nap" | "stretch";

export interface Behavior {
    kind: SceneActivity;
    /** Short human-readable label for the scene label and the detail card. */
    caption: string;
    /** 0-based personality pick, so the same activity looks different per agent. */
    variant: number;
}

export interface BehaviorInput {
    status: SceneStatus;
    activity: string;
    memberKey: string;
    attention?: AttentionEntry | null;
    talking?: boolean;
    justDone?: boolean;
    taskType?: string | null;
    idleRoutine?: IdleRoutine | null;
    /** Health flagged "attention" without a blocking reason → a check-in hint. */
    checkIn?: boolean;
    checkInReason?: string | null;
    /** Only a fresh runtime signal authorizes continuous working motion. */
    liveActivity?: boolean;
}

const MAX_IDLE_WALKERS = 3;

/** Which idle agents walk to the coffee machine; the rest nap or stretch. */
export function assignIdleRoutines(idleKeys: string[], walkerCap = MAX_IDLE_WALKERS): Map<string, IdleRoutine> {
    const result = new Map<string, IdleRoutine>();
    // Deterministic order so the same set of idle agents always picks the same
    // walkers (stable across re-renders), while different teams desync.
    const ordered = [...idleKeys].sort((a, b) => hashString(`routine:${a}`) - hashString(`routine:${b}`));
    ordered.forEach((key, i) => {
        if (i < walkerCap) result.set(key, "coffee");
        else result.set(key, hashString(`nap:${key}`) % 2 === 0 ? "nap" : "stretch");
    });
    return result;
}

/** 0..variants-1, stable per agent + activity. */
function activityVariant(memberKey: string, kind: string, variants = 2): number {
    return hashString(`${memberKey}:${kind}`) % variants;
}

/** Which animation kind an agent should play, plus the caption for it. */
export function deriveBehavior(input: BehaviorInput): Behavior {
    const { status, activity, memberKey, attention = null, talking = false, justDone = false, taskType = null, idleRoutine = null } = input;

    if (status === "offline") return { kind: "offline", caption: "Connection stale", variant: 0 };

    if (justDone) return { kind: "celebrate", caption: "Just finished", variant: activityVariant(memberKey, "celebrate", 3) };

    if (status === "blocked") {
        // Legacy callers may pass decisions here. Copy still identifies who owes the action.
        if (attention?.kind === "approval") return { kind: "waiting", caption: "Needs your approval", variant: activityVariant(memberKey, "waiting") };
        if (attention?.kind === "message") return { kind: "waiting", caption: "Awaiting agent response", variant: activityVariant(memberKey, "waiting") };
        if (attention?.kind === "incident") return { kind: "blocked", caption: stuckCaption(attention), variant: activityVariant(memberKey, "blocked") };
        return { kind: "blocked", caption: "Needs a check-in", variant: activityVariant(memberKey, "blocked") };
    }

    if (status === "waiting") return { kind: "waiting", caption: attention?.kind === "approval" ? "Approval pending" : "Work awaiting review", variant: activityVariant(memberKey, "waiting") };

    if (status === "idle") {
        let base: Behavior;
        if (idleRoutine === "coffee") base = { kind: "coffee", caption: "Coffee break", variant: activityVariant(memberKey, "coffee") };
        else if (idleRoutine === "nap") base = { kind: "nap", caption: "Napping", variant: activityVariant(memberKey, "nap") };
        else if (idleRoutine === "stretch") base = { kind: "stretch", caption: "Stretching", variant: activityVariant(memberKey, "stretch") };
        else base = { kind: "available", caption: "Available", variant: 0 };
        // A queued-but-unclaimed task shows as an amber "hasn't started" note.
        if (attention?.kind === "not_started") return { ...base, caption: `Hasn't started ${attention.title}` };
        return base;
    }

    if (input.liveActivity === false) return { kind: "working", caption: "Task in progress", variant: 0 };

    let base: Behavior;
    if (talking) {
        base = { kind: "talking", caption: "In a huddle", variant: activityVariant(memberKey, "talking") };
    } else {
        const text = activity.toLowerCase();
        const type = (taskType ?? "").toLowerCase();
        if (/present|teach|demo|whiteboard|onboard|train|explain|workshop/.test(text) || /present|teach|demo|workshop/.test(type)) {
            base = { kind: "presenting", caption: "Presenting", variant: activityVariant(memberKey, "presenting") };
        } else if (/review|qa|test|verif|audit|approv|inspect/.test(text) || /qa|test|review|verif|audit/.test(type)) {
            base = { kind: "reviewing", caption: "Reviewing", variant: activityVariant(memberKey, "reviewing") };
        } else if (/writ|draft|article|copy|blog|content|post|document|report|newsletter/.test(text) || /content|writ|copy|blog|article|report/.test(type)) {
            base = { kind: "writing", caption: "Writing", variant: activityVariant(memberKey, "writing") };
        } else if (/research|analy|think|plan|investig|explor|scout|strateg/.test(text) || /research|analy|insight|strategy/.test(type)) {
            base = { kind: "thinking", caption: "Researching", variant: activityVariant(memberKey, "thinking") };
        } else {
            base = { kind: "typing", caption: /cod|engineer|develop|debug|build|fix|software/.test(`${text} ${type}`) ? "Coding" : "Working", variant: activityVariant(memberKey, "typing") };
        }
    }
    // Still working, but past its SLA: keep the working animation, flag the clock.
    if (attention?.kind === "late") return { ...base, caption: `Running late on ${attention.title}` };
    // Health observations stay alongside work; they never replace its caption.
    return base;
}

/* ── Deterministic per-agent animation jitter ───────────────────────── */

export interface AnimTiming { delay: number; duration: number }

/**
 * Deterministic, per-agent, per-animation timing: a negative delay (so two
 * agents start mid-cycle instead of in lockstep) and a duration jitter of
 * ±spread. Same id + salt always returns the same values.
 */
export function animJitter(seed: string, salt: string, baseMs: number, spread = 0.25): AnimTiming {
    const h = hashString(`${seed}:${salt}`);
    const factor = 1 + (((h % 2001) / 2000) - 0.5) * 2 * spread; // 1±spread
    const duration = Math.max(1, Math.round(baseMs * factor));
    const phase = ((h >>> 5) % 1000) / 1000;
    return { delay: Math.round(-phase * duration), duration };
}

/** Blink intervals differ per agent: 3.5s–7s, never in lockstep. */
export function blinkTiming(seed: string): AnimTiming {
    const h = hashString(`${seed}:blink`);
    const duration = 3500 + (h % 3500);
    const phase = ((h >>> 6) % 1000) / 1000;
    return { delay: Math.round(-phase * duration), duration };
}

export interface AgentMotion {
    bob: AnimTiming;
    blink: AnimTiming;
    antenna: AnimTiming;
    chest: AnimTiming;
    cue: AnimTiming;
    typing: AnimTiming;
    screen: AnimTiming;
    routine: AnimTiming;
    celebrate: AnimTiming;
    wave: AnimTiming;
}

/** The full per-agent motion schedule, used to set CSS custom properties once per render. */
export function agentMotion(seed: string): AgentMotion {
    return {
        bob: animJitter(seed, "bob", 2600),
        blink: blinkTiming(seed),
        antenna: animJitter(seed, "antenna", 2200),
        chest: animJitter(seed, "chest", 3000),
        cue: animJitter(seed, "cue", 2600),
        typing: animJitter(seed, "typing", 3200),
        screen: animJitter(seed, "screen", 1600),
        routine: animJitter(seed, "routine", 28000, 0.35), // 20–45s desynced idle cycles
        celebrate: animJitter(seed, "celebrate", 30000),
        wave: animJitter(seed, "wave", 10000), // a gentle wave every ~8–12s
    };
}

/* ── Freshness (new-agent wave, recent-done celebration) ────────────── */

export const NEW_AGENT_MS = 24 * 60 * 60 * 1000;
export const DONE_WINDOW_MS = 10 * 60 * 1000;

export function isNewAgent(createdAt: string | null, now: Date): boolean {
    if (!createdAt) return false;
    const t = new Date(createdAt).getTime();
    const age = now.getTime() - t;
    return !Number.isNaN(t) && age >= 0 && age <= NEW_AGENT_MS;
}

/** Members with a "done" event in the last ~10 minutes. */
export function recentlyDoneKeys(events: ActivityEvent[], now: Date, windowMs = DONE_WINDOW_MS): Set<string> {
    const set = new Set<string>();
    for (const e of events) {
        if (e.eventType !== "task_done" || !e.actorKey) continue;
        const t = new Date(e.at).getTime();
        const age = now.getTime() - t;
        if (!Number.isNaN(t) && age >= 0 && age <= windowMs) set.add(e.actorKey);
    }
    return set;
}

/* ── Camera math ────────────────────────────────────────────────────── */

export interface CameraState { cx: number; cy: number; scale: number }

export const CAMERA_MIN_SCALE = 0.6;
export const CAMERA_MAX_SCALE = 4;

export function clampZoom(scale: number, min = CAMERA_MIN_SCALE, max = CAMERA_MAX_SCALE): number {
    return Math.min(max, Math.max(min, scale));
}

/** The viewBox actually visible for a camera state (fit = the whole floor). */
export function cameraViewBox(cam: CameraState, viewBox: { x: number; y: number; w: number; h: number }): { x: number; y: number; w: number; h: number } {
    const w = viewBox.w / cam.scale;
    const h = viewBox.h / cam.scale;
    return { x: cam.cx - w / 2, y: cam.cy - h / 2, w, h };
}

/** Default view: the whole busy part of the floor. */
export function fitCamera(viewBox: { x: number; y: number; w: number; h: number }): CameraState {
    return { cx: viewBox.x + viewBox.w / 2, cy: viewBox.y + viewBox.h / 2, scale: 1 };
}

/** Keep the camera centre inside the floor so panning can't get lost. */
export function clampCamera(cam: CameraState, viewBox: { x: number; y: number; w: number; h: number }): CameraState {
    const w = viewBox.w / cam.scale;
    const h = viewBox.h / cam.scale;
    const minCx = viewBox.x + w / 2;
    const maxCx = viewBox.x + viewBox.w - w / 2;
    const minCy = viewBox.y + h / 2;
    const maxCy = viewBox.y + viewBox.h - h / 2;
    const cx = maxCx < minCx ? viewBox.x + viewBox.w / 2 : Math.min(maxCx, Math.max(minCx, cam.cx));
    const cy = maxCy < minCy ? viewBox.y + viewBox.h / 2 : Math.min(maxCy, Math.max(minCy, cam.cy));
    return { cx, cy, scale: cam.scale };
}

/**
 * Zoom by `factor` while keeping the cursor's scene point fixed. fx/fy are the
 * cursor's fractional position inside the current view (0..1).
 */
export function zoomAtPoint(cam: CameraState, fx: number, fy: number, factor: number, viewBox: { x: number; y: number; w: number; h: number }, min = CAMERA_MIN_SCALE, max = CAMERA_MAX_SCALE): CameraState {
    const before = cameraViewBox(cam, viewBox);
    const sx = before.x + fx * before.w;
    const sy = before.y + fy * before.h;
    const scale = clampZoom(cam.scale * factor, min, max);
    const after = { x: 0, y: 0, w: viewBox.w / scale, h: viewBox.h / scale };
    after.x = sx - fx * after.w;
    after.y = sy - fy * after.h;
    return clampCamera({ cx: after.x + after.w / 2, cy: after.y + after.h / 2, scale }, viewBox);
}

/** Pan by a scene-space delta (screen px converted to scene units). */
export function panCamera(cam: CameraState, dx: number, dy: number, viewBox: { x: number; y: number; w: number; h: number }): CameraState {
    return clampCamera({ cx: cam.cx + dx, cy: cam.cy + dy, scale: cam.scale }, viewBox);
}

/** Centre on a point (an agent), keeping the current zoom level. */
export function centerOn(cam: CameraState, point: Point, viewBox: { x: number; y: number; w: number; h: number }): CameraState {
    return clampCamera({ cx: point.x, cy: point.y, scale: cam.scale }, viewBox);
}

/**
 * The CSS transform for the camera wrapper: translate + scale that maps the
 * viewBox onto a frame `frameW` px wide (the frame keeps the same aspect
 * ratio, so height is implied). Origin is top-left of the wrapper.
 */
export function worldTransform(cam: CameraState, viewBox: { x: number; y: number; w: number; h: number }, frameW: number): string {
    const frameH = (frameW * viewBox.h) / viewBox.w;
    const scale = cam.scale;
    const pcx = ((cam.cx - viewBox.x) / viewBox.w) * frameW;
    const pcy = ((cam.cy - viewBox.y) / viewBox.h) * frameH;
    const tx = frameW / 2 - scale * pcx;
    const ty = frameH / 2 - scale * pcy;
    return `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) scale(${scale.toFixed(4)})`;
}

/* ── Isometric projection ───────────────────────────────────────────── */

export const TILE_W = 64;
export const TILE_H = 32;
export const WALL_H = 160;

export interface Point { x: number; y: number }

/** Grid (gx, gy) in tiles plus height z in screen units → screen point. */
export function iso(gx: number, gy: number, z = 0): Point {
    return { x: (gx - gy) * (TILE_W / 2), y: (gx + gy) * (TILE_H / 2) - z };
}

/* ── Office layout ──────────────────────────────────────────────────── */

export const MAX_DESKS_PER_ZONE = 6;
export const MIN_DESKS_PER_ZONE = 2;
export const LOUNGE_SEATS = 4;
export const MIN_WORK_ZONES = 3;

const CELL = 3.8; // tiles per desk pod, both axes
const PAD = 0.8; // free tiles around the desks inside a zone
const BACK = 1.4; // strip at the back of a zone for its sign
const AISLE = 0.8; // walkway between zones
const LOUNGE_W = 10;
const LOUNGE_D = 9;

export interface SceneAgent {
    member: DashboardMember;
    status: SceneStatus;
    activity: string;
    zone: ZoneId;
    /** The animation + caption derived from this agent's real state. */
    behavior: Behavior;
    /** True when the agent was created in the last 24h (plays a one-shot wave). */
    isNew: boolean;
    /** Separate issues preserve the primary work state and agent identity. */
    notices?: AttentionEntry[];
}

export interface DeskSlot {
    /** Desk pod origin in tiles. */
    gx: number;
    gy: number;
    col: number;
    row: number;
    occupant: SceneAgent | null;
}

export interface LoungeSeat {
    gx: number;
    gy: number;
    pose: "sofa" | "standing";
    occupant: SceneAgent | null;
}

export interface ZoneLayout {
    meta: ZoneMeta;
    gx: number;
    gy: number;
    w: number;
    d: number;
    col: number;
    row: number;
    cols: number;
    rows: number;
    /** Which wall (if any) the sign hangs on. */
    signWall: "back" | "left" | "partition";
    desks: DeskSlot[];
    seats: LoungeSeat[];
    overflow: SceneAgent[];
}

export interface PlacedAgent extends SceneAgent {
    /** Where the character sits (floor point, tiles). */
    gx: number;
    gy: number;
    /** Screen-space anchor above the head, for labels and links. */
    anchor: Point;
    pose: "desk" | "sofa" | "standing";
}

export interface OfficeLayout {
    zones: ZoneLayout[];
    agents: PlacedAgent[];
    hiddenCount: number;
    /** Grid cells with no zone (an uneven zone count), filled with decor. */
    emptyCells: Array<{ gx: number; gy: number; w: number; d: number }>;
    width: number; // tiles along gx
    depth: number; // tiles along gy
    /** Camera crop: the busy part of the floor, not the whole diamond. */
    viewBox: { x: number; y: number; w: number; h: number };
    labelMode: LabelMode;
}

const STATUS_ORDER: Record<SceneStatus, number> = { blocked: 0, working: 1, waiting: 2, offline: 3, idle: 4 };

export function sortForDesks(a: SceneAgent, b: SceneAgent): number {
    return STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.member.name.localeCompare(b.member.name) || a.member.key.localeCompare(b.member.key);
}

export function deskGrid(count: number): { cols: number; rows: number; desks: number } {
    const needed = Math.min(MAX_DESKS_PER_ZONE, Math.max(MIN_DESKS_PER_ZONE, count));
    const cols = needed <= 4 ? 2 : 3;
    const rows = Math.ceil(needed / cols);
    // Fill the grid: a spare desk reads better than a hole in the room.
    return { cols, rows, desks: Math.min(MAX_DESKS_PER_ZONE, cols * rows) };
}

/** Busy floors get quieter labels so they stay legible. */
export function labelModeFor(visibleAgents: number): LabelMode {
    if (visibleAgents <= 8) return "full";
    if (visibleAgents <= 16) return "name";
    return "dot";
}

/** Work zones to draw: every zone with someone in it, topped up so the floor never looks empty. */
export function workZonesToRender(occupied: Set<WorkZoneId>): WorkZoneId[] {
    const zones = WORK_ZONE_ORDER.filter((z) => occupied.has(z));
    for (const z of WORK_ZONE_ORDER) {
        if (zones.length >= MIN_WORK_ZONES) break;
        if (z !== "operations" && !zones.includes(z)) zones.push(z);
    }
    return WORK_ZONE_ORDER.filter((z) => zones.includes(z));
}

/** Characters are drawn larger than the furniture grid, like a game sprite. */
export const CHARACTER_SCALE = 1.6;
const HEAD_HEIGHT = Math.round(72 * CHARACTER_SCALE) + 4; // seated height plus a little air, screen units

export function buildOfficeLayout(agents: SceneAgent[]): OfficeLayout {
    const byZone = new Map<ZoneId, SceneAgent[]>();
    for (const a of [...agents].sort(sortForDesks)) {
        const list = byZone.get(a.zone) ?? [];
        list.push(a);
        byZone.set(a.zone, list);
    }

    const workZones = workZonesToRender(new Set([...byZone.keys()].filter((z): z is WorkZoneId => z !== "lounge")));
    const order: ZoneId[] = [...workZones, "lounge"];
    const gridCols = order.length <= 4 ? 2 : 3;

    // First pass: footprint of every zone.
    const shells = order.map((id, index) => {
        const members = byZone.get(id) ?? [];
        if (id === "lounge") {
            return { id, members, col: index % gridCols, row: Math.floor(index / gridCols), w: LOUNGE_W, d: LOUNGE_D, cols: 0, rows: 0, desks: 0 };
        }
        const grid = deskGrid(members.length);
        return {
            id, members, col: index % gridCols, row: Math.floor(index / gridCols),
            w: grid.cols * CELL + PAD * 2, d: grid.rows * CELL + PAD + BACK, ...grid,
        };
    });
    // The lounge sits in the last cell of the grid, front-right.
    const lounge = shells[shells.length - 1];
    const lastRow = Math.floor((shells.length - 1) / gridCols);
    lounge.col = gridCols - 1;
    lounge.row = lastRow;

    const colWidths: number[] = [];
    const rowDepths: number[] = [];
    for (const s of shells) {
        colWidths[s.col] = Math.max(colWidths[s.col] ?? 0, s.w);
        rowDepths[s.row] = Math.max(rowDepths[s.row] ?? 0, s.d);
    }
    const colStart = colWidths.map((_, i) => colWidths.slice(0, i).reduce((sum, w) => sum + w + AISLE, AISLE));
    const rowStart = rowDepths.map((_, i) => rowDepths.slice(0, i).reduce((sum, d) => sum + d + AISLE, AISLE));
    const width = colStart[colStart.length - 1] + colWidths[colWidths.length - 1] + AISLE;
    const depth = rowStart[rowStart.length - 1] + rowDepths[rowDepths.length - 1] + AISLE;

    const zones: ZoneLayout[] = [];
    const placed: PlacedAgent[] = [];

    for (const s of shells) {
        // Zones stretch to fill their grid cell so aisles line up.
        const gx = colStart[s.col];
        const gy = rowStart[s.row];
        const w = colWidths[s.col];
        const d = rowDepths[s.row];
        const signWall: ZoneLayout["signWall"] = s.row === 0 ? "back" : s.col === 0 ? "left" : "partition";
        const zone: ZoneLayout = { meta: ZONES[s.id], gx, gy, w, d, col: s.col, row: s.row, cols: s.cols, rows: s.rows, signWall, desks: [], seats: [], overflow: [] };

        if (s.id === "lounge") {
            const spots: Array<Omit<LoungeSeat, "occupant">> = [
                { gx: gx + w - 3.2, gy: gy + 3.6, pose: "sofa" },
                { gx: gx + w - 3.2, gy: gy + 5.2, pose: "sofa" },
                { gx: gx + 2.6, gy: gy + 2.4, pose: "standing" },
                { gx: gx + 4.2, gy: gy + 6.6, pose: "standing" },
            ];
            zone.seats = spots.slice(0, LOUNGE_SEATS).map((spot, i) => ({ ...spot, occupant: s.members[i] ?? null }));
            zone.overflow = s.members.slice(LOUNGE_SEATS);
            zone.seats.forEach((seat) => {
                if (!seat.occupant) return;
                const z = seat.pose === "sofa" ? 12 : 0;
                placed.push({ ...seat.occupant, gx: seat.gx, gy: seat.gy, pose: seat.pose, anchor: iso(seat.gx, seat.gy, HEAD_HEIGHT + z + (seat.pose === "standing" ? 10 : 0)) });
            });
        } else {
            // Centre the desk block inside the (possibly stretched) zone.
            const offX = (w - (s.cols * CELL + PAD * 2)) / 2;
            const offY = (d - (s.rows * CELL + PAD + BACK)) / 2;
            for (let i = 0; i < s.desks; i++) {
                const col = i % s.cols;
                const row = Math.floor(i / s.cols);
                const desk: DeskSlot = { gx: gx + PAD + offX + col * CELL, gy: gy + BACK + offY + row * CELL, col, row, occupant: s.members[i] ?? null };
                zone.desks.push(desk);
                if (desk.occupant) {
                    const seat = deskSeat(desk);
                    placed.push({ ...desk.occupant, gx: seat.gx, gy: seat.gy, pose: "desk", anchor: iso(seat.gx, seat.gy, HEAD_HEIGHT) });
                }
            }
            zone.overflow = s.members.slice(s.desks);
        }
        zones.push(zone);
    }

    const emptyCells: OfficeLayout["emptyCells"] = [];
    for (let row = 0; row < rowDepths.length; row++) {
        for (let col = 0; col < colWidths.length; col++) {
            if (!shells.some((s) => s.col === col && s.row === row)) emptyCells.push({ gx: colStart[col], gy: rowStart[row], w: colWidths[col], d: rowDepths[row] });
        }
    }

    return {
        zones,
        agents: placed,
        hiddenCount: zones.reduce((sum, z) => sum + z.overflow.length, 0),
        emptyCells,
        width,
        depth,
        viewBox: cropViewBox(zones, placed, width, depth),
        labelMode: labelModeFor(placed.length),
    };
}

/**
 * Frame the floor like a camera: everything that carries information (desks,
 * people, labels, signs, the lounge) plus a margin, clipped to the floor
 * itself. Empty diamond corners fall outside the frame.
 */
export function cropViewBox(zones: ZoneLayout[], placed: PlacedAgent[], width: number, depth: number): OfficeLayout["viewBox"] {
    const points: Point[] = [];
    for (const z of zones) {
        for (const desk of z.desks) points.push(iso(desk.gx + 0.3, desk.gy + 3.1), iso(desk.gx + 3.7, desk.gy + 1.3), iso(desk.gx + 3.7, desk.gy + 3.1));
        if (z.meta.id === "lounge") points.push(iso(z.gx + 0.4, z.gy + 0.4, 70), iso(z.gx + z.w - 0.3, z.gy + 0.6), iso(z.gx + 0.4, z.gy + z.d - 0.3), iso(z.gx + z.w - 0.3, z.gy + z.d - 0.3));
        if (z.signWall === "back") points.push(iso(z.gx + 1.4, 0, WALL_H + 8), iso(z.gx + 7, 0, 40));
        if (z.signWall === "left") points.push(iso(0, z.gy + z.d - 0.8, WALL_H + 8), iso(0, z.gy + z.d - 6.5, 40));
        if (z.signWall === "partition") points.push(iso(z.gx + 0.8, z.gy, 96));
    }
    for (const p of placed) points.push({ x: p.anchor.x - 90, y: p.anchor.y - 48 }, { x: p.anchor.x + 90, y: p.anchor.y });
    const floor = { left: iso(0, depth).x - 30, right: iso(width, 0).x + 30, top: -WALL_H - 30, bottom: iso(width, depth).y + 30 };
    const margin = 36;
    const left = Math.max(floor.left, Math.min(...points.map((p) => p.x)) - margin);
    const right = Math.min(floor.right, Math.max(...points.map((p) => p.x)) + margin);
    const top = Math.max(floor.top, Math.min(...points.map((p) => p.y)) - margin);
    const bottom = Math.min(floor.bottom, Math.max(...points.map((p) => p.y)) + margin);
    return { x: Math.round(left), y: Math.round(top), w: Math.round(right - left), h: Math.round(bottom - top) };
}

export interface LabelBox { w: number; h: number }

/**
 * Push floating labels up until they stop overlapping, nearest-to-camera
 * first so front labels keep their spot. Sizes are in screen pixels; the
 * scale converts them to scene units for the current render width.
 */
export function labelLifts(placed: PlacedAgent[], unitsPerPx: number, box: LabelBox, maxLift = 140): Map<string, number> {
    const w = box.w * unitsPerPx;
    const h = box.h * unitsPerPx;
    const step = 6 * unitsPerPx;
    const taken: Array<{ x0: number; x1: number; y0: number; y1: number }> = [];
    const lifts = new Map<string, number>();
    for (const p of [...placed].sort((a, b) => b.anchor.y - a.anchor.y || a.anchor.x - b.anchor.x)) {
        let lift = 0;
        const rect = () => ({ x0: p.anchor.x - w / 2, x1: p.anchor.x + w / 2, y0: p.anchor.y - lift - h, y1: p.anchor.y - lift });
        const hits = () => taken.some((t) => { const r = rect(); return r.x0 < t.x1 && t.x0 < r.x1 && r.y0 < t.y1 && t.y0 < r.y1; });
        while (hits() && lift < maxLift) lift += step;
        taken.push(rect());
        lifts.set(p.member.key, lift);
    }
    return lifts;
}

/** Where the character sits relative to a desk pod. */
export function deskSeat(desk: Pick<DeskSlot, "gx" | "gy">): { gx: number; gy: number } {
    return { gx: desk.gx + 2.55, gy: desk.gy + 1.05 };
}

/* ── Collaboration links ────────────────────────────────────────────── */

export interface CollaborationLink {
    id: string;
    from: PlacedAgent;
    to: PlacedAgent;
    kind: CollaborationEvent["kind"];
    taskTitle: string;
}

/** One link per pair of visible agents, newest first. */
export function collaborationLinks(events: CollaborationEvent[], placed: PlacedAgent[], limit = 6): CollaborationLink[] {
    const byKey = new Map(placed.map((p) => [p.member.key, p]));
    const seen = new Set<string>();
    const links: CollaborationLink[] = [];
    for (const e of [...events].sort((a, b) => b.at.localeCompare(a.at))) {
        if (e.fromKey === e.toKey) continue;
        const from = byKey.get(e.fromKey);
        const to = byKey.get(e.toKey);
        if (!from || !to) continue;
        const pair = [e.fromKey, e.toKey].sort().join("|");
        if (seen.has(pair)) continue;
        seen.add(pair);
        links.push({ id: e.id, from, to, kind: e.kind, taskTitle: e.taskTitle });
        if (links.length >= limit) break;
    }
    return links;
}

/** A gentle arc between two screen points, bowed upward. */
export function arcPath(a: Point, b: Point): string {
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const lift = Math.min(90, Math.hypot(b.x - a.x, b.y - a.y) * 0.22);
    return `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} Q ${mx.toFixed(1)} ${(my - lift).toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
}

/* ── Task progress & copy ───────────────────────────────────────────── */

export const TASK_STEPS = ["Queued", "Working", "In review", "Done"] as const;

export function taskStep(state: string): { step: number; total: number } {
    const step = { inbox: 1, in_progress: 2, review: 3, done: 4 }[state] ?? 1;
    return { step, total: TASK_STEPS.length };
}

export function nextStepLabel(state: string): string {
    switch (state) {
        case "inbox": return "Start work";
        case "in_progress": return "Send for review";
        case "review": return "Approval and sign-off";
        default: return "Nothing — it is done";
    }
}

export function timeAgo(iso: string, now: Date): string {
    const minutes = Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h ago`;
    return `${Math.floor(minutes / 1440)}d ago`;
}

/** Ticker copy: [actor, verb, target?] so the UI can emphasise names. */
export function describeActivity(e: ActivityEvent): { actor: string; verb: string; target: string | null } {
    const title = `“${e.taskTitle}”`;
    switch (e.eventType) {
        case "task_reassigned":
        case "task_assigned":
            return e.targetName ? { actor: e.actorName, verb: `handed ${title} to`, target: e.targetName } : { actor: e.actorName, verb: `took over ${title}`, target: null };
        case "task_generated":
            return e.targetName ? { actor: e.actorName, verb: `created ${title} for`, target: e.targetName } : { actor: e.actorName, verb: `created ${title}`, target: null };
        case "task_note":
            return e.targetName ? { actor: e.actorName, verb: `left a note for`, target: e.targetName } : { actor: e.actorName, verb: `added a note to ${title}`, target: null };
        case "task_claimed":
            return { actor: e.actorName, verb: `picked up ${title}`, target: null };
        case "task_review":
            return { actor: e.actorName, verb: `sent ${title} for review`, target: null };
        case "task_done":
            return { actor: e.actorName, verb: `finished ${title}`, target: null };
        case "task_failed":
            return { actor: e.actorName, verb: `hit a problem on ${title}`, target: null };
        case "task_in_progress":
            return { actor: e.actorName, verb: `is working on ${title}`, target: null };
        default:
            return { actor: e.actorName, verb: `updated ${title}`, target: null };
    }
}

export function skillNames(skillsJson: unknown): string[] {
    if (!Array.isArray(skillsJson)) return [];
    return skillsJson
        .map((s) => (typeof s === "string" ? s : s && typeof s === "object" && typeof (s as { name?: unknown }).name === "string" ? (s as { name: string }).name : null))
        .filter((s): s is string => Boolean(s && s.trim()))
        .map((s) => s.trim());
}

/* ── Cost & throughput helpers ───────────────────────────────────────── */

/** Cents → "$12.34" (never invents data; null/NaN → null). */
export function formatCents(cents: number | null | undefined): string | null {
    if (cents === null || cents === undefined || !Number.isFinite(cents)) return null;
    return `$${(cents / 100).toFixed(2)}`;
}

/** Fraction of budget spent (0..1), or null when the budget is unlimited (≤0). */
export function budgetFraction(monthCents: number, budgetCents: number): number | null {
    if (!budgetCents || budgetCents <= 0) return null;
    return Math.max(0, Math.min(1, (monthCents || 0) / budgetCents));
}

/** True when an agent has spent >80% of a non-zero budget. */
export function isOverBudgetWarning(monthCents: number, budgetCents: number): boolean {
    const fraction = budgetFraction(monthCents, budgetCents);
    return fraction !== null && fraction > 0.8;
}

/** Median assigned→done cycle time from done tasks that have a start time. */
export function medianCycleMs(done: Array<{ startedAt: string | null; doneAt: string }>): number | null {
    const values: number[] = [];
    for (const t of done) {
        if (!t.startedAt) continue;
        const start = new Date(t.startedAt).getTime();
        const end = new Date(t.doneAt).getTime();
        if (Number.isNaN(start) || Number.isNaN(end) || end < start) continue;
        values.push(end - start);
    }
    if (values.length === 0) return null;
    values.sort((a, b) => a - b);
    const mid = Math.floor(values.length / 2);
    return values.length % 2 ? values[mid] : Math.round((values[mid - 1] + values[mid]) / 2);
}

/**
 * The single "today" boundary for done/spend metrics: a rolling 24-hour window.
 * There is no company timezone stored, so "today" is the last 24 hours (which
 * is how the UI labels it) rather than a local calendar midnight.
 */
export const DONE_TODAY_MS = 24 * 60 * 60 * 1000;

/**
 * Tasks done per 24-hour bucket over the last `days` days, oldest first. The
 * most recent bucket ("today") is the last 24 hours — consistent with the
 * `doneToday` / `DONE_TODAY_MS` definition used everywhere else.
 */
export function donePerDay(doneAt: Array<string | Date>, now: Date, days = 7): number[] {
    const buckets = Array(days).fill(0);
    const nowMs = now.getTime();
    for (const raw of doneAt) {
        const t = new Date(raw).getTime();
        if (Number.isNaN(t)) continue;
        const age = nowMs - t;
        if (age < 0) continue;
        const dayIndex = Math.floor(age / DONE_TODAY_MS);
        if (dayIndex < days) buckets[days - 1 - dayIndex] += 1;
    }
    return buckets;
}

/* ── "What's moving" feed ────────────────────────────────────────────── */

/** Recent activity from an agent pair thread. */
export interface PairThreadActivity {
    id: string;
    threadId: string;
    actorKey: string | null;
    actorName: string;
    targetKey: string | null;
    targetName: string | null;
    text: string;
    at: string;
}

/** Which task events belong in the movement feed (handoffs + review/done). */
function feedKindFor(eventType: string): FeedEvent["kind"] | null {
    switch (eventType) {
        case "task_assigned":
        case "task_reassigned":
            return "handoff";
        case "task_review":
            return "review";
        case "task_done":
            return "done";
        case "task_claimed":
            return "claim";
        case "task_note":
            return "note";
        default:
            return null;
    }
}

/** Build the live "What's moving" feed, newest first, capped at `limit`. */
export function buildFeed(activity: ActivityEvent[], pairs: PairThreadActivity[], limit = 8): FeedEvent[] {
    const items: FeedEvent[] = [];
    for (const e of activity) {
        const kind = feedKindFor(e.eventType);
        if (!kind) continue;
        const href = e.taskId ? `/projects?project=${e.projectId ?? ""}&task=${e.taskId}` : null;
        items.push({
            id: e.id, kind,
            actorKey: e.actorKey, actorName: e.actorName,
            targetKey: e.targetKey, targetName: e.targetName,
            text: e.taskTitle, href, at: e.at,
        });
    }
    for (const p of pairs) {
        items.push({
            id: p.id, kind: "pair",
            actorKey: p.actorKey, actorName: p.actorName,
            targetKey: p.targetKey, targetName: p.targetName,
            text: p.text, href: `/messages?group=${p.threadId}`, at: p.at,
        });
    }
    return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

/* ── View derivation ────────────────────────────────────────────────── */

/** Agents only — the live office doesn't seat people. */
export function deriveSceneAgents(data: Pick<DashboardData, "members" | "attention" | "activity" | "generatedAt">, playfulIdle = false, at?: Date): SceneAgent[] {
    const now = at ?? new Date(data.generatedAt);
    const justDone = recentlyDoneKeys(data.activity, now);
    const agents = data.members.filter((m) => m.kind === "agent");
    const idleRoutines = assignIdleRoutines(agents.filter((m) => sceneStatus(m) === "idle").map((m) => m.key));
    return agents.map((member) => {
        const { blocking, overlay } = memberAttention(data.attention, member.key);
        const pendingDecision = data.attention.find((entry) => entry.memberKey === member.key && entry.kind === "approval");
        const status = sceneStatus(member, blocking ?? pendingDecision ?? overlay);
        const attention = blocking ?? pendingDecision ?? overlay;
        const taskType = member.working[0]?.taskType ?? member.waiting[0]?.taskType ?? member.next[0]?.taskType ?? null;
        const behavior = deriveBehavior({
            status,
            activity: activityText(member, status, attention),
            memberKey: member.key,
            attention,
            justDone: justDone.has(member.key),
            taskType,
            idleRoutine: playfulIdle && status === "idle" ? idleRoutines.get(member.key) ?? null : null,
            liveActivity: Boolean(member.activity),
            checkIn: member.health === "attention" && !blocking,
            checkInReason: member.healthReasons[0] ?? null,
        });
        return { member, status, activity: activityText(member, status, attention), zone: zoneFor(member, status), behavior, isNew: isNewAgent(member.createdAt, now), notices: attentionForMember(data.attention, member.key) };
    });
}

export function kpiCounts(agents: SceneAgent[], data: Pick<DashboardData, "board" | "attention">): Record<KpiFilter, number> {
    return {
        working: agents.filter((a) => a.status === "working").length,
        waiting: agents.filter((a) => a.status === "waiting").length,
        done: agents.filter((a) => a.member.doneToday > 0).length,
        attention: data.attention.filter(requiresHumanAction).length,
    };
}

export function matchesQuery(agent: SceneAgent, query: string): boolean {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    const m = agent.member;
    return [m.name, m.role ?? "", agent.activity, ZONES[agent.zone].label, ...m.working.map((t) => t.title), ...m.waiting.map((t) => t.title), ...m.next.map((t) => t.title)]
        .some((text) => text.toLowerCase().includes(q));
}

export function taskMatchesQuery(task: DashboardTask, assigneeName: string | null, query: string): boolean {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return [task.title, task.projectName ?? "", assigneeName ?? ""].some((text) => text.toLowerCase().includes(q));
}

/** The busiest member, so the detail card is never empty when work is happening. */
export function defaultSelection(agents: SceneAgent[]): string | null {
    let best: SceneAgent | null = null;
    for (const a of agents) {
        if (!best || activityScore(a.member, a.status) > activityScore(best.member, best.status)) best = a;
    }
    return best?.member.key ?? null;
}

/** Snapshot freshness is visible even when a router refresh fails silently. */
export function snapshotFreshness(generatedAt: string, now: Date, online = true): "current" | "stale" | "offline" {
    if (!online) return "offline";
    const age = now.getTime() - Date.parse(generatedAt);
    return Number.isFinite(age) && age >= -15_000 && age <= 45_000 ? "current" : "stale";
}

/** Board filters select task states, never all tasks owned by a matching agent. */
export function filterDashboardBoard(board: DashboardData["board"], filters: { kpi: KpiFilter | null; query: string; zoneFilter: ZoneId | null; members: DashboardMember[] }): DashboardData["board"] {
    const members = new Map(filters.members.map((member) => [member.key, member]));
    const keep = (task: DashboardTask) => {
        const member = task.assigneeKey ? members.get(task.assigneeKey) : undefined;
        if (!taskMatchesQuery(task, member?.name ?? null, filters.query)) return false;
        if (filters.zoneFilter && (!member || zoneFor(member, sceneStatus(member)) !== filters.zoneFilter)) return false;
        return true;
    };
    return {
        inProgress: !filters.kpi || filters.kpi === "working" ? board.inProgress.filter(keep) : [],
        review: !filters.kpi || filters.kpi === "waiting" ? board.review.filter(keep) : [],
        done: !filters.kpi || filters.kpi === "done" ? board.done.filter(keep) : [],
    };
}

/** Company-wide dashboards never expose private chat activity descriptions. */
export function dashboardActivity(activity: string | null, threadType: string): string {
    return threadType === "team" || threadType === "group" ? activity?.trim() || "Working…" : "Working in a private chat";
}
