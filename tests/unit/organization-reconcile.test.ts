import assert from "node:assert/strict";
import test from "node:test";
import type { GroupSummary } from "../../src/lib/groups";
import { organizationTreeText } from "../../src/lib/organization-briefing";
import { reconcileOrganizationChart, chartLive, chartTeamIds } from "../../src/lib/organization-reconcile";
import type { OrganizationNode } from "../../src/lib/organization-tree";

const DEV = "69ec6ed7-5b56-4b79-88a0-df3a778ef7c6";
const OPS = "a3d3cddc-b2bd-4c50-a61e-0c66809167df";

const member = (kind: "agent" | "human", id: string, name: string, role = "member") => ({ kind, id, name, role });

/** Development team as it is today: Hermes-Architect coordinates, Architect + Viktor + Jose. */
function devTeam(): GroupSummary {
    return {
        id: DEV,
        title: "Development team",
        description: null,
        icon: null,
        createdByType: "agent",
        createdById: null,
        createdAt: "2026-11-20T00:00:00.000Z",
        isAgentPair: false,
        members: [member("agent", "a-architect", "Hermes-Architect", "coordinator"), member("agent", "a-viktor", "Viktor"), member("human", "p-jose", "Jose")],
        coordinator: member("agent", "a-architect", "Hermes-Architect", "coordinator"),
    };
}

/** The chart the editor saved before the room was fixed: Builder leading, Courier and a deleted agent as members. */
function staleChart(): OrganizationNode[] {
    return [
        { id: "root", parentId: null, kind: "person", person: { kind: "human", id: "p-jose" } },
        { id: "architect", parentId: "root", kind: "person", person: { kind: "agent", id: "a-architect" } },
        { id: "team-dev", parentId: "architect", kind: "team", teamId: DEV, leaderAgentId: "a-builder" },
        { id: "m-builder", parentId: "team-dev", kind: "person", person: { kind: "agent", id: "a-builder" } },
        { id: "m-courier", parentId: "team-dev", kind: "person", person: { kind: "agent", id: "a-courier" } },
        { id: "m-ghost", parentId: "team-dev", kind: "person", person: { kind: "agent", id: "a-deleted" } },
    ];
}

const roster = ["a-architect", "a-viktor", "a-builder", "a-courier", "a-qa"];
const people = ["p-jose"];
const live = () => chartLive(roster.map((id) => ({ id })), people.map((id) => ({ id })));

const tree = (nodes: OrganizationNode[], teams: GroupSummary[]) =>
    organizationTreeText({
        nodes,
        teams,
        names: [
            { kind: "human", id: "p-jose", name: "Jose", role: "Founder" },
            { kind: "agent", id: "a-architect", name: "Hermes-Architect", role: "Lead Developer" },
            { kind: "agent", id: "a-viktor", name: "Viktor", role: "Chief of Staff" },
            { kind: "agent", id: "a-builder", name: "Builder", role: "Ops" },
            { kind: "agent", id: "a-courier", name: "Courier", role: "Comms" },
        ],
        agentId: "a-architect",
        leader: { kind: "human", id: "p-jose" },
    });

test("the room's coordinator leads its team node", () => {
    const nodes = reconcileOrganizationChart(staleChart(), [devTeam()], live());
    const team = nodes.find((node) => node.id === "team-dev");
    assert.equal(team?.kind === "team" && team.leaderAgentId, "a-architect");
    const text = tree(nodes, [devTeam()]);
    assert.match(text, /Team Development team, led by Hermes-Architect/);
    assert.ok(!text.includes("led by Builder"), text);
});

test("people who are no longer in the room leave the chart", () => {
    const nodes = reconcileOrganizationChart(staleChart(), [devTeam()], live());
    const ids = new Set(nodes.map((node) => node.id));
    assert.ok(!ids.has("m-builder"), "a former member who is still an agent must not stay on the team");
    assert.ok(!ids.has("m-courier"), "Courier is not in the room");
    const text = tree(nodes, [devTeam()]);
    assert.ok(!text.includes("Builder"), text);
    assert.ok(!text.includes("Courier"), text);
});

test("an agent who no longer exists leaves the chart instead of becoming 'An agent'", () => {
    const nodes = reconcileOrganizationChart(staleChart(), [devTeam()], live());
    assert.ok(!nodes.some((node) => node.id === "m-ghost"));
    const text = tree(nodes, [devTeam()]);
    assert.ok(!text.includes("An agent"), text);
});

test("a member added to the room appears under its team", () => {
    const nodes = reconcileOrganizationChart(staleChart(), [devTeam()], live());
    const added = nodes.find((node) => node.kind === "person" && node.person.id === "a-viktor");
    assert.ok(added, "Viktor joined the room and must show on the chart");
    assert.equal(added.parentId, "team-dev");
});

test("an archived room takes its branch with it", () => {
    const chart: OrganizationNode[] = [
        { id: "root", parentId: null, kind: "person", person: { kind: "human", id: "p-jose" } },
        { id: "architect", parentId: "root", kind: "person", person: { kind: "agent", id: "a-architect" } },
        { id: "team-ops", parentId: "architect", kind: "team", teamId: OPS, leaderAgentId: "a-builder" },
        { id: "m-builder", parentId: "team-ops", kind: "person", person: { kind: "agent", id: "a-builder" } },
    ];
    const nodes = reconcileOrganizationChart(chart, [], live());
    assert.ok(!nodes.some((node) => node.id === "team-ops" || node.parentId === "team-ops"), JSON.stringify(nodes));
    assert.deepEqual(chartTeamIds(nodes), []);
});

test("someone the chart placed elsewhere is not duplicated under the team", () => {
    // QA is a member of the room and already sits on the chart as a manager.
    const team: GroupSummary = { ...devTeam(), members: [...devTeam().members, member("agent", "a-qa", "Hermes-QA")] };
    const chart: OrganizationNode[] = [
        { id: "root", parentId: null, kind: "person", person: { kind: "human", id: "p-jose" } },
        { id: "architect", parentId: "root", kind: "person", person: { kind: "agent", id: "a-architect" } },
        { id: "qa", parentId: "architect", kind: "person", person: { kind: "agent", id: "a-qa" } },
        { id: "team-dev", parentId: "qa", kind: "team", teamId: DEV, leaderAgentId: "a-architect" },
    ];
    const nodes = reconcileOrganizationChart(chart, [team], live());
    assert.equal(nodes.filter((node) => node.kind === "person" && node.person.id === "a-qa").length, 1);
});

test("a member who becomes coordinator is not drawn twice", () => {
    // The saved chart had Builder leading and Architect sitting inside the team.
    const chart: OrganizationNode[] = [
        { id: "root", parentId: null, kind: "person", person: { kind: "human", id: "p-jose" } },
        { id: "team-dev", parentId: "root", kind: "team", teamId: DEV, leaderAgentId: "a-builder" },
        { id: "m-architect", parentId: "team-dev", kind: "person", person: { kind: "agent", id: "a-architect" } },
        { id: "m-viktor", parentId: "team-dev", kind: "person", person: { kind: "agent", id: "a-viktor" } },
    ];
    const nodes = reconcileOrganizationChart(chart, [devTeam()], live());
    const team = nodes.find((node) => node.id === "team-dev");
    assert.equal(team?.kind === "team" && team.leaderAgentId, "a-architect");
    assert.equal(nodes.filter((node) => node.kind === "person" && node.person.id === "a-architect").length, 0, "the team node already stands for its leader");
    const text = tree(nodes, [devTeam()]);
    assert.equal(text.match(/Hermes-Architect/g)?.length, 1, text);
});

test("a company with no stored chart reconciles to nothing", () => {
    assert.deepEqual(reconcileOrganizationChart(undefined, [devTeam()], live()), []);
    assert.deepEqual(reconcileOrganizationChart([], [devTeam()], live()), []);
});

test("a room whose coordinator is gone keeps its saved leader instead of promoting a peer", () => {
    // A coordinator that was removed from the room is an upstream data problem:
    // the chart keeps the leader it was saved with, and no member becomes the
    // manager of its own team.
    const team: GroupSummary = { ...devTeam(), coordinator: null, members: [member("human", "p-jose", "Jose"), member("agent", "a-qa", "Hermes-QA")] };
    const nodes = reconcileOrganizationChart(staleChart(), [team], live());
    const node = nodes.find((candidate) => candidate.id === "team-dev");
    assert.equal(node?.kind === "team" && node.leaderAgentId, "a-builder");
    const qa = nodes.find((candidate) => candidate.kind === "person" && candidate.person.id === "a-qa");
    assert.ok(qa, "the members the room has today are still drawn under it");
    assert.equal(qa.parentId, "team-dev");
});
