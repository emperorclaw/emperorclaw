import { test } from "node:test";
import assert from "node:assert/strict";
import { BUSINESS_TYPES, MAX_WIZARD_AGENTS, TEAM_TEMPLATES, planTeam, suggestedTeams, teamPlanProblem } from "../../src/lib/onboarding-shared";
import { agentRoleTemplates } from "../../src/lib/agent-templates";

const base = { includeBoss: true, extraRoles: [], removedRoles: [], names: {} };

test("every team role and business suggestion points at something real", () => {
    const roles = new Set(agentRoleTemplates.map((t) => t.id));
    for (const t of TEAM_TEMPLATES) for (const r of t.roles) assert.ok(roles.has(r), `${t.id} uses unknown role ${r}`);
    const teams = new Set(TEAM_TEMPLATES.map((t) => t.id));
    for (const b of BUSINESS_TYPES) for (const t of b.teams) assert.ok(teams.has(t), `${b.id} suggests unknown team ${t}`);
});

test("a development team is a Boss, a developer, a tester, and their group", () => {
    const plan = planTeam({ ...base, teams: ["development"] });
    assert.deepEqual(plan.agents.map((a) => a.name), ["Boss", "Builder", "Tester"]);
    assert.equal(plan.groups.length, 1);
    assert.equal(plan.groups[0].title, "Development team");
    assert.deepEqual(plan.groups[0].roles, ["boss", "developer", "qa"]);
});

test("teams combine; a shared role is one agent in both groups", () => {
    const plan = planTeam({ ...base, teams: ["marketing", "outreach"] });
    assert.equal(plan.agents.filter((a) => a.templateId === "content").length, 1, "one Writer");
    const groups = Object.fromEntries(plan.groups.map((g) => [g.teamId, g.roles]));
    assert.ok(groups.marketing.includes("content") && groups.outreach.includes("content"));
    assert.ok(plan.groups.every((g) => g.roles[0] === "boss"), "the Boss joins every group");
});

test("names, removals, and extras shape the plan; groups need a specialist", () => {
    const plan = planTeam({ teams: ["support"], includeBoss: true, extraRoles: ["analyst"], removedRoles: ["support"], names: { boss: "Ana" } });
    assert.deepEqual(plan.agents.map((a) => a.name), ["Ana", "Analyst"]);
    assert.equal(plan.groups.length, 0, "a team without its specialists gets no group");
    const noBoss = planTeam({ ...base, includeBoss: false, teams: ["finance"] });
    assert.deepEqual(noBoss.groups[0].roles, ["accountant", "analyst"]);
});

test("the plan is checked before anything is created", () => {
    assert.match(teamPlanProblem(planTeam({ ...base, includeBoss: false, teams: [] }))!, /at least one/);
    assert.match(teamPlanProblem(planTeam({ ...base, teams: ["development"], names: { qa: "builder" } }))!, /same name/);
    assert.match(teamPlanProblem(planTeam({ ...base, teams: ["development"], names: { qa: "  " } }))!, /needs a name/);
    const all = planTeam({ ...base, teams: TEAM_TEMPLATES.map((t) => t.id) });
    assert.ok(all.agents.length <= MAX_WIZARD_AGENTS + 1);
    assert.equal(teamPlanProblem(planTeam({ ...base, teams: ["development"] })), null);
    assert.deepEqual(suggestedTeams("software"), ["development"]);
    assert.deepEqual(suggestedTeams("unknown"), []);
});
