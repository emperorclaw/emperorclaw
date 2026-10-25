import { test } from "node:test";
import assert from "node:assert/strict";
import {
    CHAT_ROW_ID,
    formatHours,
    groupTimelineByProject,
    joinAgentNames,
    summarizeTimeSpent,
    type TimelineActor,
    type TimelineEvent,
    type TimelineSpan,
} from "../../src/lib/work-timeline";

const H = 3_600_000;

function span(overrides: Partial<TimelineSpan> & { id: string; start: number; end: number }): TimelineSpan {
    return {
        actorId: "agent:builder",
        taskId: "t1",
        taskTitle: "Stayolo hotfix",
        projectName: "Stayolo",
        customerName: "Stayolo Ltd",
        projectId: "p1",
        kind: "task",
        threadLabel: null,
        href: "/projects/tasks/t1",
        running: false,
        outcome: "done",
        source: "automation",
        status: "succeeded",
        triggerKind: "message",
        startedAtMs: overrides.start,
        endedAtMs: overrides.end,
        durationMs: overrides.end - overrides.start,
        tokens: 0,
        costCents: 0,
        toolCalls: null,
        model: null,
        ...overrides,
    };
}

function chat(id: string, start: number, end: number, actorId = "agent:builder", costCents = 0): TimelineSpan {
    return span({ id, start, end, actorId, costCents, kind: "chat", taskId: null, taskTitle: null, projectName: null, customerName: null, projectId: null, threadLabel: "Chat with Builder", href: "/messages?agent=x" });
}

function actor(id: string, name: string): TimelineActor {
    return { id, kind: "agent", name, initials: name.slice(0, 2).toUpperCase(), avatarUrl: null, colour: "hsl(1 72% 60%)", runCount: 0, busyMs: 0, tokens: 0, costCents: 0 };
}

const actors = [actor("agent:builder", "Builder"), actor("agent:qa", "QA"), actor("agent:seo", "SEO")];

// ─── groupTimelineByProject ─────────────────────────────────────────────────

test("groupTimelineByProject makes one row per project, busiest first, chat last", () => {
    const rows = groupTimelineByProject({
        spans: [
            chat("c1", 0, 5 * H),
            span({ id: "r1", start: 0, end: H, projectId: "p1", projectName: "Stayolo" }),
            span({ id: "r2", start: H, end: 2 * H, projectId: "p2", projectName: "Harbor", customerName: "Harbor Dental", taskId: "t2" }),
            span({ id: "r3", start: 2 * H, end: 4 * H, projectId: "p2", projectName: "Harbor", customerName: "Harbor Dental", taskId: "t3", actorId: "agent:qa" }),
        ],
        events: [],
    });
    assert.deepEqual(rows.map((r) => r.id), ["project:p2", "project:p1", CHAT_ROW_ID]);
    const harbor = rows[0];
    assert.equal(harbor.name, "Harbor");
    assert.equal(harbor.customerName, "Harbor Dental");
    assert.equal(harbor.runCount, 2);
    assert.equal(harbor.busyMs, 3 * H);
    assert.deepEqual(harbor.actorIds, ["agent:qa", "agent:builder"], "busiest agent first");
    const chatRow = rows[2];
    assert.equal(chatRow.kind, "chat");
    assert.equal(chatRow.name, "Chat (no task)");
    assert.equal(chatRow.customerName, null);
    assert.deepEqual(chatRow.spans.map((s) => s.id), ["c1"], "chat stays last even when it is the busiest");
});

test("groupTimelineByProject places markers on their task's project and drops unplaceable ones", () => {
    const events: TimelineEvent[] = [
        { id: "e1", actorId: "agent:builder", taskId: "t1", kind: "note", at: 10, byName: null, label: "Note" },
        { id: "e2", actorId: "agent:builder", taskId: "unknown", kind: "note", at: 10, byName: null, label: "Note" },
    ];
    const rows = groupTimelineByProject({ spans: [span({ id: "r1", start: 0, end: H })], events });
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].events.map((e) => e.id), ["e1"]);
});

test("groupTimelineByProject only regroups what it is given (no chat row without chat runs)", () => {
    assert.deepEqual(groupTimelineByProject({ spans: [], events: [] }), []);
    const rows = groupTimelineByProject({ spans: [span({ id: "r1", start: 0, end: H })], events: [] });
    assert.ok(!rows.some((r) => r.id === CHAT_ROW_ID));
});

test("groupTimelineByProject never counts a task run without a project as a project", () => {
    const rows = groupTimelineByProject({ spans: [span({ id: "r1", start: 0, end: H, projectId: null })], events: [] });
    assert.deepEqual(rows.map((r) => r.id), [CHAT_ROW_ID]);
});

// ─── summarizeTimeSpent ─────────────────────────────────────────────────────

test("summarizeTimeSpent ranks tasks by busy time with cost and agents", () => {
    const summary = summarizeTimeSpent({
        actors,
        spans: [
            span({ id: "r1", start: 0, end: 2 * H, costCents: 100 }),
            span({ id: "r2", start: 2 * H, end: 3.2 * H, costCents: 40, actorId: "agent:qa" }),
            span({ id: "r3", start: 0, end: H, taskId: "t2", taskTitle: "SEO audit", projectId: "p2", projectName: "Harbor", actorId: "agent:seo", costCents: 5 }),
            chat("c1", 0, 0.5 * H, "agent:builder", 7),
            chat("c2", H, 1.5 * H, "agent:qa", 3),
        ],
    });
    assert.equal(summary.tasks.length, 2);
    const top = summary.tasks[0];
    assert.equal(top.title, "Stayolo hotfix");
    assert.equal(top.href, "/projects/tasks/t1");
    assert.equal(top.busyMs, 3.2 * H);
    assert.equal(top.costCents, 140);
    assert.equal(top.runs, 2);
    assert.deepEqual(top.agentNames, ["Builder", "QA"]);
    assert.equal(`${top.title} · ${formatHours(top.busyMs)} · $${(top.costCents / 100).toFixed(2)} · ${joinAgentNames(top.agentNames)}`,
        "Stayolo hotfix · 3.2 h · $1.40 · Builder + QA");
    assert.deepEqual(summary.chat, { runs: 2, busyMs: H, costCents: 10 });
    assert.equal(summary.busyMs, 3.2 * H + H + H);
});

test("summarizeTimeSpent rolls tasks up into expandable projects", () => {
    const summary = summarizeTimeSpent({
        actors,
        spans: [
            span({ id: "r1", start: 0, end: H, taskId: "t1", taskTitle: "A" }),
            span({ id: "r2", start: 0, end: 2 * H, taskId: "t2", taskTitle: "B", actorId: "agent:qa" }),
            span({ id: "r3", start: 0, end: 4 * H, taskId: "t3", taskTitle: "C", projectId: "p2", projectName: "Other", customerName: null }),
        ],
    });
    assert.deepEqual(summary.projects.map((p) => p.projectId), ["p2", "p1"]);
    const stayolo = summary.projects[1];
    assert.equal(stayolo.name, "Stayolo");
    assert.equal(stayolo.customerName, "Stayolo Ltd");
    assert.equal(stayolo.busyMs, 3 * H);
    assert.deepEqual(stayolo.tasks.map((t) => t.title), ["B", "A"], "the project's tasks, busiest first");
    assert.deepEqual(stayolo.agentNames, ["QA", "Builder"]);
    assert.equal(summary.projects[0].customerName, null);
});

test("summarizeTimeSpent caps the top-tasks list but keeps every task under its project", () => {
    const spans = Array.from({ length: 12 }, (_, i) => span({ id: `r${i}`, start: 0, end: (i + 1) * 60_000, taskId: `t${i}`, taskTitle: `Task ${i}` }));
    const summary = summarizeTimeSpent({ actors, spans }, { topTasks: 5 });
    assert.equal(summary.tasks.length, 5);
    assert.equal(summary.tasks[0].taskId, "t11");
    assert.equal(summary.projects[0].tasks.length, 12);
});

test("summarizeTimeSpent of an empty range is empty", () => {
    const summary = summarizeTimeSpent({ actors, spans: [] });
    assert.deepEqual(summary, { tasks: [], projects: [], chat: { runs: 0, busyMs: 0, costCents: 0 }, busyMs: 0 });
});

test("summarizeTimeSpent names an agent missing from the actors as Agent", () => {
    const summary = summarizeTimeSpent({ actors: [], spans: [span({ id: "r1", start: 0, end: H })] });
    assert.deepEqual(summary.tasks[0].agentNames, ["Agent"]);
});

// ─── Formatting ─────────────────────────────────────────────────────────────

test("formatHours renders one decimal of hours", () => {
    assert.equal(formatHours(3.2 * H), "3.2 h");
    assert.equal(formatHours(0.4 * H), "0.4 h");
    assert.equal(formatHours(60_000), "<0.1 h");
    assert.equal(formatHours(0), "0 h");
    assert.equal(formatHours(-5), "0 h");
});

test("joinAgentNames joins with plus and folds a long list", () => {
    assert.equal(joinAgentNames(["Builder"]), "Builder");
    assert.equal(joinAgentNames(["Builder", "QA"]), "Builder + QA");
    assert.equal(joinAgentNames(["Builder", "QA", "SEO"]), "Builder + QA + SEO");
    assert.equal(joinAgentNames(["Builder", "QA", "SEO", "Atlas"]), "Builder + QA + 2 more");
    assert.equal(joinAgentNames([]), "");
});
