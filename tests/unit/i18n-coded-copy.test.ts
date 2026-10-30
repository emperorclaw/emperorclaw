import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createTranslator } from "use-intl/core";
import { copy, translateCopy, type CodedCopy, type CopyTranslator } from "../../src/lib/coded-copy";
import { withEnglishFallback } from "../../src/i18n/fallback";
import { describeFailure, failureHeadline, failureHeadlineCopy, FIX_LABEL, type FailureCause } from "../../src/lib/failure-cause";
import { providerTroubleLabel, providerTroubleLabelCopy } from "../../src/lib/provider-trouble";
import { stallLabel, stallLabelCopy } from "../../src/lib/stall-signal";
import { describeTaskEvent, type StoryNames } from "../../src/lib/task-story";
import { lastReasoningCopy, lastReasoningLine, timelineRows, type TimelineStep } from "../../src/lib/live-activity";
import { deliveryVerdictCopy, deliveryVerdictMessage, runStatusCopy } from "../../src/lib/run-ledger-copy";
import { EDGE_KIND_LABEL, eventLabel, type TimelineEventKind } from "../../src/lib/work-timeline";
import { agentRoleTemplates } from "../../src/lib/agent-templates";
import { agentProviders } from "../../src/lib/agent-providers";
import { hireReadiness, hireReasonCopy, type HireHostFacts } from "../../src/lib/runtime-hosts/hire";
import { EASY_SETUP_REASONS } from "../../src/lib/easy-setup-reasons";
import { requestSourceCopy, requestSourceLabel } from "../../src/lib/request-label";
import { API_ERROR_KEYS, apiErrorCopy, apiErrorKey } from "../../src/lib/api-error-copy";

const ROOT = path.join(__dirname, "..", "..");
type Tree = { [key: string]: string | Tree };
const load = (file: string) => JSON.parse(readFileSync(path.join(ROOT, "messages", file), "utf8")) as Tree;
const en = load("en.json");
const zh = withEnglishFallback(en, load("zh-CN.json"));

const translator = (locale: string, messages: Tree) => createTranslator({ locale, messages: messages as never, timeZone: "UTC" }) as unknown as CopyTranslator;
const tEn = translator("en", en);
const tZh = translator("zh-CN", zh);
/** English as the UI renders the code; fails loudly when the key is missing. */
const english = (item: CodedCopy | null | undefined) => {
    const out = translateCopy(tEn, item, "\u0000missing");
    assert.notEqual(out, "\u0000missing", `no English message for ${JSON.stringify(item)}`);
    return out;
};

// ─── The helper ─────────────────────────────────────────────────────────────

test("translateCopy renders a known key and falls back to the server's English otherwise", () => {
    assert.equal(translateCopy(tEn, copy("failures.headlines.budget"), "x"), "Budget limit reached");
    assert.equal(translateCopy(tEn, copy("failures.headlines.not_a_cause"), "Server English"), "Server English", "unknown key");
    assert.equal(translateCopy(tEn, null, "Server English"), "Server English", "no copy");
    // An unknown nested value (a newer server's state) falls back as a whole, never half-translated.
    assert.equal(translateCopy(tEn, copy("tasks.timeline.events.movedTo", { state: copy("tasks.states.some_new_state") }), "Moved to Some new state"), "Moved to Some new state");
    assert.equal(translateCopy(tEn, copy("tasks.timeline.events.movedTo", { state: copy("tasks.states.review") }), "x"), "Moved to Review");
});

test("translateCopy falls back to the server's English when a message's variable is missing", () => {
    // next-intl reports the formatting error via onError and returns the key; the helper must not show it.
    const quiet = createTranslator({ locale: "en", messages: en as never, timeZone: "UTC", onError: () => {} }) as unknown as CopyTranslator;
    assert.equal(translateCopy(quiet, copy("tasks.timeline.events.movedTo"), "Moved to Review"), "Moved to Review");
    assert.equal(translateCopy(quiet, copy("inbox.entries.titles.agentBlocked", { other: "x" }), "Atlas is blocked"), "Atlas is blocked");
    assert.equal(translateCopy(quiet, copy("inbox.entries.titles.agentBlocked", { name: "Atlas" }), "x"), "Atlas is blocked");
});

test("translateCopy renders the viewer's language: zh-CN uses zh-CN.json (English where untranslated)", () => {
    const item = copy("inbox.entries.titles.agentBlocked", { name: "Atlas" });
    const zhValue = (zh.inbox as Tree).entries as Tree;
    const expected = ((zhValue.titles as Tree).agentBlocked as string).replace("{name}", "Atlas");
    assert.equal(translateCopy(tZh, item, "Atlas is blocked"), expected);
    assert.equal(translateCopy(tEn, item, "x"), "Atlas is blocked");
});

// ─── Phase-3b codes render the same English the server sends ────────────────

const CAUSES: FailureCause[] = ["provider_credits", "provider_auth", "rate_limited", "model_unavailable", "provider_unreachable", "budget", "runtime_offline", "stalled", "scope_denied", "unknown"];

test("failure headlines, fixes and provider trouble labels", () => {
    for (const cause of CAUSES) {
        for (const idleMs of [null, 0, 30_000, 12 * 60_000, 119 * 60_000, 5 * 60 * 60_000]) {
            assert.equal(english(failureHeadlineCopy(cause, { idleMs })), failureHeadline(cause, { idleMs }), `${cause} ${idleMs}`);
        }
        assert.equal(english(providerTroubleLabelCopy(cause)), providerTroubleLabel(cause), cause);
    }
    for (const [id, label] of Object.entries(FIX_LABEL)) assert.equal(english(copy(`failures.fixes.${id}`)), label, id);
    const view = describeFailure({ texts: ["HTTP 402"] }, { audience: "admin", agentId: "a1" });
    assert.equal(english(view.headlineCopy), view.headline);
    assert.equal(english(view.fix?.labelCopy), view.fix?.label);
});

test("stall labels", () => {
    for (const idleMs of [0, 40_000, 14 * 60_000, 65 * 60_000, 3 * 60 * 60_000 + 5 * 60_000]) {
        for (const stalled of [true, false]) assert.equal(english(stallLabelCopy({ stalled, idleMs })), stallLabel({ stalled, idleMs }), `${stalled} ${idleMs}`);
    }
});

test("task story event lines", () => {
    const names: StoryNames = { agent: (id) => (id === "a1" ? "Atlas" : null), member: (id) => (id === "m1" ? "Ana" : null) };
    const base = { id: "x", createdAt: "2026-10-23T10:00:00Z", actorId: null as string | null };
    const events: { eventType: string; actorType: string; actorId?: string | null; payloadJson: unknown }[] = [
        { eventType: "task_note", actorType: "agent", payloadJson: { note: "n", kind: "progress" } },
        { eventType: "task_note", actorType: "agent", payloadJson: { note: "n", kind: "blocker" } },
        { eventType: "task_handoff", actorType: "agent", payloadJson: { handoff: { fromRole: "SEO", toRole: "Writer" } } },
        { eventType: "task_handoff", actorType: "agent", payloadJson: {} },
        { eventType: "task_generated", actorType: "system", payloadJson: { assignee: { type: "agent", id: "a1" } } },
        { eventType: "task_generated", actorType: "system", payloadJson: { assignee: { type: "agent", id: "gone" } } },
        { eventType: "task_generated", actorType: "system", payloadJson: { assignee: { type: "human", id: "gone" } } },
        { eventType: "task_generated", actorType: "system", payloadJson: {} },
        { eventType: "task_claimed", actorType: "agent", actorId: "a1", payloadJson: null },
        { eventType: "task_assigned", actorType: "system", payloadJson: null },
        { eventType: "task_reassigned", actorType: "human", payloadJson: { assignee: { type: "member", id: "m1" } } },
        { eventType: "task_reassigned", actorType: "human", payloadJson: { assignee: null } },
        { eventType: "task_updated", actorType: "agent", payloadJson: { state: "in_progress" } },
        { eventType: "task_updated", actorType: "agent", payloadJson: {} },
        { eventType: "lease_expired_retry", actorType: "system", payloadJson: {} },
        { eventType: "dead_lettered", actorType: "system", payloadJson: {} },
        { eventType: "stall_escalation", actorType: "system", payloadJson: {} },
        { eventType: "stall_nudge", actorType: "system", payloadJson: {} },
        ...["inbox", "queued", "in_progress", "review", "blocked", "done", "failed", "dead_letter"].map((state) => ({ eventType: `task_${state}`, actorType: "agent", payloadJson: {} })),
    ];
    for (const event of events) {
        const line = describeTaskEvent({ ...base, actorId: event.actorId ?? null, ...event }, names);
        assert.equal(english(line.textCopy), line.text, event.eventType);
    }
    // An event type this build has no line for keeps its humanized English.
    assert.equal(describeTaskEvent({ ...base, eventType: "custom_thing", actorType: "system", payloadJson: {} }, names).textCopy, null);
});

test("run timeline rows and the last reasoning line", () => {
    const kinds = ["reasoning", "notice", "compaction.start", "compaction.end", "subagent.start", "subagent.end", "approval.auto", "clarify.auto", "turn.failed", "turn.interrupted"];
    const steps: TimelineStep[] = kinds.map((kind, i) => ({ seq: i + 1, ts: `t${i}`, kind }));
    // Compaction start and end merge into one row; check the end state separately.
    for (const row of timelineRows(steps)) assert.equal(english(row.labelCopy), row.label, row.kind);
    for (const kind of kinds) {
        const [row] = timelineRows([{ seq: 1, ts: "t", kind }]);
        assert.equal(english(row.labelCopy), row.label, kind);
    }
    assert.equal(timelineRows([{ seq: 1, ts: "t", kind: "tool.start", toolName: "terminal" }])[0].labelCopy, undefined, "tool rows show the tool name");
    const run = { current: { kind: "tool" }, steps: [{ seq: 1, kind: "reasoning", summary: "Weighing   the options" }] } as unknown as Parameters<typeof lastReasoningLine>[0];
    assert.equal(english(lastReasoningCopy(run)), lastReasoningLine(run));
});

test("delivery verdicts and run statuses", () => {
    const reasons = ["self", "targeted", "targeted_other", "direct", "mention", "all", "agent_pair", "task_assigned", "not_addressed", "out_of_scope", "loop_paused", "brand_new_reason"];
    for (const routeReason of reasons) {
        for (const addressed of [true, false]) {
            const verdict = { addressed, routeReason, agentStreak: 13, maxTurns: 12 };
            assert.equal(english(deliveryVerdictMessage(verdict)), deliveryVerdictCopy(verdict).label, `${routeReason} ${addressed}`);
        }
    }
    for (const status of ["succeeded", "failed", "timeout", "cancelled", "blocked", "lost", "running"]) {
        assert.equal(english(copy(`runStatus.${status}`)), runStatusCopy(status).label, status);
    }
});

test("work timeline marker and edge labels", () => {
    const kinds: TimelineEventKind[] = ["created", "assigned", "status", "note", "approval_requested", "approval_decided", "file"];
    for (const kind of kinds) {
        assert.equal(english(copy(`timeline.events.kinds.${kind}`)), eventLabel(kind, null), kind);
        if (kind === "approval_decided") {
            for (const decision of ["approved", "rejected", "dismissed", "something_else"]) {
                const key = ["approved", "rejected", "dismissed"].includes(decision) ? decision : "other";
                assert.equal(english(copy(`timeline.events.decidedBy.${key}`, { name: "Priya" })), eventLabel(kind, "Priya", decision), decision);
            }
        } else {
            assert.equal(english(copy(`timeline.events.by.${kind}`, { name: "Priya" })), eventLabel(kind, "Priya"), kind);
        }
    }
    for (const [kind, label] of Object.entries(EDGE_KIND_LABEL)) assert.equal(english(copy(`timeline.edges.${kind}`)), label, kind);
});

test("role templates and providers (display copy keyed by id)", () => {
    for (const template of agentRoleTemplates) {
        assert.equal(english(copy(`agents.roles.templates.${template.id}.title`)), template.title, template.id);
        assert.equal(english(copy(`agents.roles.templates.${template.id}.description`)), template.description, template.id);
    }
    for (const provider of agentProviders) assert.equal(english(copy(`agents.providers.${provider.id}.description`)), provider.description, provider.id);
});

test("hire reasons, Easy Setup availability and request sources", () => {
    const host = (over: Partial<HireHostFacts> = {}): HireHostFacts => ({
        status: "online", revoked: false, commands: ["provision_agent"], llmProviders: ["deepseek"], memAvailMiB: 8000, browser: true, profiles: [], ...over,
    });
    for (const facts of [host({ revoked: true }), host({ status: "offline" }), host({ commands: [] }), host({ llmProviders: [] }), host({ memAvailMiB: 300 }), host({ memAvailMiB: 1000, reservedMiB: 600 })]) {
        const hire = hireReadiness(facts);
        assert.equal(english(hireReasonCopy(hire)), hire.reason, hire.code);
    }
    assert.equal(hireReasonCopy(hireReadiness(host())), null);
    for (const [code, reason] of Object.entries(EASY_SETUP_REASONS)) assert.equal(english(copy(`agents.easySetup.availability.${code}`)), reason, code);
    for (const metadata of [{ agentRequest: { source: "zapier" } }, { agentRequest: { source: "zapier", requestedBy: "Ana" } }]) {
        assert.equal(english(requestSourceCopy(metadata)), requestSourceLabel(metadata));
    }
    assert.equal(requestSourceCopy({}), null);
});

test("common API errors map to messages; anything else keeps the server text", () => {
    for (const [text, key] of Object.entries(API_ERROR_KEYS)) {
        assert.equal(apiErrorKey(text), key, text);
        english(apiErrorCopy(text));
    }
    assert.equal(apiErrorKey("Forbidden — this action requires one of: owner, admin."), "forbidden");
    assert.equal(apiErrorKey("Company name must be at least 3 characters."), null);
    assert.equal(apiErrorCopy(""), null);
    assert.equal(translateCopy(tEn, apiErrorCopy("Some new error"), "Some new error"), "Some new error");
});

test("every inbox entry key the attention builder uses exists", () => {
    const source = readFileSync(path.join(ROOT, "src/lib/attention.ts"), "utf8");
    const used = [
        ...[...source.matchAll(/entryTitle\("(\w+)"/g)].map((m) => `inbox.entries.titles.${m[1]}`),
        ...[...source.matchAll(/entryAction\("(\w+)"/g)].map((m) => `inbox.entries.actions.${m[1]}`),
        ...[...source.matchAll(/entryAction\([^)]*\? "(\w+)" : "(\w+)"\)/g)].flatMap((m) => [`inbox.entries.actions.${m[1]}`, `inbox.entries.actions.${m[2]}`]),
        ...[...source.matchAll(/entryArea\("(\w+)"/g)].map((m) => `inbox.entries.areas.${m[1]}`),
        ...[...source.matchAll(/"(inbox\.entries\.[\w.]+)"/g)].map((m) => m[1]),
        ...[...source.matchAll(/"(stateBlocked|stateGaveUp|stateFailed|agentBlocked|agentNoConnection|agentOfflineWithWork|runTimedOut|runLost|runFailed|messageFailed|awaitingResponse|reviewWork|reviewRequest|inspectDelivery|openChat|openTask|openAgent)"/g)].map((m) => m[1]),
    ];
    assert.ok(used.length > 20, `found ${used.length} keys`);
    const flat = new Set<string>();
    (function walk(tree: Tree, prefix: string) {
        for (const [key, value] of Object.entries(tree)) {
            if (typeof value === "string") flat.add(`${prefix}${key}`);
            else walk(value, `${prefix}${key}.`);
        }
    })(en, "");
    const entries = new Set([...flat].filter((key) => key.startsWith("inbox.entries.")).map((key) => key.split(".").pop()!));
    for (const key of used) {
        if (key.startsWith("inbox.entries.")) assert.ok(flat.has(key), `en.json has no ${key}`);
        else assert.ok(entries.has(key), `inbox.entries has no ${key}`);
    }
});
