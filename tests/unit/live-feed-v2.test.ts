import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveAppearance, HAIR_COLORS, type CharacterAppearance } from "../../src/lib/character/model";
import { expressionForActivity } from "../../src/lib/team-scene";
import {
    approvalTitle,
    cleanSnippet,
    deriveActs,
    deriveEvents,
    deriveNeeds,
    fitThoughtsToBudget,
    handoffRecipient,
    isLiveProblemIncident,
    isOpaqueRun,
    liveActFor,
    liveEventId,
    LIVE_MIN_THOUGHTS,
    LIVE_PAYLOAD_BUDGET_BYTES,
    packLook,
    pickThoughts,
    recentlyDoneAgents,
    redactSensitive,
    screenTitle,
    thoughtFromReasoning,
    type ActInput,
    type ReasoningRow,
    type TaskTransitionRow,
} from "../../src/lib/live-feed-v2";
import { liveFeedEtag, LIVE_MAX_AGENTS, type LiveFeed } from "../../src/lib/live-feed";

const NOW = Date.parse("2026-10-12T12:00:00Z");
const ago = (sec: number) => NOW - sec * 1000;

// ─── look ──────────────────────────────────────────────────────────────────

test("look packs the resolved appearance with draw.ts hair math", () => {
    const appearance: CharacterAppearance = { version: 1, kind: "human", seed: "x", hue: 205, variant: 2, skin: 1, hair: 3, accessory: "glasses" };
    assert.deepEqual(packLook(appearance), { k: "h", u: 205, v: 2, s: 1, h: 3, hs: (3 + 2) % 4, a: "g" });
    const robot: CharacterAppearance = { ...appearance, kind: "robot", accessory: "none", hair: 5, variant: 3 };
    assert.deepEqual(packLook(robot), { k: "r", u: 205, v: 3, s: 1, h: 5, hs: 0, a: "-" });
    for (const [accessory, code] of [["headset", "h"], ["cap", "c"], ["bow", "b"]] as const) {
        assert.equal(packLook({ ...appearance, accessory }).a, code);
    }
    // Every derived look stays inside the firmware's ranges.
    for (let i = 0; i < 200; i++) {
        const look = packLook(deriveAppearance(`agent-${i}`));
        assert.ok(look.h >= 0 && look.h < HAIR_COLORS.length && look.hs >= 0 && look.hs < 4 && look.s >= 0 && look.s < 6 && look.v >= 0 && look.v < 4);
        assert.ok(look.u >= 0 && look.u < 360);
    }
});

// ─── act + mood ────────────────────────────────────────────────────────────

function actInput(overrides: Partial<ActInput> & { id: string }): ActInput {
    return { name: overrides.id, health: "healthy", activity: null, working: [], waiting: [], incident: null, approval: null, justDone: false, ...overrides };
}

test("act follows the web scene mapping and mood its expression", () => {
    const acts = deriveActs([
        actInput({ id: "coder", activity: "debugging the build" }),
        actInput({ id: "reviewer", activity: "reviewing PR 42" }),
        actInput({ id: "writer", activity: "drafting the blog post" }),
        actInput({ id: "thinker", activity: "researching competitors" }),
        actInput({ id: "presenter", activity: "preparing the demo" }),
        actInput({ id: "private", activity: "Working in a private chat" }),
        actInput({ id: "tasked", working: [{ id: "t1", title: "Ship it", taskType: "code" }] }),
        actInput({ id: "waiting", waiting: [{ id: "t2", title: "Review me", taskType: "code" }] }),
        actInput({ id: "approval", approval: { id: "a1", title: "Approve X" } }),
        actInput({ id: "stuck", incident: { id: "i1", taskId: "t3", title: "Broken", reason: "max retries exceeded" } }),
        actInput({ id: "done", justDone: true }),
        actInput({ id: "down", health: "down" }),
    ]);
    const get = (id: string) => acts.get(id)!;
    assert.deepEqual(get("coder"), { act: "typing", mood: "focused" });
    assert.deepEqual(get("reviewer"), { act: "reviewing", mood: "scanning" });
    assert.deepEqual(get("writer"), { act: "writing", mood: "focused" });
    assert.deepEqual(get("thinker"), { act: "thinking", mood: "focused" });
    assert.deepEqual(get("presenter"), { act: "presenting", mood: "focused" });
    assert.deepEqual(get("private"), { act: "typing", mood: "focused" });
    assert.deepEqual(get("tasked"), { act: "typing", mood: "neutral" }, "a task without a live signal: scene 'working'");
    assert.deepEqual(get("waiting"), { act: "waiting", mood: "worried" });
    assert.deepEqual(get("approval"), { act: "waiting", mood: "worried" });
    assert.deepEqual(get("stuck"), { act: "blocked", mood: "worried" });
    assert.deepEqual(get("done"), { act: "celebrate", mood: "happy" });
    assert.deepEqual(get("down"), { act: "offline", mood: "sleepy" });
});

test("idle agents get the scene's idle routines, deterministically", () => {
    const inputs = Array.from({ length: 8 }, (_, i) => actInput({ id: `idle-${i}` }));
    const first = deriveActs(inputs);
    const second = deriveActs([...inputs].reverse());
    const acts = [...first.values()].map((a) => a.act);
    assert.equal(acts.filter((a) => a === "coffee").length, 3, "three walkers, like the web");
    assert.ok(acts.every((a) => a === "coffee" || a === "nap" || a === "stretch"));
    for (const [id, value] of first) assert.deepEqual(second.get(id), value);
    assert.equal(first.get([...first.keys()].find((k) => first.get(k)!.act === "nap") ?? "")?.mood ?? "sleepy", "sleepy");
});

test("every scene activity maps onto the contract enums", () => {
    const allowed = new Set(["typing", "writing", "reviewing", "presenting", "talking", "thinking", "waiting", "blocked", "celebrate", "coffee", "nap", "stretch", "offline", "idle"]);
    for (const kind of ["typing", "writing", "reviewing", "presenting", "talking", "thinking", "waiting", "blocked", "celebrate", "coffee", "nap", "stretch", "available", "working", "offline"] as const) {
        assert.ok(allowed.has(liveActFor(kind)), kind);
        assert.ok(["neutral", "happy", "focused", "worried", "sleepy", "scanning"].includes(expressionForActivity(kind)));
    }
    assert.equal(liveActFor("available"), "idle");
});

test("only open, non-done problem incidents block", () => {
    const base = { reasonCode: "max_retries_exceeded", summary: "x", taskState: "failed", taskDeleted: false, createdAt: new Date(NOW) };
    assert.equal(isLiveProblemIncident(base), true);
    assert.equal(isLiveProblemIncident({ ...base, taskState: "done" }), false);
    assert.equal(isLiveProblemIncident({ ...base, taskDeleted: true }), false);
    assert.equal(isLiveProblemIncident({ ...base, reasonCode: "sla_breach" }), false);
    assert.equal(isLiveProblemIncident({ ...base, reasonCode: "unclaimed_stale" }), false);
});

// ─── Redaction + thoughts ──────────────────────────────────────────────────

test("redaction removes links, emails, keys, tokens and home paths", () => {
    const input = [
        "See https://acme.example.com/a?b=c and www.foo.io/x,",
        "mail jane.doe@acme.co,",
        "tokens ec_read_only_9f8e7d6c5b4a ghp_abcDEF1234567890 sk-ant-api03-XYZ123abc github_pat_11ABCDEFG0123456789",
        "AKIAIOSFODNN7EXAMPLE AIzaSyA1234567890abcdefghijklmnop xoxb-1234-5678-abcdef",
        "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig",
        "hex 0123456789abcdef0123456789abcdef b64 QWxhZGRpbjpvcGVuIHNlc2FtZTEyMzQ1Njc4",
        "password=hunter2 api_key: abc Authorization: Bearer abcdefghijklmnop",
        "paths /home/jose/.ssh/id_rsa /Users/jz/secrets.txt C:\\Users\\JZ\\Documents\\notes.md ~/private/x",
    ].join(" ");
    const out = redactSensitive(input);
    for (const leaked of ["acme.example", "foo.io", "jane.doe", "acme.co", "ec_read", "ghp_", "sk-ant", "github_pat", "AKIA", "AIza", "xoxb", "eyJ", "0123456789abcdef", "QWxhZGRp", "hunter2", "abcdefghijklmnop", "jose", "/Users/jz", "JZ\\Documents", "private/x"]) {
        assert.ok(!out.includes(leaked), `"${leaked}" leaked: ${out}`);
    }
    assert.match(out, /\[link\]/);
    assert.match(out, /\[email\]/);
    assert.match(out, /\[secret\]/);
    assert.match(out, /\[path\]/);
    // Ordinary prose and identifiers survive.
    assert.equal(redactSensitive("Checking whether the thread_message_reasoning migration ran in src/lib/live-feed.ts"), "Checking whether the thread_message_reasoning migration ran in src/lib/live-feed.ts");
});

test("redaction covers system and drive paths and bare keyword values, without flagging identifiers", () => {
    const out = redactSensitive("logs in /var/log/app.log, config /etc/nginx/nginx.conf, /opt/app/bin, /srv/data, /root/.env, D:\\work\\client\\plan.docx and C:/tmp/x");
    for (const leaked of ["/var/log", "/etc/nginx", "/opt/app", "/srv/data", "/root/.env", "work\\client", "C:/tmp"]) assert.ok(!out.includes(leaked), `"${leaked}" leaked: ${out}`);
    assert.equal(redactSensitive("password hunter2 then token abc123xyz and secret S3cr3t!"), "password [secret] then token [secret] and secret [secret]");
    assert.equal(redactSensitive("the key insight is that the token expired"), "the key insight is that the token expired", "prose survives");
    assert.equal(redactSensitive("relative src/etc/config.ts stays"), "relative src/etc/config.ts stays");
    // Identifiers are not secrets.
    for (const word of ["thread_message_reasoning_v2_index", "live-feed-budget-check-24-agents", "thread_message_reasoning_company_created_idx", "ThreadMessageReasoningCompanyIndex"]) {
        assert.equal(isOpaqueRun(word), false, word);
        assert.equal(redactSensitive(`see ${word}`), `see ${word}`);
    }
    for (const key of ["6f1c2a3e-1111-4222-8333-944455556666", "0123456789abcdef0123456789abcdef", "aB3dE5gH7jK9mN1pQ3sT5vW7", "abc123def456ghi789jkl012mno"]) {
        assert.equal(isOpaqueRun(key), true, key);
    }
});

test("snippets collapse whitespace and truncate by code point with an ellipsis", () => {
    assert.equal(cleanSnippet("  a \n\n b\t c  ", 140), "a b c");
    const long = cleanSnippet("word ".repeat(80), 140);
    assert.ok(Array.from(long).length <= 140);
    assert.ok(long.endsWith("..."));
    const emoji = cleanSnippet("😀".repeat(200), 140);
    assert.equal(Array.from(emoji).length, 140);
});

test("a thought is the newest substantive paragraph, redacted and ≤140 chars", () => {
    const reasoning = "First I looked at the schema.\n\nThen I compared the migration with https://x.io/a and the key sk-abcdef123456.\n\nok";
    assert.equal(thoughtFromReasoning(reasoning), "Then I compared the migration with [link] and the key [secret].");
    assert.equal(thoughtFromReasoning("ok\n\nThinking...\n\n..."), null, "stubs only");
    assert.equal(thoughtFromReasoning("[secret] [link] [path] [email] xx"), null, "nothing but redactions is a stub");
    assert.equal(thoughtFromReasoning("**Plan**: check the *live feed* ETag before shipping v2"), "Plan: check the live feed ETag before shipping v2");
    const long = thoughtFromReasoning("This is a very long line of reasoning ".repeat(10))!;
    assert.ok(Array.from(long).length <= 140 && long.endsWith("..."));
    // A tail cut from a longer transcript drops its (possibly partial) first line.
    assert.equal(thoughtFromReasoning("abcd1234 partial secret tail fragment here\nNow verifying the rollout plan for agents", true), "Now verifying the rollout plan for agents");
    assert.equal(thoughtFromReasoning("only one partial line without a newline at all", true), null);
    // Code is output, not thinking.
    assert.equal(thoughtFromReasoning("Writing the fix for the parser bug now.\n```ts\nconst token = 'ghp_abcdef1234567890';\n```"), "Writing the fix for the parser bug now.");
});

function row(overrides: Partial<ReasoningRow> & { agentId: string }): ReasoningRow {
    return { messageId: `m-${Math.random()}`, threadType: "team", createdAtMs: ago(30), reasoning: "Comparing the two migration plans carefully", truncatedHead: false, ...overrides };
}

test("thoughts: newest per agent, stale and stub rows skipped, ageSec set", () => {
    const thoughts = pickThoughts([
        row({ agentId: "a", createdAtMs: ago(100), reasoning: "Older thought about the release notes" }),
        row({ agentId: "a", createdAtMs: ago(10), reasoning: "ok" }),
        row({ agentId: "b", createdAtMs: ago(11 * 60), reasoning: "Too old to show on the screen now" }),
        row({ agentId: "c", createdAtMs: ago(5), reasoning: "Newest thought for agent c is here" }),
    ], { nowMs: NOW, creatorReplyIds: new Set() });
    assert.deepEqual(thoughts.get("a"), { thought: "Older thought about the release notes", ageSec: 100 }, "a stub falls back to the previous row");
    assert.equal(thoughts.has("b"), false, "older than 10 minutes");
    assert.deepEqual(thoughts.get("c"), { thought: "Newest thought for agent c is here", ageSec: 5 });
});

test("thoughts never come from private threads unless they are the creator's own dm exchange", () => {
    const rows = [
        row({ agentId: "a", messageId: "dm-other", threadType: "direct", createdAtMs: ago(5), reasoning: "The other member's salary is 90k, reply kindly" }),
        row({ agentId: "a", messageId: "team-1", threadType: "team", createdAtMs: ago(60), reasoning: "Planning the team standup summary now" }),
        row({ agentId: "b", messageId: "dm-creator", threadType: "direct", createdAtMs: ago(5), reasoning: "Answering the creator about the launch plan" }),
        row({ agentId: "c", messageId: "task-1", threadType: "task", createdAtMs: ago(5), reasoning: "Some other thread type never reaches a screen" }),
    ];
    const off = pickThoughts(rows, { nowMs: NOW, creatorReplyIds: new Set() });
    assert.equal(off.get("a")?.thought, "Planning the team standup summary now");
    assert.equal(off.has("b"), false);
    assert.equal(off.has("c"), false);
    const on = pickThoughts(rows, { nowMs: NOW, creatorReplyIds: new Set(["dm-creator"]) });
    assert.equal(on.get("a")?.thought, "Planning the team standup summary now", "another member's dm stays hidden");
    assert.equal(on.get("b")?.thought, "Answering the creator about the launch plan");
    assert.equal(on.has("c"), false);
});

// ─── events + needs ────────────────────────────────────────────────────────

const roster = [{ id: "ada", name: "Ada Researcher" }, { id: "bob", name: "Bob Builder" }, { id: "cy", name: "Cy" }];

test("handoff recipient: target first, else the first other agent mentioned", () => {
    assert.equal(handoffRecipient({ id: "1", senderId: "ada", targetAgentId: "bob", text: "", createdAtMs: NOW }, roster), "bob");
    assert.equal(handoffRecipient({ id: "1", senderId: "ada", targetAgentId: null, text: "@Ada note to self, @Bob Builder please build", createdAtMs: NOW }, roster), "bob");
    assert.equal(handoffRecipient({ id: "1", senderId: "ada", targetAgentId: "ada", text: "no mentions", createdAtMs: NOW }, roster), null);
    assert.equal(handoffRecipient({ id: "1", senderId: "ada", targetAgentId: null, text: "@all hello", createdAtMs: NOW }, roster), null);
});

test("events: newest first, ≤10, last 10 minutes, stable ids, shown agents only, no message text", () => {
    const transitions: TaskTransitionRow[] = [
        { id: "te1", state: "done", actorType: "agent", actorId: "bob", assignedAgentId: "bob", title: "Ship the **landing page** for the new product launch campaign", createdAtMs: ago(20) },
        { id: "te2", state: "blocked", actorType: "agent", actorId: "cy", assignedAgentId: "cy", title: "Deploy", createdAtMs: ago(40) },
        { id: "te3", state: "done", actorType: "human", actorId: "user-1", assignedAgentId: "ada", title: "Approved work", createdAtMs: ago(50) },
        { id: "te4", state: "done", actorType: "agent", actorId: "bob", assignedAgentId: "bob", title: "Old", createdAtMs: ago(11 * 60) },
        { id: "te5", state: "done", actorType: "agent", actorId: "ghost", assignedAgentId: "ghost", title: "Hidden agent", createdAtMs: ago(5) },
    ];
    const events = deriveEvents({
        handoffs: [
            { id: "m1", senderId: "ada", targetAgentId: null, text: "@Bob Builder secret plan inside", createdAtMs: ago(10) },
            { id: "m2", senderId: "ada", targetAgentId: null, text: "nobody mentioned", createdAtMs: ago(15) },
        ],
        transitions,
        approvals: [{ id: "ap1", requesterAgentId: "cy", title: "Approve Deploy", requestedAtMs: ago(30) }, { id: "ap2", requesterAgentId: "cy", title: "Old ask", requestedAtMs: ago(20 * 60) }],
        roster,
        shown: new Set(["ada", "bob", "cy"]),
        nowMs: NOW,
    });
    assert.deepEqual(events.map((e) => e.id), [liveEventId("handoff", "m1"), liveEventId("task_done", "te1"), liveEventId("needs_you", "ap1"), liveEventId("blocked", "te2"), liveEventId("task_done", "te3")]);
    assert.deepEqual(events[0], { id: liveEventId("handoff", "m1"), t: "handoff", a: "ada", b: "bob", ageSec: 10 });
    assert.equal(events[1].t, "task_done");
    assert.equal(events[1].a, "bob");
    assert.ok(Array.from(events[1].title!).length <= 56 && !events[1].title!.includes("*"));
    assert.deepEqual(events[3], { id: liveEventId("blocked", "te2"), t: "blocked", a: "cy", title: "Deploy", ageSec: 40 });
    assert.equal(events[4].a, "ada", "a human-approved completion belongs to the task's agent");
    assert.ok(!JSON.stringify(events).includes("secret plan"), "message text never reaches an event");
    assert.deepEqual(recentlyDoneAgents(transitions, new Set(["ada", "bob", "cy"]), NOW), new Set(["bob", "ada"]));

    const many = deriveEvents({
        handoffs: Array.from({ length: 30 }, (_, i) => ({ id: `h${i}`, senderId: "ada", targetAgentId: "bob", text: "", createdAtMs: ago(i) })),
        transitions: [], approvals: [], roster, shown: new Set(["ada", "bob"]), nowMs: NOW,
    });
    assert.equal(many.length, 10);
    assert.equal(many[0].id, liveEventId("handoff", "h0"));
    assert.equal(new Set(many.map((e) => e.id)).size, 10);
    assert.match(liveEventId("task_done", "00000000-aaaa-4bbb-8ccc-dddddddddddd"), /^evt-d-[A-Za-z0-9_-]{10}$/);
    assert.equal(liveEventId("task_done", "x"), liveEventId("task_done", "x"), "stable across polls");
    assert.notEqual(liveEventId("task_done", "x"), liveEventId("blocked", "x"));
});

test("needs: newest 3 pending approvals; titles are short and redacted", () => {
    const needs = deriveNeeds([
        { id: "1", requesterAgentId: "ada", title: "A", requestedAtMs: ago(40) },
        { id: "2", requesterAgentId: null, title: "B", requestedAtMs: ago(10) },
        { id: "3", requesterAgentId: "bob", title: "C", requestedAtMs: ago(20) },
        { id: "4", requesterAgentId: "cy", title: "D", requestedAtMs: ago(30) },
    ]);
    assert.deepEqual(needs, [{ agentId: "", title: "B" }, { agentId: "bob", title: "C" }, { agentId: "cy", title: "D" }]);
    assert.equal(approvalTitle({ actionType: "task_done", rationale: null, taskTitle: "Draft Q3 summary" }), "Approve Draft Q3 summary");
    assert.equal(approvalTitle({ actionType: "send_email", rationale: "Email jane@acme.co the contract", taskTitle: null }), "Approve send email: Email [email] the contract");
    const long = screenTitle("x".repeat(30) + " " + "y".repeat(60));
    assert.ok(Array.from(long).length <= 56);
});

// ─── Payload budget + ETag ─────────────────────────────────────────────────

/**
 * Every v2 key at its cap: 24 agents each with a 140-char thought, 8 messages
 * at 100 chars, 10 events and 3 needs with 56-char titles. `v1Text` sets the
 * v1 free text: "typical" (a 14-char name, a 48-char activity, a 36-char task
 * title) or "max" (every v1 string at its own cap, a 26-char name).
 */
function worstCaseFeed(v1Text: "typical" | "max" = "typical"): LiveFeed {
    const uuid = (n: number) => `${String(n).padStart(8, "0")}-aaaa-4bbb-8ccc-dddddddddddd`;
    const max = v1Text === "max";
    const agents = Array.from({ length: LIVE_MAX_AGENTS }, (_, i) => ({
        id: uuid(i),
        name: max ? `Agent Number ${String(i).padStart(2, "0")} Longname` : `Agent${String(i).padStart(2, "0")} Builder`,
        short: max ? "Agentnumbr" : `Agent${String(i).padStart(2, "0")}`,
        hue: 359,
        health: "attention" as const,
        state: "typing" as const,
        activity: max ? "A".repeat(77) + "..." : "A".repeat(48),
        task: { id: uuid(100 + i), title: max ? "T".repeat(57) + "..." : "T".repeat(36) },
        lastSeenSec: 123456,
        unanswered: 99,
        look: { k: "h" as const, u: 359, v: 3, s: 5, h: 7, hs: 3, a: "g" as const },
        act: "presenting" as const,
        mood: "scanning" as const,
        thought: "W".repeat(137) + "...",
        thoughtAgeSec: 599,
    }));
    return {
        v: 2,
        ts: new Date(NOW).toISOString(),
        company: { name: "A Rather Long Company Name Incorporated" },
        summary: { agents: 240, healthy: 100, attention: 100, down: 20, idle: 20, working: 200, pendingApprovals: 999, tasksInProgress: 9999, tasksOverdue: 999 },
        agents,
        messages: Array.from({ length: 8 }, (_, i) => ({ id: uuid(200 + i), from: "Agentnumbr", agentId: uuid(i), text: "M".repeat(97) + "...", ageSec: 599 })),
        dm: [],
        events: Array.from({ length: 10 }, (_, i) => ({ id: liveEventId("task_done", uuid(300 + i)), t: "task_done" as const, a: uuid(i), title: "E".repeat(53) + "...", ageSec: 599 })),
        needs: Array.from({ length: 3 }, (_, i) => ({ agentId: uuid(i), title: "N".repeat(53) + "..." })),
    };
}

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
function omit(feed: LiveFeed, agentKeys: string[], topKeys: string[] = []) {
    const copy: Record<string, unknown> = { ...feed, agents: feed.agents.map((a) => {
        const rest: Record<string, unknown> = { ...a };
        for (const key of agentKeys) delete rest[key];
        return rest;
    }) };
    for (const key of topKeys) delete copy[key];
    return copy;
}
const withoutThoughts = (feed: LiveFeed) => omit(feed, ["thought", "thoughtAgeSec"]);
const v1Only = (feed: LiveFeed) => omit(feed, ["look", "act", "mood", "thought", "thoughtAgeSec"], ["events", "needs"]);

test("thoughts flex so a feed whose other keys fit lands under the 12 KB device budget", () => {
    // 16 agents (half idle: no activity, no task) all with 140-char thoughts,
    // 8 messages, 10 events, 3 needs.
    const feed = worstCaseFeed("typical");
    feed.agents = feed.agents.slice(0, 16);
    for (const agent of feed.agents.slice(8)) {
        agent.activity = null;
        agent.task = null;
    }
    const before = bytes(feed);
    fitThoughtsToBudget(feed);
    const after = bytes(feed);
    console.log(`16-agent v2 payload: ${before} bytes with 16 x 140-char thoughts, ${after} after fitting (budget ${LIVE_PAYLOAD_BUDGET_BYTES})`);
    assert.ok(before > LIVE_PAYLOAD_BUDGET_BYTES, "the fixture really needs trimming");
    assert.ok(after <= LIVE_PAYLOAD_BUDGET_BYTES, `${after} > ${LIVE_PAYLOAD_BUDGET_BYTES}`);
    assert.ok(feed.agents.filter((a) => a.thought).length >= LIVE_MIN_THOUGHTS);
    for (const a of feed.agents) assert.ok(!a.thought || Array.from(a.thought).length <= 140);

    const small = worstCaseFeed();
    small.agents = small.agents.slice(0, 4);
    fitThoughtsToBudget(small);
    assert.equal(Array.from(small.agents[0].thought!).length, 140, "a feed under budget is untouched");
});

for (const v1Text of ["typical", "max"] as const) {
    test(`contract worst case (${v1Text} v1 text): over budget without thoughts, so only ${LIVE_MIN_THOUGHTS} short thoughts remain and v1 is untouched`, () => {
        const feed = worstCaseFeed(v1Text);
        const before = bytes(feed);
        const base = bytes(withoutThoughts(feed));
        fitThoughtsToBudget(feed);
        const after = bytes(feed);
        console.log(`contract worst case, ${v1Text} v1 text: v1 keys ${bytes(v1Only(feed))} bytes, v2 without thoughts ${base}, with 24 thoughts ${before}, after fitting ${after}`);
        const kept = feed.agents.filter((a) => a.thought);
        assert.equal(kept.length, LIVE_MIN_THOUGHTS);
        for (const a of kept) assert.ok(Array.from(a.thought!).length <= 48 && typeof a.thoughtAgeSec === "number");
        assert.ok(after - base <= LIVE_MIN_THOUGHTS * 90, "the kept thoughts cost at most ~270 bytes");
        assert.ok(base - bytes(v1Only(feed)) <= 4608, "look/act/mood + events + needs add at most 4.5 KB");
        const v1 = worstCaseFeed(v1Text);
        assert.deepEqual(v1Only(feed), v1Only(v1), "v1 keys are never trimmed");
    });
}

test("ETag ignores v2 clocks but tracks thoughts and events", () => {
    const a = worstCaseFeed();
    const b = worstCaseFeed();
    b.agents[0].thoughtAgeSec = 1;
    b.events[0].ageSec = 1;
    assert.equal(liveFeedEtag(a), liveFeedEtag(b));
    b.agents[0].thought = "A new thought appears on the screen";
    assert.notEqual(liveFeedEtag(a), liveFeedEtag(b));
    const c = worstCaseFeed();
    c.events = c.events.slice(1);
    assert.notEqual(liveFeedEtag(a), liveFeedEtag(c));
});
