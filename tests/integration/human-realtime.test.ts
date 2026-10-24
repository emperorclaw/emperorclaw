import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dbAvailable, getDb, getSchema, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";
import { seedHuman, seedTwoTenantsOfWork } from "./_access-helper";

/**
 * Browser realtime (human) fan-out: a signed-in person's socket receives an
 * invalidation for what they can see — team chat and in-scope work — and
 * nothing for another user's private thread or an out-of-scope project.
 * Exercises the full chain: broadcastMcpEvent (audience + subject resolution),
 * parseRealtimeNotification, resolveHumanRealtimeContext, humanSocketReceives
 * and eventTopicsFor, against a real Postgres.
 */
const maybe = dbAvailable ? test : test.skip;

async function world() {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const work = await seedTwoTenantsOfWork(companyId);
    const agent = await seedAgent(companyId, { name: "Xavier", provider: "hermes" });
    const owner = await seedHuman(companyId, "owner");
    // Restricted member: only the "in" customer (and thus the "in" project) and Xavier.
    const member = await seedHuman(companyId, "member", { scope: { mode: "restricted", customerIds: [work.customerIn.id], agentIds: [agent.id] } });
    const db = await getDb();
    const { companies } = await getSchema();
    const { eq } = await import("drizzle-orm");
    await db.update(companies).set({ directChatMode: "private" }).where(eq(companies.id, companyId));
    return { companyId, ...work, agent, owner, member };
}

type Parsed = { companyId: string; audience: { agentId: string | null; ownerUserId?: string | null } | null; subject: { projectIds: string[]; customerIds: string[]; agentIds: string[] } | null; payload: any };

maybe("human realtime: invalidation reaches what the viewer can see, and nothing else", async () => {
    const s = await world();
    const { Client } = await import("pg");
    const listener = new Client({ connectionString: process.env.POSTGRES_CONNECTION_STRING });
    await listener.connect();
    const received: string[] = [];
    listener.on("notification", (msg) => { if (msg.payload) received.push(msg.payload); });
    await listener.query("LISTEN mcp_events");
    try {
        const { broadcastMcpEvent } = await import("@/lib/pubsub");
        const { ensureDirectThread, ensureTeamThread } = await import("@/lib/control-plane");

        const team = await ensureTeamThread(s.companyId);
        const privateThread = await ensureDirectThread(s.companyId, s.agent.id, s.owner.userId);

        await broadcastMcpEvent(s.companyId, { type: "thread_message", threadId: team.id, message: { id: randomUUID(), threadId: team.id } });
        await broadcastMcpEvent(s.companyId, { type: "thread_message", thread: privateThread, message: { id: randomUUID(), threadId: privateThread.id } });
        await broadcastMcpEvent(s.companyId, { type: "task_updated", task: { id: s.taskOut.id, projectId: s.projectOut.id } });
        await broadcastMcpEvent(s.companyId, { type: "task_updated", task: { id: s.taskIn.id, projectId: s.projectIn.id } });

        for (let i = 0; i < 50 && received.length < 4; i++) await new Promise((r) => setTimeout(r, 20));
        assert.equal(received.length, 4);

        const { parseRealtimeNotification, humanSocketReceives } = await import("@/lib/realtime-delivery");
        const { eventTopicsFor } = await import("@/lib/realtime-topics");
        const { resolveHumanRealtimeContext } = await import("@/lib/realtime-human");

        const member = await resolveHumanRealtimeContext(s.member.userId);
        const owner = await resolveHumanRealtimeContext(s.owner.userId);
        assert.ok(member && owner, "both humans resolve a realtime context");

        const events = received.map((raw) => parseRealtimeNotification(raw)!) as Parsed[];
        const byThread = (id: string) => events.find((e) => (e.payload as any)?.threadId === id || (e.payload as any)?.thread?.id === id)!;
        const byTask = (id: string) => events.find((e) => (e.payload as any)?.task?.id === id)!;

        const teamEvent = byThread(team.id);
        const privateEvent = byThread(privateThread.id);
        const outTask = byTask(s.taskOut.id);
        const inTask = byTask(s.taskIn.id);
        assert.ok(teamEvent && privateEvent && outTask && inTask, "all four notifications were captured");

        // A message in a thread the member can see → invalidation.
        assert.equal(humanSocketReceives(teamEvent, member), true);
        assert.ok(eventTopicsFor(teamEvent.payload, teamEvent.subject).includes("dashboard"));

        // Another user's private thread → nothing for the member, something for the owner.
        assert.equal(humanSocketReceives(privateEvent, member), false);
        assert.equal(humanSocketReceives(privateEvent, owner), true);

        // Out-of-scope project → nothing; in-scope project → invalidation.
        assert.equal(humanSocketReceives(outTask, member), false);
        assert.equal(humanSocketReceives(inTask, member), true);
        assert.ok(eventTopicsFor(inTask.payload, inTask.subject).includes(`task:${s.taskIn.id}`));
    } finally {
        await listener.end();
    }
});
