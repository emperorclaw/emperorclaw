/**
 * Pure model for the "Your team, in motion" dashboard: status mapping, zone
 * assignment, the isometric office layout and the copy derived from real
 * agent/task data. No React, no database — everything here is unit-tested.
 */

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
    skills: string[];
    health: HealthStatus | null;
    healthReasons: string[];
    /** Live "typing" activity reported by the runtime, if any. */
    activity: string | null;
    href: string;
    doneToday: number;
    working: DashboardTask[];
    waiting: DashboardTask[];
    next: DashboardTask[];
}

export type AttentionKind = "approval" | "incident" | "message" | "agent";

export interface AttentionEntry {
    id: string;
    kind: AttentionKind;
    title: string;
    memberKey: string | null;
    memberName: string | null;
    area: string | null;
    at: string;
    actionLabel: string;
    href: string;
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
    taskTitle: string;
    at: string;
}

export interface DashboardData {
    generatedAt: string;
    members: DashboardMember[];
    board: { inProgress: DashboardTask[]; review: DashboardTask[]; done: DashboardTask[] };
    attention: AttentionEntry[];
    collaborations: CollaborationEvent[];
    activity: ActivityEvent[];
}

/* ── Status ─────────────────────────────────────────────────────────── */

/** Which members have something waiting on a human. */
export function attentionByMember(entries: AttentionEntry[]): Map<string, AttentionEntry> {
    const map = new Map<string, AttentionEntry>();
    for (const entry of entries) {
        if (entry.memberKey && !map.has(entry.memberKey)) map.set(entry.memberKey, entry);
    }
    return map;
}

export function sceneStatus(member: DashboardMember, attention?: AttentionEntry | null): SceneStatus {
    if (member.health === "down") return "offline";
    if (attention || member.health === "attention") return "blocked";
    if (member.working.length > 0 || member.activity) return "working";
    if (member.waiting.length > 0) return "waiting";
    return "idle";
}

const BLOCKED_COPY: Record<AttentionKind, string> = {
    approval: "Waiting for approval",
    incident: "Hit a problem",
    message: "Waiting for a reply",
    agent: "Needs a check-in",
};

function sentence(text: string): string {
    const trimmed = text.trim().replace(/[.…]+$/, "");
    return trimmed ? trimmed[0].toUpperCase() + trimmed.slice(1) : trimmed;
}

/** The one-line "what is this agent doing" shown on the floating label. */
export function activityText(member: DashboardMember, status: SceneStatus, attention?: AttentionEntry | null): string {
    switch (status) {
        case "offline":
            return member.working.length + member.waiting.length > 0 ? "Offline with work waiting" : "Offline";
        case "blocked":
            if (attention) return BLOCKED_COPY[attention.kind];
            return member.healthReasons[0] ? sentence(member.healthReasons[0]) : "Needs you";
        case "working":
            if (member.activity && !/^working…?$/i.test(member.activity.trim())) return sentence(member.activity);
            return member.working[0]?.title ?? "Working";
        case "waiting":
            return "Waiting for review";
        default:
            return "Available";
    }
}

export const STATUS_LABEL: Record<SceneStatus, string> = {
    working: "Working",
    waiting: "In review",
    blocked: "Needs you",
    idle: "Available",
    offline: "Offline",
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

export function hashString(input: string): number {
    let h = 2166136261;
    for (let i = 0; i < input.length; i++) {
        h ^= input.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

const AVATAR_HUES = [190, 265, 150, 38, 340, 210, 95, 20, 300, 170];

export interface AvatarVariant {
    body: "robot" | "human";
    hue: number;
    skin: number;
    hair: number;
    accessory: "none" | "glasses" | "headset" | "cap";
}

export function avatarVariant(id: string, kind: "agent" | "human"): AvatarVariant {
    const h = hashString(id);
    // Most agents are robots; a third read as people, like the humans on the team.
    const body = kind === "human" || h % 3 === 0 ? "human" : "robot";
    const accessories: AvatarVariant["accessory"][] = ["none", "glasses", "headset", "cap", "none"];
    return {
        body,
        hue: AVATAR_HUES[h % AVATAR_HUES.length],
        skin: (h >>> 4) % 5,
        hair: (h >>> 8) % 6,
        accessory: accessories[(h >>> 12) % accessories.length],
    };
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
export const CHARACTER_SCALE = 1.3;
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

/* ── View derivation ────────────────────────────────────────────────── */

/** Everyone who belongs on the floor: all agents, plus people with open work. */
export function deriveSceneAgents(data: Pick<DashboardData, "members" | "attention">): SceneAgent[] {
    const attention = attentionByMember(data.attention);
    return data.members
        .filter((m) => m.kind === "agent" || m.working.length + m.waiting.length + m.next.length > 0 || attention.has(m.key))
        .map((member) => {
            const entry = attention.get(member.key) ?? null;
            const status = sceneStatus(member, entry);
            return { member, status, activity: activityText(member, status, entry), zone: zoneFor(member, status) };
        });
}

export function kpiCounts(agents: SceneAgent[], data: Pick<DashboardData, "board" | "attention">): Record<KpiFilter, number> {
    return {
        working: agents.filter((a) => a.status === "working").length,
        waiting: agents.filter((a) => a.status === "waiting").length,
        done: data.board.done.length,
        attention: data.attention.length,
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
