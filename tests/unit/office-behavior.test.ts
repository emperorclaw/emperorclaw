import assert from "node:assert/strict";
import test from "node:test";
import {
    agentMotion, animJitter, assignIdleRoutines, blinkTiming, buildOfficeLayout, CAMERA_MAX_SCALE, CAMERA_MIN_SCALE,
    cameraViewBox, centerOn, clampCamera, clampZoom, deriveBehavior, deriveSceneAgents, fitCamera, iso,
    panCamera, recentlyDoneKeys, worldTransform, zoomAtPoint, workZoneFor, activityText, sceneStatus,
    type AttentionEntry, type CameraState, type DashboardMember, type DashboardTask, type Point, type SceneAgent,
} from "../../src/lib/team-scene";

const viewBox = { x: -200, y: -180, w: 900, h: 420 };

const task = (state: string, title = "Write launch post", taskType: string | null = null): DashboardTask => ({
    id: `${state}-${title}`, projectId: "p1", projectName: "Launch", title, state, taskType, assigneeKey: null, updatedAt: "2026-10-07T10:00:00.000Z", dueAt: null,
});

const member = (overrides: Partial<DashboardMember> = {}): DashboardMember => ({
    key: "agent:a1", kind: "agent", id: "a1", name: "Growth", role: "Content Specialist", avatarUrl: null, skills: [],
    health: "healthy", healthReasons: [], activity: null, href: "/agents?agent=a1", createdAt: null, doneToday: 0, working: [], waiting: [], next: [],
    ...overrides,
});

const attn = (kind: AttentionEntry["kind"] = "approval"): AttentionEntry => ({
    id: `x:${kind}`, kind, title: "t", memberKey: "agent:a1", memberName: "Growth", area: "Launch",
    at: "2026-10-07T09:00:00.000Z", actionLabel: "Go", href: "/approvals",
});

const agent = (key: string, role: string, status: "working" | "idle" | "waiting" | "blocked" | "offline" = "working"): SceneAgent => {
    const m = member({
        key, id: key.split(":")[1] ?? key, name: key, role,
        health: status === "offline" ? "down" : "healthy",
        working: status === "working" ? [task("in_progress")] : [],
        waiting: status === "waiting" ? [task("review")] : [],
    });
    const scene = sceneStatus(m, status === "blocked" ? attn() : undefined);
    const a = activityText(m, scene, status === "blocked" ? attn() : undefined);
    return { member: m, status: scene, activity: a, zone: scene === "idle" ? "lounge" : workZoneFor(m), behavior: { kind: "typing", caption: "Coding", variant: 0 }, isNew: false };
};

const kb = (overrides: Parameters<typeof deriveBehavior>[0]): string => deriveBehavior({ memberKey: "agent:a1", taskType: null, idleRoutine: null, ...overrides }).kind;
const cap = (overrides: Parameters<typeof deriveBehavior>[0]): string => deriveBehavior({ memberKey: "agent:a1", taskType: null, idleRoutine: null, ...overrides }).caption;

test("state → behavior covers every state with a caption", () => {
    assert.equal(kb({ status: "offline", activity: "x" }), "offline");
    assert.equal(kb({ status: "blocked", activity: "x", attention: attn("incident") }), "blocked");
    assert.equal(cap({ status: "blocked", activity: "x", attention: attn("incident") }), "Stuck on an issue");
    assert.equal(kb({ status: "blocked", activity: "x", attention: attn("approval") }), "waiting");
    assert.equal(cap({ status: "blocked", activity: "x", attention: attn("approval") }), "Needs your approval");
    assert.equal(kb({ status: "blocked", activity: "x", attention: attn("message") }), "waiting");
    assert.equal(cap({ status: "blocked", activity: "x", attention: attn("message") }), "Waiting for your reply");
    assert.equal(kb({ status: "waiting", activity: "x" }), "reviewing");
    assert.equal(kb({ status: "idle", activity: "x", idleRoutine: "coffee" }), "coffee");
    assert.equal(cap({ status: "idle", activity: "x", idleRoutine: "coffee" }), "Coffee break");
    assert.equal(kb({ status: "idle", activity: "x", idleRoutine: "nap" }), "nap");
    assert.equal(kb({ status: "idle", activity: "x", idleRoutine: "stretch" }), "stretch");
    assert.equal(kb({ status: "working", activity: "whatever", talking: true }), "talking");
    assert.equal(kb({ status: "working", activity: "whatever", justDone: true }), "celebrate");
    assert.equal(kb({ status: "working", activity: "Whatever", taskType: "engineering" }), "typing");
    assert.equal(kb({ status: "working", activity: "Whatever", taskType: "content" }), "writing");
    assert.equal(kb({ status: "working", activity: "Whatever", taskType: "research" }), "thinking");
    assert.equal(kb({ status: "working", activity: "Whatever", taskType: "qa" }), "reviewing");
    assert.equal(kb({ status: "working", activity: "Presenting roadmap" }), "presenting");
});

test("deterministic jitter is stable per id, different across ids, within bounds", () => {
    const a = animJitter("agent-1", "bob", 1000);
    assert.deepEqual(a, animJitter("agent-1", "bob", 1000));
    const b = animJitter("agent-2", "bob", 1000);
    // Duration jitter stays within ±25%.
    assert.ok(a.duration >= 750 && a.duration <= 1250);
    assert.ok(b.duration >= 750 && b.duration <= 1250);
    // Negative delay starts the agent mid-cycle.
    assert.ok(a.delay <= 0 && a.delay >= -a.duration);
    // Across many ids, durations differ.
    const durations = new Set(Array.from({ length: 12 }, (_, i) => animJitter(`id-${i}`, "bob", 2000).duration));
    assert.ok(durations.size > 4, "durations vary across agents");
});

test("blink intervals differ per agent and stay in 3.5s–7s", () => {
    for (let i = 0; i < 20; i++) {
        const t = blinkTiming(`agent-${i}`);
        assert.ok(t.duration >= 3500 && t.duration <= 7000, `blink ${i} in range`);
        assert.ok(t.delay <= 0 && t.delay >= -t.duration);
    }
    const d = new Set(Array.from({ length: 20 }, (_, i) => blinkTiming(`a-${i}`).duration));
    assert.ok(d.size > 5, "blink durations vary");
});

test("agentMotion exposes every animation with valid timing", () => {
    const m = agentMotion("seed-x");
    for (const t of [m.bob, m.blink, m.antenna, m.chest, m.cue, m.typing, m.screen, m.routine, m.celebrate]) {
        assert.ok(t.duration > 0 && t.delay <= 0);
    }
    assert.ok(m.routine.duration >= 20000 && m.routine.duration <= 45000, "idle cycles are long and desynced");
});

test("idle routines cap concurrent walkers and stay deterministic", () => {
    const keys = Array.from({ length: 9 }, (_, i) => `agent:${i}`);
    const a = assignIdleRoutines(keys);
    const b = assignIdleRoutines(keys);
    assert.deepEqual(a, b, "deterministic per set");
    const walkers = [...a.values()].filter((r) => r === "coffee");
    assert.equal(walkers.length, 3, "at most three coffee breaks at once");
    const rest = [...a.values()].filter((r) => r !== "coffee");
    assert.ok(rest.every((r) => r === "nap" || r === "stretch"));
    // A smaller team takes fewer coffee breaks.
    assert.equal([...assignIdleRoutines(["a", "b"]).values()].filter((r) => r === "coffee").length, 2);
});

test("camera clamps zoom and keeps the cursor's scene point fixed while zooming", () => {
    assert.equal(clampZoom(0.1), CAMERA_MIN_SCALE);
    assert.equal(clampZoom(99), CAMERA_MAX_SCALE);
    const cam = fitCamera(viewBox);
    assert.equal(cam.scale, 1);
    const fx = 0.3, fy = 0.6;
    const before = cameraViewBox(cam, viewBox);
    const sx = before.x + fx * before.w, sy = before.y + fy * before.h;
    const zoomed = zoomAtPoint(cam, fx, fy, 1.6, viewBox);
    const after = cameraViewBox(zoomed, viewBox);
    assert.ok(Math.abs((after.x + fx * after.w) - sx) < 0.001);
    assert.ok(Math.abs((after.y + fy * after.h) - sy) < 0.001);
});

test("camera pan and center stay inside the floor", () => {
    const cam = fitCamera(viewBox);
    const panned = panCamera(cam, 5000, -9000, viewBox);
    const v = cameraViewBox(panned, viewBox);
    assert.ok(v.x >= viewBox.x && v.x + v.w <= viewBox.x + viewBox.w);
    const centered = centerOn({ cx: 9999, cy: -9999, scale: 2 }, { x: 0, y: 0 }, viewBox);
    assert.equal(centered.scale, 2);
    assert.ok(centered.cx <= viewBox.x + viewBox.w && centered.cy <= viewBox.y + viewBox.h);
    const clamped = clampCamera({ cx: 1e6, cy: -1e6, scale: 0.5 }, viewBox);
    assert.equal(clamped.cx, viewBox.x + viewBox.w / 2, "zoomed-out camera centres");
});

test("world transform maps the camera centre to the middle of the frame", () => {
    const cam: CameraState = { cx: 0, cy: 0, scale: 2 };
    const frameW = 800;
    const t = worldTransform(cam, { x: -100, y: -100, w: 200, h: 200 }, frameW);
    // Scene centre (0,0) lands at the frame centre (400px) under scale 2:
    // translate = 400 - 2 * (0 - -100)/200 * 800 = 400 - 800 = -400.
    assert.equal(t, "translate(-400.00px, -400.00px) scale(2.0000)");
});

test("recentlyDoneKeys flags only task_done events inside the window", () => {
    const now = new Date("2026-10-07T12:00:00.000Z");
    const events = [
        { id: "1", eventType: "task_done", actorKey: "agent:a", actorName: "A", targetName: null, taskTitle: "T", at: "2026-10-07T11:55:00.000Z" },
        { id: "2", eventType: "task_done", actorKey: "agent:b", actorName: "B", targetName: null, taskTitle: "T", at: "2026-10-07T11:00:00.000Z" },
        { id: "3", eventType: "task_in_progress", actorKey: "agent:c", actorName: "C", targetName: null, taskTitle: "T", at: "2026-10-07T11:59:00.000Z" },
    ];
    const set = recentlyDoneKeys(events, now);
    assert.equal(set.has("agent:a"), true);
    assert.equal(set.has("agent:b"), false, "older than 10 minutes");
    assert.equal(set.has("agent:c"), false, "not a done event");
});

test("layout scales from 4 to 40 agents without overlapping zones or desks", () => {
    const roles = ["Research analyst", "Content writer", "Backend developer", "QA tester", "Office manager"];
    for (const count of [4, 10, 20, 40]) {
        const agents = Array.from({ length: count }, (_, i) => {
            const role = roles[i % roles.length];
            const key = `agent:${role.replace(/\W/g, "")}-${i}`;
            return agent(key, role, i % 5 === 0 ? "idle" : "working");
        });
        const layout = buildOfficeLayout(agents);
        assert.equal(layout.agents.length + layout.hiddenCount, count, `place or overflow ${count} agents`);
        assert.ok(layout.agents.length > 0, `some agents placed @ ${count}`);
        for (const a of layout.zones) {
            for (const b of layout.zones) {
                if (a === b) continue;
                const overlap = a.gx < b.gx + b.w && b.gx < a.gx + a.w && a.gy < b.gy + b.d && b.gy < a.gy + a.d;
                assert.equal(overlap, false, `${a.meta.id} overlaps ${b.meta.id} @ ${count}`);
            }
        }
        // No two placed agents share the same seat.
        const seats = new Set(layout.agents.map((p) => `${p.gx.toFixed(2)},${p.gy.toFixed(2)}`));
        assert.equal(seats.size, layout.agents.length, `no desk collisions @ ${count}`);
        for (const p of layout.agents) {
            assert.ok(p.gx > 0 && p.gx < layout.width && p.gy > 0 && p.gy < layout.depth, `in floor @ ${count}`);
        }
    }
    const full = buildOfficeLayout(Array.from({ length: 40 }, (_, i) => agent(`agent:${i}`, roles[i % roles.length])));
    assert.equal(full.labelMode, "dot");
    assert.ok(full.hiddenCount > 0, "a crowded floor shows overflow chips");
});

test("deriveSceneAgents seats agents only and computes behaviour + captions", () => {
    const data = {
        members: [
            member({ key: "agent:w", id: "w", name: "Worker", working: [task("in_progress", "Fix login", "engineering")] }),
            member({ key: "agent:i", id: "i", name: "Idle" }),
            member({ key: "human:p", id: "p", kind: "human", name: "Person", working: [task("in_progress", "Human task")] }),
        ],
        attention: [],
        activity: [],
        generatedAt: "2026-10-07T12:00:00.000Z",
    };
    const agents = deriveSceneAgents(data);
    assert.equal(agents.length, 2, "humans never appear");
    assert.ok(agents.every((a) => a.member.kind === "agent"));
    const worker = agents.find((a) => a.member.key === "agent:w")!;
    assert.equal(worker.behavior.kind, "typing");
    assert.equal(worker.behavior.caption, "Coding");
    assert.equal(worker.isNew, false);
    const idle = agents.find((a) => a.member.key === "agent:i")!;
    assert.equal(idle.zone, "lounge");
    assert.ok(["coffee", "nap", "stretch"].includes(idle.behavior.kind));
});
