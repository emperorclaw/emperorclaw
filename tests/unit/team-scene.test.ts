import assert from "node:assert/strict";
import test from "node:test";
import {
    activityText, arcPath, avatarVariant, buildOfficeLayout, collaborationLinks, defaultSelection, deriveSceneAgents, deskGrid, describeActivity,
    iso, kpiCounts, labelLifts, labelModeFor, LOUNGE_SEATS, matchesKpi, MAX_DESKS_PER_ZONE, MIN_WORK_ZONES, sceneStatus, skillNames, taskStep, timeAgo,
    workZoneFor, workZonesToRender,
    type AttentionEntry, type DashboardMember, type DashboardTask, type SceneAgent,
} from "../../src/lib/team-scene";

const task = (state: string, title = "Write launch post"): DashboardTask => ({
    id: `${state}-${title}`, projectId: "p1", projectName: "Launch", title, state, taskType: null, assigneeKey: null, updatedAt: "2026-10-07T10:00:00.000Z", dueAt: null,
});

const member = (overrides: Partial<DashboardMember> = {}): DashboardMember => ({
    key: "agent:a1", kind: "agent", id: "a1", name: "Growth", role: "Content Specialist", avatarUrl: null, skills: [],
    health: "healthy", healthReasons: [], activity: null, href: "/agents?agent=a1", createdAt: null, doneToday: 0, working: [], waiting: [], next: [],
    ...overrides,
});

const approval = (memberKey: string): AttentionEntry => ({
    id: `approval:${memberKey}`, kind: "approval", title: "Approve blog draft", memberKey, memberName: "Growth", area: "Launch",
    at: "2026-10-07T09:00:00.000Z", actionLabel: "Review work", href: "/approvals",
});

const agentsInZone = (count: number, zoneRole: string, status: "working" | "idle" = "working"): SceneAgent[] =>
    Array.from({ length: count }, (_, i) => {
        const m = member({ key: `agent:${zoneRole}-${i}`, id: `${zoneRole}-${i}`, name: `${zoneRole} ${i}`, role: zoneRole, working: status === "working" ? [task("in_progress")] : [] });
        const s = sceneStatus(m);
        return { member: m, status: s, activity: activityText(m, s), zone: s === "idle" ? "lounge" : workZoneFor(m), behavior: { kind: s === "idle" ? "nap" : "typing", caption: s === "idle" ? "Napping" : "Coding", variant: 0 }, isNew: false };
    });

test("status mapping prefers offline, then needs-you, then work", () => {
    assert.equal(sceneStatus(member({ health: "down", working: [task("in_progress")] })), "offline");
    assert.equal(sceneStatus(member({ working: [task("in_progress")] }), approval("agent:a1")), "blocked");
    assert.equal(sceneStatus(member({ health: "attention" })), "idle", "health attention alone is a check-in hint, not stuck");
    assert.equal(sceneStatus(member({ health: "attention", working: [task("in_progress")] })), "working");
    assert.equal(sceneStatus(member({ working: [task("in_progress")] })), "working");
    assert.equal(sceneStatus(member({ activity: "typing…" })), "working");
    assert.equal(sceneStatus(member({ waiting: [task("review")] })), "waiting");
    assert.equal(sceneStatus(member()), "idle");
});

test("activity copy comes from live activity, the task, or the blocker", () => {
    assert.equal(activityText(member({ activity: "writing article…" }), "working"), "Writing article");
    assert.equal(activityText(member({ activity: "working…", working: [task("in_progress", "Fix login")] }), "working"), "Fix login");
    assert.equal(activityText(member(), "blocked", approval("agent:a1")), "Waiting for approval");
    assert.equal(activityText(member({ healthReasons: ["2 unanswered messages"] }), "blocked"), "2 unanswered messages");
    assert.equal(activityText(member(), "idle"), "Available");
});

test("zones are assigned by role, then skills, then name, with a fallback", () => {
    assert.equal(workZoneFor({ name: "Hermes QA", role: null, skills: [] }), "qa");
    assert.equal(workZoneFor({ name: "LeadExtractor", role: null, skills: [] }), "research");
    assert.equal(workZoneFor({ name: "Growth", role: "Content Specialist", skills: [] }), "content");
    assert.equal(workZoneFor({ name: "Hermes Architect", role: "Software architect", skills: [] }), "engineering");
    assert.equal(workZoneFor({ name: "Max", role: null, skills: ["seo", "copywriting"] }), "content");
    assert.equal(workZoneFor({ name: "Pat", role: "Executive assistant", skills: [] }), "operations");
    // Role outranks a misleading name.
    assert.equal(workZoneFor({ name: "Data Bot", role: "Backend developer", skills: [] }), "engineering");
});

test("the floor always shows at least three work zones and the lounge", () => {
    assert.equal(workZonesToRender(new Set()).length, MIN_WORK_ZONES);
    assert.deepEqual(workZonesToRender(new Set(["operations"])), ["research", "content", "operations"]);
    assert.deepEqual(workZonesToRender(new Set(["qa", "engineering", "research", "content"])), ["research", "content", "engineering", "qa"]);
    const empty = buildOfficeLayout([]);
    assert.equal(empty.agents.length, 0);
    assert.equal(empty.zones.length, MIN_WORK_ZONES + 1);
    assert.equal(empty.zones.at(-1)?.meta.id, "lounge");
    assert.ok(empty.viewBox.w > 0 && empty.viewBox.h > 0);
});

test("desk grids grow with the team and cap with an overflow", () => {
    assert.deepEqual(deskGrid(0), { cols: 2, rows: 1, desks: 2 });
    assert.deepEqual(deskGrid(3), { cols: 2, rows: 2, desks: 4 });
    assert.deepEqual(deskGrid(5), { cols: 3, rows: 2, desks: 6 });
    assert.deepEqual(deskGrid(40), { cols: 3, rows: 2, desks: MAX_DESKS_PER_ZONE });

    const crowded = buildOfficeLayout(agentsInZone(9, "Content writer"));
    const content = crowded.zones.find((z) => z.meta.id === "content")!;
    assert.equal(content.desks.filter((d) => d.occupant).length, MAX_DESKS_PER_ZONE);
    assert.equal(content.overflow.length, 3);
    assert.equal(crowded.hiddenCount, 3);
    assert.equal(crowded.agents.length, MAX_DESKS_PER_ZONE);
});

test("idle agents go to the lounge, which also overflows", () => {
    const layout = buildOfficeLayout(agentsInZone(6, "Content writer", "idle"));
    const lounge = layout.zones.find((z) => z.meta.id === "lounge")!;
    assert.equal(lounge.seats.filter((s) => s.occupant).length, LOUNGE_SEATS);
    assert.equal(lounge.overflow.length, 6 - LOUNGE_SEATS);
    assert.ok(layout.agents.every((a) => a.pose !== "desk"));
});

test("a large team lays out every zone without overlapping zones", () => {
    const team = [
        ...agentsInZone(4, "Research analyst"), ...agentsInZone(4, "Content writer"), ...agentsInZone(4, "Backend developer"),
        ...agentsInZone(4, "QA tester"), ...agentsInZone(4, "Office manager"), ...agentsInZone(3, "Content writer", "idle"),
    ];
    const layout = buildOfficeLayout(team);
    assert.equal(layout.zones.length, 6);
    assert.equal(layout.agents.length, team.length);
    for (const a of layout.zones) {
        for (const b of layout.zones) {
            if (a === b) continue;
            const overlap = a.gx < b.gx + b.w && b.gx < a.gx + a.w && a.gy < b.gy + b.d && b.gy < a.gy + a.d;
            assert.equal(overlap, false, `${a.meta.id} overlaps ${b.meta.id}`);
        }
    }
    assert.equal(layout.labelMode, "dot");
    // Every agent stays inside the floor.
    assert.ok(layout.agents.every((p) => p.gx > 0 && p.gx < layout.width && p.gy > 0 && p.gy < layout.depth));
});

test("label density drops as the floor fills up", () => {
    assert.equal(labelModeFor(3), "full");
    assert.equal(labelModeFor(8), "full");
    assert.equal(labelModeFor(12), "name");
    assert.equal(labelModeFor(24), "dot");
});

test("blocked agents are seated before idle ones so the overflow hides the quiet ones", () => {
    const team = agentsInZone(7, "Content writer");
    const blocked = { ...team[6], status: "blocked" as const, member: { ...team[6].member, name: "Zed" } };
    const layout = buildOfficeLayout([...team.slice(0, 6), blocked]);
    assert.ok(layout.agents.some((a) => a.member.name === "Zed"));
});

test("collaboration links dedupe pairs and skip hidden agents", () => {
    const layout = buildOfficeLayout([...agentsInZone(2, "Content writer"), ...agentsInZone(1, "QA tester")]);
    const [a, b] = layout.agents.filter((p) => p.zone === "content");
    const qa = layout.agents.find((p) => p.zone === "qa")!;
    const events = [
        { id: "e1", fromKey: a.member.key, toKey: qa.member.key, kind: "handoff" as const, taskTitle: "Draft", at: "2026-10-07T10:00:00.000Z" },
        { id: "e2", fromKey: qa.member.key, toKey: a.member.key, kind: "review" as const, taskTitle: "Draft", at: "2026-10-07T11:00:00.000Z" },
        { id: "e3", fromKey: b.member.key, toKey: "agent:ghost", kind: "handoff" as const, taskTitle: "Ghost", at: "2026-10-07T12:00:00.000Z" },
        { id: "e4", fromKey: b.member.key, toKey: b.member.key, kind: "handoff" as const, taskTitle: "Self", at: "2026-10-07T12:00:00.000Z" },
    ];
    const links = collaborationLinks(events, layout.agents);
    assert.equal(links.length, 1);
    assert.equal(links[0].id, "e2");
    assert.equal(links[0].kind, "review");
    assert.match(arcPath(iso(0, 0), iso(4, 0)), /^M .* Q .*/);
});

test("avatar variants are stable per id and people always look human", () => {
    assert.deepEqual(avatarVariant("agent-123", "agent"), avatarVariant("agent-123", "agent"));
    assert.equal(avatarVariant("member-9", "human").body, "human");
    const bodies = new Set(Array.from({ length: 30 }, (_, i) => avatarVariant(`agent-${i}`, "agent").body));
    assert.deepEqual([...bodies].sort(), ["human", "robot"]);
});

test("kpis, filters and default selection follow real status", () => {
    const working = member({ key: "agent:w", id: "w", name: "Worker", working: [task("in_progress")], doneToday: 2 });
    const waiting = member({ key: "agent:r", id: "r", name: "Reviewer", waiting: [task("review")] });
    const idle = member({ key: "agent:i", id: "i", name: "Idle" });
    const blocked = member({ key: "agent:b", id: "b", name: "Blocked" });
    const person = member({ key: "human:p", id: "p", kind: "human", name: "Quiet person" });
    const data = {
        members: [working, waiting, idle, blocked, person],
        attention: [approval("agent:b")],
        board: { inProgress: [], review: [], done: [task("done")] },
        activity: [],
        generatedAt: "2026-10-07T12:00:00.000Z",
    };
    const agents = deriveSceneAgents(data);
    assert.equal(agents.length, 4, "people never sit in the office, even with open work");
    assert.deepEqual(kpiCounts(agents, data), { working: 1, waiting: 1, done: 1, attention: 1 });
    assert.equal(agents.find((a) => a.member.key === "agent:b")?.status, "blocked");
    assert.equal(agents.find((a) => a.member.key === "agent:i")?.zone, "lounge");
    assert.equal(defaultSelection(agents), "agent:w");
    assert.equal(defaultSelection([]), null);
    assert.equal(matchesKpi("done", working, "working"), true);
    assert.equal(matchesKpi("attention", idle, "idle"), false);
    assert.equal(matchesKpi(null, idle, "idle"), true);
});

test("task steps, time and ticker copy", () => {
    assert.deepEqual(taskStep("in_progress"), { step: 2, total: 4 });
    assert.deepEqual(taskStep("done"), { step: 4, total: 4 });
    const now = new Date("2026-10-07T12:00:00.000Z");
    assert.equal(timeAgo("2026-10-07T11:59:40.000Z", now), "just now");
    assert.equal(timeAgo("2026-10-07T10:00:00.000Z", now), "2h ago");
    const line = describeActivity({ id: "1", eventType: "task_reassigned", actorKey: "agent:g", actorName: "Growth", targetName: "Hermes QA", taskTitle: "Draft", at: now.toISOString() });
    assert.deepEqual(line, { actor: "Growth", verb: "handed “Draft” to", target: "Hermes QA" });
    assert.deepEqual(skillNames(["seo", { name: "writing" }, 4, null, "  "]), ["seo", "writing"]);
});

test("labels are lifted until they stop overlapping", () => {
    const layout = buildOfficeLayout(agentsInZone(6, "Content writer"));
    const box = { w: 160, h: 50 };
    const unitsPerPx = 1.4;
    const lifts = labelLifts(layout.agents, unitsPerPx, box);
    const rects = layout.agents.map((a) => {
        const lift = lifts.get(a.member.key) ?? 0;
        return { x0: a.anchor.x - (box.w * unitsPerPx) / 2, x1: a.anchor.x + (box.w * unitsPerPx) / 2, y0: a.anchor.y - lift - box.h * unitsPerPx, y1: a.anchor.y - lift };
    });
    for (const [i, a] of rects.entries()) {
        for (const b of rects.slice(i + 1)) {
            assert.equal(a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1, false);
        }
    }
});

test("the camera crops empty floor corners but keeps every label in frame", () => {
    const layout = buildOfficeLayout(agentsInZone(3, "Research analyst"));
    const full = { left: iso(0, layout.depth).x, right: iso(layout.width, 0).x };
    const vb = layout.viewBox;
    assert.ok(vb.w < full.right - full.left + 60, "the crop is tighter than the whole floor");
    for (const a of layout.agents) {
        assert.ok(a.anchor.x > vb.x && a.anchor.x < vb.x + vb.w && a.anchor.y > vb.y && a.anchor.y < vb.y + vb.h);
    }
});
