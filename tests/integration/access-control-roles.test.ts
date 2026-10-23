/**
 * Human roles (owner/admin/member/viewer) and restricted members, through the
 * real route handlers with a real DB session. Role and scope must come from
 * the DB on every request: the stubbed session carries neither (like a JWT
 * minted before an admin changed them).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dbAvailable, getDb, getSchema, resetDb, seedAgent } from "./_helper";
import { actAs, call, seedHuman, seedTwoTenantsOfWork } from "./_access-helper";

const maybe = dbAvailable ? test : test.skip;
type Role = "owner" | "admin" | "member" | "viewer";
const ROLES: Role[] = ["owner", "admin", "member", "viewer"];
const RANK: Record<Role, number> = { owner: 3, admin: 2, member: 1, viewer: 0 };

async function company() {
    await resetDb();
    const db = await getDb();
    const { users, companies } = await getSchema();
    const [creator] = await db.insert(users).values({ email: `creator-${randomUUID()}@example.com`, passwordHash: "x" }).returning();
    const [row] = await db.insert(companies).values({ name: "ACL Co", createdByUserId: creator.id }).returning();
    return row.id;
}

/** Each mutation with the lowest role allowed to perform it. */
function mutations(ctx: { agentId: string; projectId: string; companyId: string }) {
    return [
        { name: "create project", min: "member" as Role, run: async () => call((await import("@/app/api/projects/route")).POST, "/api/projects", { method: "POST", body: { goal: `p-${randomUUID()}` } }) },
        { name: "create customer", min: "member" as Role, run: async () => call((await import("@/app/api/customers/route")).POST, "/api/customers", { method: "POST", body: { name: `c-${randomUUID()}` } }) },
        { name: "create task", min: "member" as Role, run: async () => call((await import("@/app/api/tasks/route")).POST, "/api/tasks", { method: "POST", body: { projectId: ctx.projectId, title: "t" } }) },
        { name: "edit agent", min: "member" as Role, run: async () => call((await import("@/app/api/agents/[id]/route")).PATCH as never, `/api/agents/${ctx.agentId}`, { method: "PATCH", params: { id: ctx.agentId }, body: { role: "QA" } }) },
        { name: "create knowledge note", min: "member" as Role, run: async () => call((await import("@/app/api/resources/route")).POST as never, "/api/resources", { method: "POST", body: { name: `n-${randomUUID()}`, resourceType: "knowledge_base", provider: "knowledge" } }) },
        { name: "change an agent's data scope", min: "admin" as Role, run: async () => call((await import("@/app/api/agents/[id]/route")).PATCH as never, `/api/agents/${ctx.agentId}`, { method: "PATCH", params: { id: ctx.agentId }, body: { scopeJson: { mode: "all" } } }) },
        { name: "direct-chat mode", min: "admin" as Role, run: async () => call((await import("@/app/api/settings/direct-chats/route")).PUT, "/api/settings/direct-chats", { method: "PUT", body: { mode: "shared" } }) },
        { name: "mint MCP token", min: "admin" as Role, run: async () => call((await import("@/app/api/settings/tokens/route")).POST, "/api/settings/tokens", { method: "POST", body: { name: "t", scope: "mcp_full" } }) },
        { name: "edit LLM pricing", min: "admin" as Role, run: async () => call((await import("@/app/api/ui/pricing/route")).POST, "/api/ui/pricing", { method: "POST", body: { provider: "deepseek", model: `m-${randomUUID()}`, label: "m", inputPricePer1k: 1, outputPricePer1k: 1 } }) },
    ];
}

maybe("role matrix: viewers never mutate; each action needs its minimum role", async () => {
    const companyId = await company();
    const work = await seedTwoTenantsOfWork(companyId);
    const agent = await seedAgent(companyId, { name: "Matrix" });
    const failures: string[] = [];
    for (const role of ROLES) {
        const user = await seedHuman(companyId, role);
        actAs(user);
        for (const m of mutations({ agentId: agent.id, projectId: work.projectIn.id, companyId })) {
            const res = await m.run();
            const allowed = RANK[role] >= RANK[m.min];
            const denied = res.status === 401 || res.status === 403;
            if (allowed && denied) failures.push(`${role} was refused "${m.name}" (${res.status})`);
            if (!allowed && !denied) failures.push(`${role} was allowed "${m.name}" (${res.status})`);
        }
        // Every role can read.
        const read = await call((await import("@/app/api/projects/route")).GET as never, "/api/projects");
        if (read.status !== 200) failures.push(`${role} could not read projects (${read.status})`);
    }
    actAs(null);
    assert.deepEqual(failures, []);
});

maybe("member management: last owner, owners vs admins, removal signs the person out", async () => {
    const companyId = await company();
    const owner = await seedHuman(companyId, "owner");
    const admin = await seedHuman(companyId, "admin");
    const member = await seedHuman(companyId, "member");
    const route = await import("@/app/api/instance/members/[userId]/route");

    actAs(owner);
    const demoteSelf = await call(route.PUT, `/api/instance/members/${owner.userId}`, { method: "PUT", params: { userId: owner.userId }, body: { role: "admin" } });
    assert.equal(demoteSelf.status, 422, "the last owner demoted themselves");

    actAs(admin);
    const removeOwner = await call(route.DELETE, `/api/instance/members/${owner.userId}`, { method: "DELETE", params: { userId: owner.userId } });
    assert.equal(removeOwner.status, 403, "an admin removed an owner");
    const promote = await call(route.PUT, `/api/instance/members/${member.userId}`, { method: "PUT", params: { userId: member.userId }, body: { role: "owner" } });
    assert.equal(promote.status, 403, "an admin changed roles");

    actAs(owner);
    const removed = await call(route.DELETE, `/api/instance/members/${member.userId}`, { method: "DELETE", params: { userId: member.userId } });
    assert.equal(removed.status, 200);
    actAs(member);
    const afterRemoval = await call((await import("@/app/api/projects/route")).GET as never, "/api/projects");
    assert.equal(afterRemoval.status, 401, "a removed member's open session still reached company data");
    actAs(null);
});

maybe("restricted member: only their agents, customers and projects, applied from the DB", async () => {
    const companyId = await company();
    const work = await seedTwoTenantsOfWork(companyId);
    const agentIn = await seedAgent(companyId, { name: "Agent In" });
    const agentOut = await seedAgent(companyId, { name: "Agent Out" });
    const restricted = await seedHuman(companyId, "member", {
        scope: { mode: "restricted", agentIds: [agentIn.id], customerIds: [work.customerIn.id] },
    });
    actAs(restricted);

    const agents = await call((await import("@/app/api/agents/route")).GET as never, "/api/agents");
    assert.deepEqual((agents.json.agents as { id: string }[]).map((a) => a.id), [agentIn.id]);
    const agentRoute = await import("@/app/api/agents/[id]/route");
    assert.equal((await call(agentRoute.GET, `/api/agents/${agentOut.id}`, { params: { id: agentOut.id } })).status, 404);
    assert.equal((await call(agentRoute.PATCH, `/api/agents/${agentOut.id}`, { method: "PATCH", params: { id: agentOut.id }, body: { role: "x" } })).status, 404);
    const chat = await call((await import("@/app/api/chat/route")).GET, `/api/chat?targetAgentId=${agentOut.id}`);
    assert.equal(chat.status, 404, "reading the chat of an agent outside the scope");

    const customers = await call((await import("@/app/api/customers/route")).GET as never, "/api/customers");
    assert.deepEqual((customers.json.customers as { id: string }[]).map((c) => c.id), [work.customerIn.id]);
    const projects = await call((await import("@/app/api/projects/route")).GET as never, "/api/projects");
    assert.deepEqual((projects.json.projects as { id: string }[]).map((p) => p.id), [work.projectIn.id]);

    const taskRoute = await import("@/app/api/tasks/[id]/route");
    assert.equal((await call(taskRoute.PATCH, `/api/tasks/${work.taskOut.id}`, { method: "PATCH", params: { id: work.taskOut.id }, body: { title: "x" } })).status, 404);
    const created = await call((await import("@/app/api/tasks/route")).POST, "/api/tasks", { method: "POST", body: { projectId: work.projectOut.id, title: "x" } });
    assert.equal(created.status, 404, "creating work in an out-of-scope project");

    const { createScopedResource } = await import("@/lib/resources");
    await createScopedResource({ companyId, provider: "knowledge", resourceType: "knowledge_base", scopeType: "project", scopeId: work.projectOut.id, name: "out-note", configText: "OUT-NOTE" });
    const notes = await call((await import("@/app/api/resources/route")).GET as never, "/api/resources");
    assert.equal(notes.text.includes("OUT-NOTE"), false, "knowledge of an out-of-scope project");

    const health = await call((await import("@/app/api/ui/agents/health/route")).GET as never, "/api/ui/agents/health");
    assert.equal(health.text.includes(agentOut.id), false, "agent health of an out-of-scope agent");

    // An admin narrows the scope: the very next request applies it, no re-login.
    const db = await getDb();
    const { companyMembers } = await getSchema();
    const { eq } = await import("drizzle-orm");
    await db.update(companyMembers).set({ scopeJson: { mode: "restricted", agentIds: [], customerIds: [work.customerIn.id] } }).where(eq(companyMembers.id, restricted.membershipId));
    const narrowed = await call((await import("@/app/api/agents/route")).GET as never, "/api/agents");
    assert.deepEqual(narrowed.json.agents, [], "restricted with no agents ticked must see no agents");
    actAs(null);
});
