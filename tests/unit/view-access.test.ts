import { test } from "node:test";
import assert from "node:assert/strict";
import en from "../../messages/en.json";
import {
    defaultViewVisibility, maintainerAgentId, mayChangeMaintainer, mayChangeVisibility, parseRefreshEveryMinutes, pickViewOwner, refreshCadenceText, viewAccess, viewAudience, viewStaleness, visibilityChangeNarrows,
    type ViewAccessFacts, type ViewAccessSubject,
} from "../../src/lib/view-access";

const OWNER = "owner-user";
const SHARED = "shared-user";
const OTHER = "other-user";
const ADMIN = "admin-user";
const BUILDER = "builder-agent";
const STRANGER = "stranger-agent";

const view = (visibility: string, extra: Partial<ViewAccessFacts> = {}): ViewAccessFacts => ({
    visibility, ownerUserId: OWNER, maintainerAgentId: BUILDER, sharedWith: [SHARED], ...extra,
});
const member = (userId: string, isAdmin = false): ViewAccessSubject => ({ kind: "member", userId, isAdmin });
const agent = (agentId: string | null): ViewAccessSubject => ({ kind: "agent", agentId });

test("viewAccess: the truth table for private, shared and scope views", () => {
    const callers: [string, ViewAccessSubject][] = [
        ["owner", member(OWNER)],
        ["shared person", member(SHARED)],
        ["other member", member(OTHER)],
        ["admin", member(ADMIN, true)],
        ["maintaining agent", agent(BUILDER)],
        ["other agent", agent(STRANGER)],
        ["operator token (no agent)", agent(null)],
    ];
    const expected: Record<string, Record<string, string>> = {
        private: { owner: "full", "shared person": "none", "other member": "none", admin: "metadata", "maintaining agent": "full", "other agent": "none", "operator token (no agent)": "none" },
        shared: { owner: "full", "shared person": "full", "other member": "none", admin: "metadata", "maintaining agent": "full", "other agent": "none", "operator token (no agent)": "none" },
        scope: { owner: "full", "shared person": "full", "other member": "full", admin: "full", "maintaining agent": "full", "other agent": "full", "operator token (no agent)": "full" },
    };
    for (const visibility of ["private", "shared", "scope"]) {
        for (const [name, subject] of callers) {
            assert.equal(viewAccess(subject, view(visibility), true), expected[visibility][name], `${visibility} view, ${name}`);
        }
    }
});

test("viewAccess: the scope is the ceiling for everyone, owner, shares, admins and the maintainer included", () => {
    for (const visibility of ["private", "shared", "scope"]) {
        for (const subject of [member(OWNER), member(SHARED), member(OTHER), member(ADMIN, true), agent(BUILDER), agent(STRANGER), agent(null)]) {
            assert.equal(viewAccess(subject, view(visibility), false), "none", `${visibility}, ${JSON.stringify(subject)} outside the scope`);
        }
    }
});

test("viewAccess: a share list means nothing unless the view is shared; an admin who owns or is shared gets full", () => {
    assert.equal(viewAccess(member(SHARED), view("private"), true), "none", "a leftover share on a private view");
    assert.equal(viewAccess(member(ADMIN, true), view("private", { ownerUserId: ADMIN }), true), "full");
    assert.equal(viewAccess(member(ADMIN, true), view("shared", { sharedWith: [ADMIN] }), true), "full");
});

test("viewAccess: a view with no maintainer gives no agent access; an unknown visibility fails closed", () => {
    const unmaintained = view("private", { maintainerAgentId: null });
    assert.equal(viewAccess(agent(BUILDER), unmaintained, true), "none", "the builder is not the maintainer once none is set");
    assert.equal(viewAccess(agent(null), unmaintained, true), "none", "no agent never matches no maintainer");
    assert.equal(viewAccess(agent(STRANGER), view("private", { maintainerAgentId: STRANGER }), true), "full", "the chosen maintainer, whoever built it");
    assert.equal(viewAccess(member(OTHER), view("everyone"), true), "none");
    assert.equal(viewAccess(member(ADMIN, true), view("everyone"), true), "metadata");
    assert.equal(viewAccess(member(OWNER), view("private", { ownerUserId: null }), true), "none", "an orphaned private view");
});

test("defaultViewVisibility: private for a person's own request, scope otherwise", () => {
    assert.equal(defaultViewVisibility({ ownerUserId: OWNER, source: "private_thread" }), "private");
    assert.equal(defaultViewVisibility({ ownerUserId: OWNER, source: "person" }), "private");
    assert.equal(defaultViewVisibility({ ownerUserId: OWNER, source: "conversation" }), "scope", "named in a team or group chat");
    assert.equal(defaultViewVisibility({ ownerUserId: null, source: "none" }), "scope");
    assert.equal(defaultViewVisibility({ ownerUserId: null, source: "private_thread" }), "scope", "no owner is never private");
});

test("pickViewOwner: derives from the private chat, accepts only people from the conversation", () => {
    assert.deepEqual(pickViewOwner({ explicit: null, derived: OWNER, candidates: [] }), { ok: true, ownerUserId: OWNER });
    assert.deepEqual(pickViewOwner({ explicit: null, derived: null, candidates: [OTHER] }), { ok: true, ownerUserId: null });
    assert.deepEqual(pickViewOwner({ explicit: OWNER, derived: OWNER, candidates: [] }), { ok: true, ownerUserId: OWNER });
    assert.deepEqual(pickViewOwner({ explicit: OTHER, derived: null, candidates: [SHARED, OTHER] }), { ok: true, ownerUserId: OTHER });
    const arbitrary = pickViewOwner({ explicit: STRANGER, derived: null, candidates: [OTHER] });
    assert.equal(arbitrary.ok, false, "a person with no relation to the conversation");
    const overrides = pickViewOwner({ explicit: OTHER, derived: OWNER, candidates: [] });
    assert.equal(overrides.ok, false, "a private chat's owner cannot be swapped for someone else");
});

test("viewStaleness: overdue past 1.5x the interval, measured from creation before the first value", () => {
    const now = Date.parse("2026-10-28T12:00:00Z");
    const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
    const since = ago(10_000);
    assert.deepEqual(viewStaleness({ lastAt: ago(80), since, refreshEveryMinutes: 60 }, now), { overdue: false });
    assert.deepEqual(viewStaleness({ lastAt: ago(90), since, refreshEveryMinutes: 60 }, now), { overdue: false }, "exactly 1.5x is still on time");
    assert.deepEqual(viewStaleness({ lastAt: ago(91), since, refreshEveryMinutes: 60 }, now), { overdue: true, lastAt: ago(91), expectedMinutes: 60 });
    assert.deepEqual(viewStaleness({ lastAt: ago(5000), since, refreshEveryMinutes: null }, now), { overdue: false }, "no interval, no warning");
    assert.deepEqual(viewStaleness({ lastAt: null, since: ago(30), refreshEveryMinutes: 60 }, now), { overdue: false }, "a new view gets its first interval");
    assert.deepEqual(viewStaleness({ lastAt: null, since: ago(120), refreshEveryMinutes: 60 }, now), { overdue: true, lastAt: null, expectedMinutes: 60 });
});

test("parseRefreshEveryMinutes and refreshCadenceText", () => {
    assert.deepEqual(parseRefreshEveryMinutes(undefined), { ok: true, value: undefined });
    assert.deepEqual(parseRefreshEveryMinutes(null), { ok: true, value: null });
    assert.deepEqual(parseRefreshEveryMinutes(0), { ok: true, value: null });
    assert.deepEqual(parseRefreshEveryMinutes(60), { ok: true, value: 60 });
    assert.deepEqual(parseRefreshEveryMinutes("1440"), { ok: true, value: 1440 });
    for (const bad of [-5, 1.5, 999_999, "hourly", true]) assert.equal(parseRefreshEveryMinutes(bad).ok, false, String(bad));
    assert.equal(refreshCadenceText(60), "hourly");
    assert.equal(refreshCadenceText(15), "every 15 min");
    assert.equal(refreshCadenceText(360), "every 6 h");
    assert.equal(refreshCadenceText(1440), "daily");
    assert.equal(refreshCadenceText(10080), "weekly");
});

test("who may change who sees a view: its owner, or an owner/admin when it has no owner; never an agent", () => {
    assert.equal(mayChangeVisibility(OWNER, member(OWNER)), true);
    assert.equal(mayChangeVisibility(OWNER, member(OTHER)), false);
    assert.equal(mayChangeVisibility(OWNER, member(ADMIN, true)), false, "an admin does not override a real owner");
    assert.equal(mayChangeVisibility(null, member(ADMIN, true)), true);
    assert.equal(mayChangeVisibility(null, member(OTHER)), false, "a plain member never claims an ownerless view");
    assert.equal(mayChangeVisibility(null, agent(BUILDER)), false);
    assert.equal(mayChangeVisibility(OWNER, agent(null)), false);
});

test("taking a view away from everyone in scope asks first; widening it or re-picking does not", () => {
    assert.equal(visibilityChangeNarrows("scope", "private"), true);
    assert.equal(visibilityChangeNarrows("scope", "shared"), true);
    assert.equal(visibilityChangeNarrows("scope", "scope"), false);
    assert.equal(visibilityChangeNarrows("private", "scope"), false);
    assert.equal(visibilityChangeNarrows("shared", "private"), false);
    assert.equal(visibilityChangeNarrows("private", "shared"), false);
});

test("everyone in scope reads as the real audience", () => {
    assert.deepEqual(viewAudience({ scopeType: "company", scopeLabel: null }), { key: "everyoneCompany" });
    assert.deepEqual(viewAudience({ scopeType: "project", scopeLabel: "Launch" }), { key: "everyoneOn", name: "Launch" });
    assert.deepEqual(viewAudience({ scopeType: "customer", scopeLabel: "Acme" }), { key: "everyoneAt", name: "Acme" });
    assert.deepEqual(viewAudience({ scopeType: "project", scopeLabel: null }), { key: "everyoneProject" });
    assert.deepEqual(viewAudience({ scopeType: "customer", scopeLabel: null }), { key: "everyoneClient" });
    // Every key it names is a views.visibility message.
    const messages = (en as { views: { visibility: Record<string, string> } }).views.visibility;
    for (const key of ["everyoneCompany", "everyoneOn", "everyoneAt", "everyoneProject", "everyoneClient"]) assert.equal(typeof messages[key], "string", key);
    assert.equal(messages.everyoneOn.replace("{name}", "Launch"), "Everyone on Launch");
});

test("maintainerAgentId reads the explicit column only", () => {
    assert.equal(maintainerAgentId({ maintainerAgentId: BUILDER }), BUILDER);
    assert.equal(maintainerAgentId({ maintainerAgentId: null }), null);
});

test("mayChangeMaintainer: the owner or an admin who can open the view; never an agent", () => {
    assert.equal(mayChangeMaintainer(OWNER, member(OWNER), true), true, "the owner");
    assert.equal(mayChangeMaintainer(OWNER, member(ADMIN, true), true), true, "an admin who can open it");
    assert.equal(mayChangeMaintainer(null, member(ADMIN, true), true), true, "an admin on an ownerless view");
    assert.equal(mayChangeMaintainer(OWNER, member(ADMIN, true), false), false, "an admin who only sees its name");
    assert.equal(mayChangeMaintainer(OWNER, member(SHARED), true), false, "a person it is shared with");
    assert.equal(mayChangeMaintainer(null, member(OTHER), true), false, "a member on an ownerless view");
    assert.equal(mayChangeMaintainer(OWNER, agent(BUILDER), true), false, "the maintaining agent itself");
    assert.equal(mayChangeMaintainer(OWNER, agent(null), true), false, "an operator connection");
});
