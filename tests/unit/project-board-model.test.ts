import { test } from "node:test";
import assert from "node:assert/strict";
import {
    cardContextLine,
    cardSignals,
    formatAge,
    groupBoardTasks,
    initialsOf,
    priorityLevel,
    sentenceCase,
    taskBriefMarkdown,
    tidyAgentMarkdown,
    type BoardTask,
} from "../../src/lib/project-board-model";

const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const task = (over: Partial<BoardTask>): BoardTask => ({ id: "t1", state: "inbox", priority: 0, createdAt: ago(5), updatedAt: ago(5), ...over });

test("no priority means no badge; set priorities get a sentence-case label", () => {
    assert.equal(priorityLevel(0), null);
    assert.equal(priorityLevel(1), null);
    assert.deepEqual(priorityLevel(25), { label: "Low", tone: "low" });
    assert.deepEqual(priorityLevel(75), { label: "High", tone: "high" });
    assert.deepEqual(priorityLevel(100), { label: "Urgent", tone: "critical" });
});

test("ages read as short relative units", () => {
    assert.equal(formatAge(ago(0), NOW), "now");
    assert.equal(formatAge(ago(12), NOW), "12m");
    assert.equal(formatAge(ago(5 * 60), NOW), "5h");
    assert.equal(formatAge(ago(3 * 24 * 60), NOW), "3d");
    assert.equal(formatAge(ago(21 * 24 * 60), NOW), "3w");
    assert.equal(formatAge(null, NOW), "");
});

test("tasks group into columns; queued counts as inbox; done is most recent first", () => {
    const groups = groupBoardTasks([
        task({ id: "a", state: "queued" }),
        task({ id: "b", state: "in_progress", priority: 25 }),
        task({ id: "c", state: "in_progress", priority: 75 }),
        task({ id: "d", state: "done", updatedAt: ago(60) }),
        task({ id: "e", state: "done", updatedAt: ago(1) }),
        task({ id: "f", state: "dead_letter" }),
        task({ id: "g", state: "inbox", taskKind: "recurring" }),
    ], NOW);
    assert.deepEqual(groups.columns.inbox.map((t) => t.id), ["a"]);
    assert.deepEqual(groups.columns.in_progress.map((t) => t.id), ["c", "b"]);
    assert.deepEqual(groups.columns.done.map((t) => t.id), ["e", "d"]);
    assert.deepEqual(groups.columns.exceptions.map((t) => t.id), ["f"]);
    assert.deepEqual(groups.recurring.map((t) => t.id), ["g"]);
    assert.equal(groups.attention.deadLetter.length, 1);
});

test("needs-attention and review buckets follow the board's rules", () => {
    const groups = groupBoardTasks([
        task({ id: "stale", state: "inbox", createdAt: ago(90) }),
        task({ id: "fresh", state: "inbox", createdAt: ago(10) }),
        task({ id: "slow-review", state: "review", updatedAt: ago(25 * 60), humanApprovalRequired: true }),
        task({ id: "proof", state: "review", proofRequired: true }),
        task({ id: "dep", state: "review", blockedByTaskIds: ["fresh"] }),
    ], NOW);
    assert.deepEqual(groups.attention.staleInbox.map((t) => t.id), ["stale"]);
    assert.deepEqual(groups.attention.overdueReview.map((t) => t.id), ["slow-review"]);
    assert.deepEqual(groups.reviewCounts, { approval_needed: 1, waiting_review: 1, blocked: 1, ready_to_close: 0 });
    assert.equal(groups.columns.review.at(-1)?.id, "dep", "dependency-blocked review work sorts last");
    assert.equal(groups.attentionCount, 2);
});

test("card signals only add what the column does not already say", () => {
    assert.deepEqual(cardSignals(task({ state: "blocked" }), { nowMs: NOW, waitingOnDependency: true }), []);
    assert.deepEqual(cardSignals(task({ state: "in_progress" }), { nowMs: NOW, waitingOnDependency: true }), ["blocked"]);
    assert.deepEqual(cardSignals(task({ state: "failed" }), { nowMs: NOW }), ["failed"]);
    assert.deepEqual(cardSignals(task({ state: "review", humanApprovalRequired: true, assignedMemberId: "me" }), { nowMs: NOW, currentMemberId: "me" }), ["approval", "needs_you"]);
    assert.deepEqual(cardSignals(task({ state: "done", humanApprovalRequired: true }), { nowMs: NOW }), []);
    assert.deepEqual(cardSignals(task({ state: "inbox", createdAt: ago(120) }), { nowMs: NOW }), ["stalled"]);
    assert.deepEqual(cardSignals(task({ state: "review", proofRequired: true }), { nowMs: NOW }), ["proof"]);
});

test("the context line drops whatever the filter already shows and de-duplicates the customer", () => {
    assert.equal(cardContextLine({ customerName: "Ridgeline", projectName: "SEO growth" }), "Ridgeline / SEO growth");
    assert.equal(cardContextLine({ customerName: "Harbor Dental", projectName: "Harbor Dental website relaunch" }), "Harbor Dental / Website relaunch");
    assert.equal(cardContextLine({ customerName: "Ridgeline", projectName: "SEO growth", filteredToProject: true }), "Ridgeline");
    assert.equal(cardContextLine({ customerName: "Ridgeline", projectName: "SEO growth", filteredToCustomer: true }), "SEO growth");
    assert.equal(cardContextLine({ customerName: "Ridgeline", projectName: "SEO growth", filteredToProject: true, filteredToCustomer: true }), "");
    assert.equal(cardContextLine({ customerName: null, projectName: "Internal ops" }), "Internal ops");
});

test("initials and sentence case", () => {
    assert.equal(initialsOf("Alex Rivera"), "AR");
    assert.equal(initialsOf("Scout"), "SC");
    assert.equal(initialsOf(""), "?");
    assert.equal(sentenceCase("in_progress"), "In progress");
    assert.equal(sentenceCase("DEAD_LETTER"), "Dead letter");
});

test("the brief folds structured fields into one Markdown document", () => {
    const md = taskBriefMarkdown(task({ inputJson: { title: "Ship it", description: "## Goal\nShip.", acceptanceCriteria: ["Tests pass", "Docs updated"], deliverables: "- release notes" } }));
    assert.equal(md, "## Goal\nShip.\n\n**Done when**\n\n- [ ] Tests pass\n- [ ] Docs updated\n\n**Deliverables**\n\n- release notes");
    assert.equal(taskBriefMarkdown(task({ inputJson: { title: "Empty" } })), null);
    assert.equal(taskBriefMarkdown(task({ inputJson: { prompt: "Do the thing" } })), "Do the thing");
});

test("agent HTML is tidied: details become a bold heading, scripts disappear, code fences are untouched", () => {
    const out = tidyAgentMarkdown("Done.\n\n<details><summary>Details</summary>Retried twice.</details>\n\n<script>alert(1)</script>\n\n```html\n<script>keep()</script>\n```");
    assert.equal(out, "Done.\n\n**Details**\n\nRetried twice.\n\n```html\n<script>keep()</script>\n```");
});
