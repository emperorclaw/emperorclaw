import { NextRequest } from "next/server";
import { groupMcpRoute } from "@/lib/group-mcp-route";
import { loadOrganization, organizationBriefing } from "@/lib/organization";
import { mcpAccessForAgent } from "@/lib/mcp-access";

type Person = { kind: string; id: string; name: string } | null;

export async function GET(req: NextRequest) {
    return groupMcpRoute(req, new URL(req.url).searchParams.get("agentId"), async ({ companyId, actor }) => {
        const org = await loadOrganization(companyId);
        // Bound agents receive only their own team memberships, never pair threads.
        const briefing = organizationBriefing(org.leader, org.teams, actor.type === "agent" ? actor.id! : "", org.config.nodes, [...org.roster.map(p => ({id:p.id,name:p.name,kind:"agent" as const})),...org.people.map(p => ({id:p.id,name:p.name,kind:"human" as const}))]);
        // An agent limited to certain agents gets no names/ids of the others as
        // leaders, coordinators or reporting targets (one-way: its own list).
        const reach = actor.type === "agent" ? (await mcpAccessForAgent(companyId, actor.id)).allowedAgentIds : null;
        const visible = <T extends Person>(person: T): T | null => !reach || !person || person.kind !== "agent" || reach.has(person.id) ? person : null;
        const scoped = reach ? {
            ...briefing,
            leader: visible(briefing.leader),
            reporting: briefing.reporting.map((r) => ({ ...r, reportsTo: visible(r.reportsTo) })),
            teams: briefing.teams.map((t) => ({ ...t, coordinator: visible(t.coordinator) })),
        } : briefing;
        return { configured: org.configured, companyName: org.companyName, ...scoped, consult: "GET /organization (agent-bound token); team details: GET /groups?mine=1" };
    });
}
