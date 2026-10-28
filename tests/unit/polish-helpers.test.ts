import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePauseAllBody, pauseSummary } from "../../src/lib/pause-all";
import { canOfferSampleClient, hasSampleTag, SAMPLE_CUSTOMER_NAME, SAMPLE_TAG, sampleClientPlan, sampleManifest } from "../../src/lib/sample-client";
import { richMessagePreview } from "../../src/lib/rich-preview";
import { SLA_TRACKED_TASK_STATES, TASK_STATES } from "../../src/lib/task-state";

// ─── Pause all ──────────────────────────────────────────────────────────────

test("pauseSummary: all paused only when every agent is paused", () => {
    assert.deepEqual(pauseSummary([]), { total: 0, paused: 0, allPaused: false });
    assert.deepEqual(pauseSummary([{ budgetStatus: "paused" }, { budgetStatus: "paused" }]), { total: 2, paused: 2, allPaused: true });
    assert.deepEqual(pauseSummary([{ budgetStatus: "paused" }, { budgetStatus: "warning" }]), { total: 2, paused: 1, allPaused: false });
    assert.deepEqual(pauseSummary([{ budgetStatus: null }, { budgetStatus: undefined }]), { total: 2, paused: 0, allPaused: false });
});

test("parsePauseAllBody: only a boolean `paused` is accepted", () => {
    assert.deepEqual(parsePauseAllBody({ paused: true }), { paused: true });
    assert.deepEqual(parsePauseAllBody({ paused: false }), { paused: false });
    for (const bad of [null, undefined, "x", {}, { paused: "true" }, { paused: 1 }, []]) {
        assert.ok("error" in parsePauseAllBody(bad), `accepted ${JSON.stringify(bad)}`);
    }
});

// ─── Sample client ──────────────────────────────────────────────────────────

test("sample plan: a clearly labelled customer, one project, three tasks in different states and a note", () => {
    const plan = sampleClientPlan();
    assert.equal(plan.customer.name, SAMPLE_CUSTOMER_NAME);
    assert.ok(plan.customer.name.startsWith("Sample:"));
    assert.ok(plan.project.goal.startsWith("Sample:"));
    assert.equal(plan.tasks.length, 3);
    assert.equal(new Set(plan.tasks.map((t) => t.state)).size, 3, "tasks must be in different states");
    for (const task of plan.tasks) assert.ok(task.title.startsWith("Sample:"), task.title);
    assert.ok(plan.note.displayName.startsWith("Sample:"));
    assert.match(plan.note.body, /sample data/i);
});

test("sample plan: no task sits in the inbox, where an agent could pick it up", () => {
    for (const task of sampleClientPlan().tasks) assert.notEqual(task.state, TASK_STATES.inbox);
    // At most one is in a state the progress machinery watches.
    assert.ok(sampleClientPlan().tasks.filter((t) => (SLA_TRACKED_TASK_STATES as readonly string[]).includes(t.state)).length <= 1);
});

test("hasSampleTag / sampleManifest read only the exact tag", () => {
    assert.equal(hasSampleTag({ title: "x", sample: SAMPLE_TAG }), true);
    assert.equal(hasSampleTag({ title: "x", sample: true }), false);
    assert.equal(hasSampleTag(null), false);
    assert.equal(hasSampleTag("sample_client"), false);
    assert.deepEqual(sampleManifest({ sample: { kind: SAMPLE_TAG, customerId: "c1", noteId: "n1" } }), { kind: SAMPLE_TAG, customerId: "c1", noteId: "n1" });
    assert.deepEqual(sampleManifest({ sample: { kind: SAMPLE_TAG, customerId: "c1" } }), { kind: SAMPLE_TAG, customerId: "c1", noteId: null });
    assert.equal(sampleManifest({ sample: { kind: "other", customerId: "c1" } }), null);
    assert.equal(sampleManifest({ sample: { kind: SAMPLE_TAG } }), null);
    assert.equal(sampleManifest({ revenue: 10 }), null);
    assert.equal(sampleManifest(null), null);
});

test("canOfferSampleClient: owners/admins of an empty workspace without a sample", () => {
    assert.equal(canOfferSampleClient({ isAdmin: true, customerCount: 0, hasSample: false }), true);
    assert.equal(canOfferSampleClient({ isAdmin: false, customerCount: 0, hasSample: false }), false);
    assert.equal(canOfferSampleClient({ isAdmin: true, customerCount: 1, hasSample: false }), false);
    assert.equal(canOfferSampleClient({ isAdmin: true, customerCount: 0, hasSample: true }), false);
});

// ─── Notification previews ──────────────────────────────────────────────────

const fence = "```";

test("richMessagePreview: a choices block becomes its question and option labels, never JSON", () => {
    const text = `Which plan should I run?\n\n${fence}choices\n{"question":"Pick one","options":[{"label":"Ship it","style":"primary"},{"label":"Wait a week"}]}\n${fence}`;
    const out = richMessagePreview(text);
    assert.equal(out, "Which plan should I run? Pick one Options: Ship it · Wait a week");
    assert.ok(!out.includes("{"), out);
});

test("richMessagePreview: a bare option list and a broken block still read as text", () => {
    assert.equal(richMessagePreview(`${fence}choices\n["Yes","No"]\n${fence}`), "Options: Yes · No");
    assert.equal(richMessagePreview(`Decide:\n${fence}choices\nnot json\n${fence}`), "Decide: Choose an option in the chat.");
});

test("richMessagePreview: a clipped message ending inside an open block drops the raw tail", () => {
    const out = richMessagePreview(`@Ana need a call\n${fence}choices\n{"question":"Approve","options":[{"label":"Ye`);
    assert.equal(out, "@Ana need a call Choose an option in the chat.");
});

test("richMessagePreview: charts, stats and widgets are named; ordinary code and text stay", () => {
    assert.equal(richMessagePreview(`Here:\n${fence}chart\n{"type":"bar","title":"Leads","labels":[],"series":[]}\n${fence}`), "Here: [Chart: Leads]");
    assert.equal(richMessagePreview(`${fence}stats\n[]\n${fence}`), "[Stats]");
    assert.equal(richMessagePreview(`${fence}html\n<b>x</b>\n${fence}`), "[Interactive widget]");
    assert.equal(richMessagePreview(`Run\n${fence}js\nlet a = 1;\n${fence}`), "Run ```js let a = 1; ```");
    assert.equal(richMessagePreview("**Heads up**: the deploy is done."), "Heads up: the deploy is done.");
    assert.equal(richMessagePreview(null), "");
});
