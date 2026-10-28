/**
 * 0.20 access without bureaucracy: roles per client and project
 * (resource_memberships, lib/resource-roles.ts) and "Who can use it" on agents
 * (lib/agent-access.ts). Mirrors views-privacy.test.ts: real routes, real DB,
 * the session swapped by actAs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dbAvailable, getDb, getSchema, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";
import { actAs, bearer, call, seedHuman, seedMcpToken, seedTwoTenantsOfWork } from "./_access-helper";

const maybe = dbAvailable ? test : test.skip;

type Human = Awaited<ReturnType<typeof seedHuman>>;

async function grant(companyId: string, who: Human, resourceType: "customer" | "project", resourceId: string, role: "admin" | "editor" | "viewer") {
    const db = await getDb();
    const { resourceMemberships } = await getSchema();
    await db.insert(resourceMemberships).values({ companyId, userId: who.userId, resourceType, resourceId, role });
}

async function fixture() {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const work = await seedTwoTenantsOfWork(companyId);
    const owner = await seedHuman(companyId, "owner");
    const admin = await seedHuman(companyId, "admin");
    const member = await seedHuman(companyId, "member");
    const viewer = await seedHuman(companyId, "viewer");
    return { companyId, ...work, owner, admin, member, viewer };
}

const routes = async () => ({
    task: await import("@/app/api/tasks/[id]/route"),
    tasks: await import("@/app/api/tasks/route"),
    customers: await import("@/app/api/customers/route"),
    customer: await import("@/app/api/customers/[id]/route"),
    projects: await import("@/app/api/projects/route"),
    customerAccess: await import("@/app/api/customers/[id]/access/route"),
    projectAccess: await import("@/app/api/projects/[projectId]/access/route"),
    memberRole: await import("@/app/api/instance/members/[userId]/route"),
    memberScope: await import("@/app/api/instance/members/[userId]/scope/route"),
    agents: await import("@/app/api/agents/route"),
    agent: await import("@/app/api/agents/[id]/route"),
    agentAccess: await import("@/app/api/agents/[id]/access/route"),
    chat: await import("@/app/api/chat/route"),
    mcpTasks: await import("@/app/api/mcp/tasks/route"),
});

// ─── Migration ──────────────────────────────────────────────────────────────

maybe("migration 0072 moves customer lists to memberships and nobody gains or loses access", async () => {
    const f = await fixture();
    const db = await getDb();
    const { users, companyMembers, customers, projects, resourceMemberships } = await getSchema();
    const { eq, sql, and, inArray } = await import("drizzle-orm");
    const { loadMemberScope, memberVisibleProjectIds } = await import("@/lib/member-scope");
    const [gone] = await db.insert(customers).values({ id: randomUUID(), companyId: f.companyId, name: "Gone", deletedAt: new Date() }).returning();
    await db.insert(projects).values({ companyId: f.companyId, goal: "Internal", status: "active", customerId: null });
    const agentId = randomUUID();

    // The pre-0.20 shapes, written straight to company_members.scope_json.
    const legacy: { label: string; role: string; instanceRole?: string; scope: Record<string, unknown> }[] = [
        { label: "restricted member", role: "member", scope: { mode: "restricted", customerIds: [f.customerIn.id], agentIds: [agentId] } },
        { label: "restricted viewer, two customers", role: "viewer", scope: { mode: "restricted", customerIds: [f.customerIn.id, f.customerOut.id.toUpperCase()], agentIds: [] } },
        { label: "restricted, nothing", role: "member", scope: { mode: "restricted", customerIds: [], agentIds: [] } },
        { label: "restricted, junk ids", role: "member", scope: { mode: "restricted", customerIds: [f.customerIn.id, "nope", randomUUID(), gone.id] } },
        { label: "admin with a stray list", role: "admin", scope: { mode: "restricted", customerIds: [f.customerIn.id] } },
        { label: "instance admin member", role: "member", instanceRole: "instance_admin", scope: { mode: "restricted", customerIds: [f.customerIn.id] } },
        { label: "unrestricted with a stray list", role: "member", scope: { mode: "all", customerIds: [f.customerOut.id] } },
        { label: "empty scope", role: "viewer", scope: {} },
    ];
    // What the 0.19 code computed: projects follow the customers in scope_json
    // (an SQL uuid match, so the id's letter case never mattered).
    const oldVisible = async (role: string, instanceRole: string, scope: Record<string, unknown>) => {
        if (instanceRole === "instance_admin" || role === "owner" || role === "admin" || scope.mode !== "restricted") return null;
        const ids = (Array.isArray(scope.customerIds) ? scope.customerIds : []).filter((id): id is string => typeof id === "string").map((id) => id.toLowerCase());
        const rows = await db.select({ id: projects.id, customerId: projects.customerId }).from(projects).where(eq(projects.companyId, f.companyId));
        return {
            projects: rows.filter((p) => p.customerId && ids.includes(p.customerId)).map((p) => p.id).sort(),
            agents: (Array.isArray(scope.agentIds) ? scope.agentIds : []).slice().sort(),
        };
    };
    const people: { label: string; userId: string; role: string; before: Awaited<ReturnType<typeof oldVisible>> }[] = [];
    for (const l of legacy) {
        const [user] = await db.insert(users).values({ email: `${randomUUID()}@example.com`, passwordHash: "x", instanceRole: l.instanceRole ?? "member" }).returning();
        await db.insert(companyMembers).values({ companyId: f.companyId, userId: user.id, role: l.role, scopeJson: l.scope });
        people.push({ label: l.label, userId: user.id, role: l.role, before: await oldVisible(l.role, l.instanceRole ?? "member", l.scope) });
    }

    const migration = readFileSync(path.join(process.cwd(), "src/db/migrations/0072_access-roles.sql"), "utf8");
    const statements = migration.split("--> statement-breakpoint").map((s) => s.trim())
        .filter((s) => s.includes('INSERT INTO "resource_memberships"') || s.includes('UPDATE "company_members"'));
    assert.equal(statements.length, 2, "the data statements");
    for (const statement of statements) await db.execute(sql.raw(statement));
    for (const statement of statements) await db.execute(sql.raw(statement)); // idempotent

    for (const p of people) {
        const scope = await loadMemberScope(p.userId, f.companyId);
        const visible = await memberVisibleProjectIds(f.companyId, scope);
        if (p.before === null) {
            assert.equal(scope, null, `${p.label}: still unrestricted`);
            continue;
        }
        assert.deepEqual([...(visible ?? [])].sort(), p.before.projects, `${p.label}: same projects`);
        assert.deepEqual([...(scope?.agentIds ?? [])].sort(), p.before.agents, `${p.label}: same agents`);
    }
    const rows = await db.select().from(resourceMemberships).where(inArray(resourceMemberships.userId, people.map((p) => p.userId)));
    const of = (label: string) => rows.filter((r) => r.userId === people.find((p) => p.label === label)!.userId);
    assert.deepEqual(of("restricted member").map((r) => [r.resourceId, r.role]), [[f.customerIn.id, "editor"]], "member -> editor");
    assert.deepEqual(of("restricted viewer, two customers").map((r) => r.role), ["viewer", "viewer"], "viewer -> viewer, ids matched case-insensitively");
    assert.deepEqual(of("restricted, junk ids").map((r) => r.resourceId).sort(), [f.customerIn.id, gone.id].sort(), "only customers of the company");
    for (const label of ["admin with a stray list", "instance admin member", "unrestricted with a stray list", "empty scope"]) {
        assert.deepEqual(of(label), [], `${label}: no rows`);
    }
    const leftovers = await db.select({ scopeJson: companyMembers.scopeJson }).from(companyMembers)
        .where(and(eq(companyMembers.companyId, f.companyId), sql`${companyMembers.scopeJson} ? 'customerIds'`));
    assert.deepEqual(leftovers, [], "customerIds left scope_json");
});

// ─── Roles per client and project ───────────────────────────────────────────

maybe("a company viewer with Can edit on a project edits tasks there and nowhere else", async () => {
    const f = await fixture();
    const r = await routes();
    await grant(f.companyId, f.viewer, "project", f.projectIn.id, "editor");
    actAs(f.viewer);
    const inside = await call(r.task.PATCH, `/api/tasks/${f.taskIn.id}`, { method: "PATCH", body: { priority: 2 }, params: { id: f.taskIn.id } });
    assert.equal(inside.status, 200, inside.text);
    const outside = await call(r.task.PATCH, `/api/tasks/${f.taskOut.id}`, { method: "PATCH", body: { priority: 2 }, params: { id: f.taskOut.id } });
    assert.equal(outside.status, 403, "a viewer elsewhere");
    const created = await call(r.tasks.POST, "/api/tasks", { method: "POST", body: { projectId: f.projectIn.id, title: "New in project" } });
    assert.equal(created.status, 201, created.text);
    assert.equal((await call(r.tasks.POST, "/api/tasks", { method: "POST", body: { projectId: f.projectOut.id, title: "Nope" } })).status, 403);
    // The project grant never touches the customer or company-wide things.
    assert.equal((await call(r.customer.PATCH, `/api/customers/${f.customerIn.id}`, { method: "PATCH", body: { name: "Renamed" }, params: { id: f.customerIn.id } })).status, 403);
    assert.equal((await call(r.customers.POST, "/api/customers", { method: "POST", body: { name: "New client" } })).status, 403);

    // A plain viewer is refused as before.
    actAs(f.member);
    assert.equal((await call(r.task.PATCH, `/api/tasks/${f.taskOut.id}`, { method: "PATCH", body: { priority: 1 }, params: { id: f.taskOut.id } })).status, 200, "members still edit everywhere");
    const plainViewer = await seedHuman(f.companyId, "viewer");
    actAs(plainViewer);
    assert.equal((await call(r.task.PATCH, `/api/tasks/${f.taskIn.id}`, { method: "PATCH", body: { priority: 3 }, params: { id: f.taskIn.id } })).status, 403);
});

maybe("a restricted member only sees the customers and projects they hold a membership for", async () => {
    const f = await fixture();
    const r = await routes();
    const db = await getDb();
    const { projects } = await getSchema();
    const [internal] = await db.insert(projects).values({ companyId: f.companyId, goal: "Internal", status: "active", customerId: null }).returning();
    const rita = await seedHuman(f.companyId, "member", { scope: { mode: "restricted", agentIds: [] } });
    await grant(f.companyId, rita, "project", f.projectOut.id, "viewer");
    await grant(f.companyId, rita, "project", internal.id, "editor");
    actAs(rita);
    const projectIds = ((await call(r.projects.GET, "/api/projects")).json.projects as { id: string }[]).map((p) => p.id).sort();
    assert.deepEqual(projectIds, [f.projectOut.id, internal.id].sort(), "exactly her projects");
    assert.deepEqual((await call(r.customers.GET, "/api/customers")).json.customers, [], "a project grant does not open its customer");
    // Restricted: the membership role is the whole answer. "Can view" is read-only
    // although her company role is member; "Can edit" edits.
    assert.equal((await call(r.task.PATCH, `/api/tasks/${f.taskOut.id}`, { method: "PATCH", body: { priority: 1 }, params: { id: f.taskOut.id } })).status, 403, "Can view is read-only");
    assert.equal((await call(r.tasks.POST, "/api/tasks", { method: "POST", body: { projectId: f.projectOut.id, title: "Nope" } })).status, 403);
    const created = await call(r.tasks.POST, "/api/tasks", { method: "POST", body: { projectId: internal.id, title: "Internal work" } });
    assert.equal(created.status, 201, created.text);
    const archive = await import("@/app/api/tasks/archive/route");
    const bulk = await call(archive.POST, "/api/tasks/archive", { method: "POST", body: { taskIds: [f.taskOut.id] } });
    assert.deepEqual(bulk.json.archived, [], "bulk archive skips view-only tasks");
    assert.equal((await call(r.task.PATCH, `/api/tasks/${f.taskIn.id}`, { method: "PATCH", body: { priority: 1 }, params: { id: f.taskIn.id } })).status, 404, "out of scope reads as missing");

    await grant(f.companyId, rita, "customer", f.customerIn.id, "viewer");
    const customers = ((await call(r.customers.GET, "/api/customers")).json.customers as { id: string }[]).map((c) => c.id);
    assert.deepEqual(customers, [f.customerIn.id], "a customer membership applies on the next request");
});

maybe("a resource admin manages that client's access, never above their role nor company roles", async () => {
    const f = await fixture();
    const r = await routes();
    const db = await getDb();
    const { auditLog, resourceMemberships } = await getSchema();
    const { and, eq } = await import("drizzle-orm");
    const rena = await seedHuman(f.companyId, "viewer"); // company viewer, Admin on Customer In
    await grant(f.companyId, rena, "customer", f.customerIn.id, "admin");
    const ed = await seedHuman(f.companyId, "viewer"); // company viewer, Can edit on Customer In
    await grant(f.companyId, ed, "customer", f.customerIn.id, "editor");
    const params = { id: f.customerIn.id };

    actAs(rena);
    // Admin inside Customer In: edits and deletes there.
    assert.equal((await call(r.customer.PATCH, `/api/customers/${f.customerIn.id}`, { method: "PATCH", body: { name: "Harbor Dental" }, params })).status, 200);
    assert.equal((await call(r.task.DELETE, `/api/tasks/${f.taskIn.id}`, { method: "DELETE", params: { id: f.taskIn.id } })).status, 200);
    const list = await call(r.customerAccess.GET, `/api/customers/${f.customerIn.id}/access`, { params });
    assert.equal(list.status, 200, list.text);
    assert.equal(list.json.canManage, true);
    const added = await call(r.customerAccess.POST, `/api/customers/${f.customerIn.id}/access`, { method: "POST", body: { userId: f.viewer.userId, role: "editor" }, params });
    assert.equal(added.status, 201, added.text);
    assert.equal((await call(r.customerAccess.PATCH, `/api/customers/${f.customerIn.id}/access`, { method: "PATCH", body: { userId: f.viewer.userId, role: "viewer" }, params })).status, 200);
    assert.equal((await call(r.customerAccess.POST, `/api/customers/${f.customerIn.id}/access`, { method: "POST", body: { userId: f.viewer.userId, role: "owner" }, params })).status, 400, "no role above admin exists");
    assert.equal((await call(r.customerAccess.DELETE, `/api/customers/${f.customerIn.id}/access`, { method: "DELETE", body: { userId: f.viewer.userId }, params })).status, 200);
    // ...a project under it too (the customer's role reaches its projects).
    assert.equal((await call(r.projectAccess.POST, `/api/projects/${f.projectIn.id}/access`, { method: "POST", body: { userId: f.member.userId, role: "admin" }, params: { projectId: f.projectIn.id } })).status, 201);
    // Not another client, and never company roles or member scopes.
    assert.equal((await call(r.customerAccess.POST, `/api/customers/${f.customerOut.id}/access`, { method: "POST", body: { userId: f.viewer.userId, role: "viewer" }, params: { id: f.customerOut.id } })).status, 403);
    assert.equal((await call(r.memberRole.PUT, `/api/instance/members/${f.viewer.userId}`, { method: "PUT", body: { role: "admin" }, params: { userId: f.viewer.userId } })).status, 403);
    assert.equal((await call(r.memberScope.PUT, `/api/instance/members/${f.viewer.userId}/scope`, { method: "PUT", body: { scope: { mode: "all" } }, params: { userId: f.viewer.userId } })).status, 403);

    // An editor of the client cannot change its access, nor raise themselves.
    actAs(ed);
    assert.equal((await call(r.customerAccess.POST, `/api/customers/${f.customerIn.id}/access`, { method: "POST", body: { userId: ed.userId, role: "admin" }, params })).status, 403);
    assert.equal((await call(r.customerAccess.PATCH, `/api/customers/${f.customerIn.id}/access`, { method: "PATCH", body: { userId: rena.userId, role: "viewer" }, params })).status, 403);
    const [edRow] = await db.select().from(resourceMemberships).where(and(eq(resourceMemberships.userId, ed.userId), eq(resourceMemberships.resourceId, f.customerIn.id)));
    assert.equal(edRow.role, "editor", "unchanged");

    const audit = await db.select().from(auditLog).where(eq(auditLog.companyId, f.companyId));
    const actions = audit.filter((a) => a.action.startsWith("member.access_")).map((a) => a.action).sort();
    assert.deepEqual(actions, ["member.access_changed", "member.access_granted", "member.access_granted", "member.access_removed"]);
});

maybe("invite to a client: the person joins seeing only that client, with the chosen role", async () => {
    const f = await fixture();
    const r = await routes();
    const db = await getDb();
    const { users, sessions, companyMembers } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const { consumeInvite } = await import("@/lib/invitations");
    const { loadMemberScope } = await import("@/lib/member-scope");

    actAs(f.admin);
    const invited = await call(r.customerAccess.POST, `/api/customers/${f.customerIn.id}/access`, { method: "POST", body: { email: "guest@harbor.example", role: "editor" }, params: { id: f.customerIn.id } });
    assert.equal(invited.status, 201, invited.text);
    const url = new URL((invited.json.invited as { inviteUrl: string }).inviteUrl);
    const token = url.searchParams.get("invite")!;

    const [guest] = await db.insert(users).values({ email: "guest@harbor.example", passwordHash: "x" }).returning();
    await consumeInvite(token, guest.id);
    const [membership] = await db.select().from(companyMembers).where(eq(companyMembers.userId, guest.id));
    assert.equal(membership.role, "viewer", "joins at the lowest company role");
    const scope = await loadMemberScope(guest.id, f.companyId);
    assert.deepEqual(scope, { mode: "restricted", agentIds: [], customerIds: [f.customerIn.id], projectIds: [] });

    const [session] = await db.insert(sessions).values({ userId: guest.id, expiresAt: new Date(Date.now() + 86_400_000) }).returning();
    actAs({ userId: guest.id, sessionId: session.id });
    assert.deepEqual(((await call(r.customers.GET, "/api/customers")).json.customers as { id: string }[]).map((c) => c.id), [f.customerIn.id]);
    assert.deepEqual(((await call(r.projects.GET, "/api/projects")).json.projects as { id: string }[]).map((p) => p.id), [f.projectIn.id]);
    assert.equal((await call(r.task.PATCH, `/api/tasks/${f.taskIn.id}`, { method: "PATCH", body: { priority: 2 }, params: { id: f.taskIn.id } })).status, 200, "Can edit inside Harbor Dental");
    assert.equal((await call(r.task.PATCH, `/api/tasks/${f.taskOut.id}`, { method: "PATCH", body: { priority: 2 }, params: { id: f.taskOut.id } })).status, 404);
    assert.deepEqual((await call(r.agents.GET, "/api/agents")).json.agents, [], "no agents until someone shares them");
});

// ─── Agents: who can use it ─────────────────────────────────────────────────

maybe("an agent only its owner can use: hidden from members, metadata for admins, admins never let themselves in", async () => {
    const f = await fixture();
    const r = await routes();
    const db = await getDb();
    const { notifications } = await getSchema();
    const { and, eq } = await import("drizzle-orm");
    const ana = await seedHuman(f.companyId, "member");
    const secret = await seedAgent(f.companyId, { name: "Secret", ownerUserId: ana.userId, access: "owner" });
    const open = await seedAgent(f.companyId, { name: "Open" });
    const params = { id: secret.id };

    actAs(f.member);
    assert.deepEqual(((await call(r.agents.GET, "/api/agents")).json.agents as { id: string }[]).map((a) => a.id), [open.id]);
    assert.equal((await call(r.agent.GET, `/api/agents/${secret.id}`, { params })).status, 404);
    assert.equal((await call(r.chat.GET, `/api/chat?targetAgentId=${secret.id}`)).status, 404, "no DM");
    assert.equal((await call(r.chat.POST, "/api/chat", { method: "POST", body: { text: "hi", targetAgentId: secret.id } })).status, 404);
    assert.equal((await call(r.chat.POST, "/api/chat", { method: "POST", body: { text: "@Secret please look" } })).status, 403, "no mention in the team chat");
    assert.equal((await call(r.tasks.POST, "/api/tasks", { method: "POST", body: { projectId: f.projectIn.id, title: "x", assignedAgentId: secret.id } })).status, 404, "no assignment");

    actAs(ana);
    const chat = await call(r.chat.GET, `/api/chat?targetAgentId=${secret.id}`);
    assert.equal(chat.status, 200, chat.text);
    await call(r.chat.POST, "/api/chat", { method: "POST", body: { text: "private plan", targetAgentId: secret.id } });

    actAs(f.admin);
    const listed = (await call(r.agents.GET, "/api/agents")).json.agents as { id: string; use: string; ownerName: string | null }[];
    assert.equal(listed.find((a) => a.id === secret.id)?.use, "metadata", "a locked card for admins");
    const meta = await call(r.agent.GET, `/api/agents/${secret.id}`, { params });
    assert.equal(meta.status, 200);
    assert.equal(meta.json.access, "metadata");
    assert.equal(meta.json.threads, undefined, "never its threads");
    assert.equal(JSON.stringify(meta.json).includes("private plan"), false, "never its messages");
    assert.equal((await call(r.chat.GET, `/api/chat?targetAgentId=${secret.id}`)).status, 403, "no DM for admins either");
    assert.equal((await call(r.agent.PATCH, `/api/agents/${secret.id}`, { method: "PATCH", body: { monthlyBudgetCents: 100 }, params })).status, 403);
    for (const body of [{ access: "people", userIds: [f.admin.userId] }, { ownerUserId: f.admin.userId }, { access: "everyone" }]) {
        const res = await call(r.agentAccess.PUT, `/api/agents/${secret.id}/access`, { method: "PUT", body, params });
        assert.equal(res.status, 403, `admin cannot let themselves in: ${JSON.stringify(body)}`);
    }
    // ...but may hand it over (both owners hear about it) or share it with others.
    const moved = await call(r.agentAccess.PUT, `/api/agents/${secret.id}/access`, { method: "PUT", body: { ownerUserId: f.member.userId }, params });
    assert.equal(moved.status, 200, moved.text);
    const told = await db.select().from(notifications).where(and(eq(notifications.companyId, f.companyId), eq(notifications.kind, "agent_transferred")));
    assert.deepEqual(told.map((n) => n.userId).sort(), [ana.userId, f.member.userId].sort());

    actAs(f.member);
    assert.equal((await call(r.agent.GET, `/api/agents/${secret.id}`, { params })).status, 200, "the new owner uses it");
    actAs(ana);
    assert.equal((await call(r.chat.GET, `/api/chat?targetAgentId=${secret.id}`)).status, 404, "the old owner no longer does");

    // 'people': the owner adds someone; the member scope still caps it.
    actAs(f.member);
    const shared = await call(r.agentAccess.PUT, `/api/agents/${secret.id}/access`, { method: "PUT", body: { access: "people", userIds: [ana.userId] }, params });
    assert.equal(shared.status, 200, shared.text);
    actAs(ana);
    assert.equal((await call(r.chat.GET, `/api/chat?targetAgentId=${secret.id}`)).status, 200);
    const scoped = await seedHuman(f.companyId, "member", { scope: { mode: "restricted", agentIds: [], customerIds: [f.customerIn.id] } });
    actAs(f.member);
    assert.equal((await call(r.agentAccess.PUT, `/api/agents/${secret.id}/access`, { method: "PUT", body: { access: "people", userIds: [scoped.userId] }, params })).status, 400, "only people who can see the agent");
});

maybe("an owner-only agent never sees more data than its owner; fleet tokens keep working", async () => {
    const f = await fixture();
    const r = await routes();
    const db = await getDb();
    const { resourceMemberships, companyMembers } = await getSchema();
    const { and, eq } = await import("drizzle-orm");
    const { loadAgentScopeContext } = await import("@/lib/agent-scope");
    const rita = await seedHuman(f.companyId, "member", { scope: { mode: "restricted", agentIds: [], customerIds: [f.customerIn.id] } });
    const capped = await seedAgent(f.companyId, { name: "Capped", ownerUserId: rita.userId, access: "owner" });
    const free = await seedAgent(f.companyId, { name: "Free", ownerUserId: f.member.userId, access: "owner" });

    const projectsOf = async (agentId: string) => {
        const ctx = await loadAgentScopeContext(f.companyId, agentId);
        return ctx.allowedProjectIds ? [...ctx.allowedProjectIds].sort() : null;
    };
    assert.deepEqual(await projectsOf(capped.id), [f.projectIn.id], "unrestricted agent capped to its owner's scope");
    assert.equal(await projectsOf(free.id), null, "an unrestricted owner adds no ceiling");

    // A company-wide fleet token naming the agent (how production bridges call) still works, within the ceiling.
    const fleet = bearer(await seedMcpToken(f.companyId, null));
    const asCapped = await call(r.mcpTasks.GET, `/api/mcp/tasks?agentId=${capped.id}`, { headers: fleet });
    assert.equal(asCapped.status, 200, asCapped.text);
    assert.deepEqual((asCapped.json.tasks as { id: string }[]).map((t) => t.id), [f.taskIn.id]);
    const asFree = await call(r.mcpTasks.GET, `/api/mcp/tasks?agentId=${free.id}`, { headers: fleet });
    assert.equal((asFree.json.tasks as unknown[]).length, 2);
    const bound = bearer(await seedMcpToken(f.companyId, capped.id));
    assert.deepEqual(((await call(r.mcpTasks.GET, "/api/mcp/tasks", { headers: bound })).json.tasks as { id: string }[]).map((t) => t.id), [f.taskIn.id]);

    // The owner's scope changes apply on the next request.
    await db.update(resourceMemberships).set({ resourceId: f.customerOut.id })
        .where(and(eq(resourceMemberships.companyId, f.companyId), eq(resourceMemberships.userId, rita.userId)));
    assert.deepEqual(await projectsOf(capped.id), [f.projectOut.id]);
    // An agent restricted further keeps the intersection.
    await db.update((await getSchema()).agents).set({ scopeJson: { mode: "restricted", customerIds: [f.customerIn.id], projectIds: [] } }).where(eq((await getSchema()).agents.id, capped.id));
    assert.deepEqual(await projectsOf(capped.id), [], "agent scope ∩ owner scope");
    // The owner leaves: fail closed.
    await db.delete(companyMembers).where(eq(companyMembers.userId, rita.userId));
    assert.deepEqual(await projectsOf(capped.id), []);
});

// ─── Review fixes ───────────────────────────────────────────────────────────

maybe("agent refs are resolved before the access check: names, uppercase ids and padding never fall through", async () => {
    const f = await fixture();
    const r = await routes();
    const ana = await seedHuman(f.companyId, "member");
    const secret = await seedAgent(f.companyId, { name: "Secret", ownerUserId: ana.userId, access: "owner" });
    const groups = await import("@/app/api/groups/route");
    const setupLocal = await import("@/app/api/agents/[id]/setup-local/route");
    const policies = await import("@/app/api/agents/[id]/action-policies/route");

    actAs(f.member);
    for (const ref of ["Secret", secret.id.toUpperCase(), `  ${secret.id}  `, randomUUID()]) {
        const task = await call(r.tasks.POST, "/api/tasks", { method: "POST", body: { projectId: f.projectIn.id, title: "x", assignedAgentId: ref } });
        assert.equal(task.status, 404, `assign by ${JSON.stringify(ref)}`);
        const assignee = await call(r.task.PATCH, `/api/tasks/${f.taskIn.id}`, { method: "PATCH", body: { assignee: { type: "agent", id: ref } }, params: { id: f.taskIn.id } });
        assert.equal(assignee.status, 404, `reassign to ${JSON.stringify(ref)}`);
    }
    assert.equal((await call(r.projects.POST, "/api/projects", { method: "POST", body: { goal: "Lead test", leadAgentId: secret.id.toUpperCase() } })).status, 404);
    assert.equal((await call(groups.POST, "/api/groups", { method: "POST", body: { title: "Sneaky", agentIds: ["Secret"] } })).status, 404);
    assert.equal((await call(policies.GET, `/api/agents/${secret.id}/action-policies`, { params: { id: secret.id } })).status, 404);

    // An admin who sees it as metadata reads its safety settings but never gets a token that acts as it.
    actAs(f.admin);
    assert.equal((await call(policies.GET, `/api/agents/${secret.id}/action-policies`, { params: { id: secret.id } })).status, 200);
    assert.equal((await call(setupLocal.POST, `/api/agents/${secret.id}/setup-local`, { method: "POST", params: { id: secret.id } })).status, 404);

    actAs(ana);
    assert.equal((await call(r.tasks.POST, "/api/tasks", { method: "POST", body: { projectId: f.projectIn.id, title: "mine", assignedAgentId: "Secret" } })).status, 201, "its owner may, by name");
});

maybe("removing a member drops their grants; a re-invite starts from nothing", async () => {
    const f = await fixture();
    const r = await routes();
    const db = await getDb();
    const { resourceMemberships, agentAccess, users } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const { consumeInvite } = await import("@/lib/invitations");
    const memberRoute = await import("@/app/api/instance/members/[userId]/route");
    const gus = await seedHuman(f.companyId, "viewer");
    await grant(f.companyId, gus, "customer", f.customerIn.id, "admin");
    const agent = await seedAgent(f.companyId, { name: "Team", ownerUserId: f.member.userId, access: "people" });
    await db.insert(agentAccess).values({ agentId: agent.id, userId: gus.userId, companyId: f.companyId });

    actAs(f.admin);
    const removed = await call(memberRoute.DELETE, `/api/instance/members/${gus.userId}`, { method: "DELETE", params: { userId: gus.userId } });
    assert.equal(removed.status, 200, removed.text);
    assert.deepEqual(await db.select().from(resourceMemberships).where(eq(resourceMemberships.userId, gus.userId)), []);
    assert.deepEqual(await db.select().from(agentAccess).where(eq(agentAccess.userId, gus.userId)), []);

    const [user] = await db.select().from(users).where(eq(users.id, gus.userId));
    const invited = await call(r.customerAccess.POST, `/api/customers/${f.customerOut.id}/access`, { method: "POST", body: { email: user.email, role: "viewer" }, params: { id: f.customerOut.id } });
    assert.equal(invited.status, 201, invited.text);
    await consumeInvite(new URL((invited.json.invited as { inviteUrl: string }).inviteUrl).searchParams.get("invite")!, gus.userId);
    const rows = await db.select({ resourceId: resourceMemberships.resourceId, role: resourceMemberships.role }).from(resourceMemberships).where(eq(resourceMemberships.userId, gus.userId));
    assert.deepEqual(rows, [{ resourceId: f.customerOut.id, role: "viewer" }], "only the new grant, never the old admin role");
    assert.deepEqual(await db.select().from(agentAccess).where(eq(agentAccess.userId, gus.userId)), []);
});

maybe("an orphaned limited agent: an admin recovers it without its owner's history", async () => {
    const f = await fixture();
    const r = await routes();
    const db = await getDb();
    const { messageThreads, threadMessages } = await getSchema();
    const memberRoute = await import("@/app/api/instance/members/[userId]/route");
    const ana = await seedHuman(f.companyId, "member");
    const secret = await seedAgent(f.companyId, { name: "Secret", ownerUserId: ana.userId, access: "owner" });
    actAs(ana);
    assert.equal((await call(r.chat.POST, "/api/chat", { method: "POST", body: { text: "private plan", targetAgentId: secret.id } })).status, 200);
    // A shared (company-mode) DM thread with history too.
    const [shared] = await db.insert(messageThreads).values({ companyId: f.companyId, type: "direct", title: "Secret", directAgentId: secret.id }).returning();
    await db.insert(threadMessages).values({ companyId: f.companyId, threadId: shared.id, senderType: "human", senderId: ana.userId, text: "old shared note" });

    actAs(f.admin);
    const params = { id: secret.id };
    assert.equal((await call(r.agentAccess.PUT, `/api/agents/${secret.id}/access`, { method: "PUT", body: { access: "everyone" }, params })).status, 403, "not while its owner is here");
    assert.equal((await call(memberRoute.DELETE, `/api/instance/members/${ana.userId}`, { method: "DELETE", params: { userId: ana.userId } })).status, 200);
    const recovered = await call(r.agentAccess.PUT, `/api/agents/${secret.id}/access`, { method: "PUT", body: { access: "owner", ownerUserId: f.admin.userId }, params });
    assert.equal(recovered.status, 200, recovered.text);
    const chat = await call(r.chat.GET, `/api/chat?targetAgentId=${secret.id}`);
    assert.equal(chat.status, 200, chat.text);
    assert.equal(chat.text.includes("private plan"), false, "the old owner's private chat stays hidden");
    assert.equal(chat.text.includes("old shared note"), false, "the old shared conversation is archived");
    actAs(f.member);
    assert.equal((await call(r.chat.GET, `/api/chat?targetAgentId=${secret.id}`)).status, 404, "still limited to its new owner");
});

maybe("Access lists show emails only to those who manage them; moving a project out needs admin there", async () => {
    const f = await fixture();
    const r = await routes();
    const project = await import("@/app/api/projects/[projectId]/route");
    const people = await import("@/app/api/agents/access-people/route");
    const val = await seedHuman(f.companyId, "viewer");
    await grant(f.companyId, val, "customer", f.customerIn.id, "viewer");
    const params = { id: f.customerIn.id };

    actAs(val);
    const seen = await call(r.customerAccess.GET, `/api/customers/${f.customerIn.id}/access`, { params });
    assert.equal(seen.status, 200);
    assert.equal(seen.json.canManage, false);
    assert.deepEqual((seen.json.people as { email: string | null }[]).map((p) => p.email), [null]);
    assert.deepEqual(seen.json.candidates, []);
    actAs(f.admin);
    const managed = await call(r.customerAccess.GET, `/api/customers/${f.customerIn.id}/access`, { params });
    assert.equal(typeof (managed.json.people as { email: string | null }[])[0].email, "string");

    // A restricted member picks only among people who share their clients/projects.
    const rita = await seedHuman(f.companyId, "member", { scope: { mode: "restricted", agentIds: [] } });
    await grant(f.companyId, rita, "customer", f.customerIn.id, "editor");
    actAs(rita);
    const names = ((await call(people.GET, "/api/agents/access-people")).json.people as { id: string }[]).map((p) => p.id).sort();
    assert.deepEqual(names, [rita.userId, val.userId].sort());

    // Moving a project to another client: a plain member may while nobody has Access there...
    actAs(f.member);
    const pParams = { projectId: f.projectOut.id };
    assert.equal((await call(project.PATCH, `/api/projects/${f.projectOut.id}`, { method: "PATCH", body: { customerId: f.customerIn.id }, params: pParams })).status, 200);
    // ...but not out of a client whose people would lose it: admin there only.
    assert.equal((await call(project.PATCH, `/api/projects/${f.projectOut.id}`, { method: "PATCH", body: { customerId: f.customerOut.id }, params: pParams })).status, 403);
    actAs(f.admin);
    assert.equal((await call(project.PATCH, `/api/projects/${f.projectOut.id}`, { method: "PATCH", body: { customerId: f.customerOut.id }, params: pParams })).status, 200);
});

maybe("the Projects board shows a restricted member only their projects and what hangs off them", async () => {
    const f = await fixture();
    const { loadProjectsBoard } = await import("@/lib/projects-board-reads");
    const { requireRole } = await import("@/lib/roles");
    const rita = await seedHuman(f.companyId, "member", { scope: { mode: "restricted", agentIds: [] } });
    await grant(f.companyId, rita, "project", f.projectOut.id, "viewer");

    actAs(rita);
    const mine = await loadProjectsBoard(await requireRole("viewer")());
    assert.deepEqual(mine.projects.map((p) => p.id), [f.projectOut.id]);
    assert.deepEqual(mine.tasks.map((t) => t.id), [f.taskOut.id]);
    assert.deepEqual(mine.customers.map((c) => c.id), [f.customerOut.id], "only the client of her project, for its name");
    assert.equal(mine.canEditAll, false);
    assert.deepEqual(mine.editableProjectIds, [], "Can view: read-only board");

    actAs(f.member);
    const all = await loadProjectsBoard(await requireRole("viewer")());
    assert.equal(all.projects.length, 2);
    assert.equal(all.tasks.length, 2);
    assert.equal(all.canEditAll, true);
});

maybe("the members scope editor keeps memberships and scope in step", async () => {
    const f = await fixture();
    const r = await routes();
    const db = await getDb();
    const { resourceMemberships } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const rita = await seedHuman(f.companyId, "member", { scope: { mode: "restricted", agentIds: [], customerIds: [f.customerIn.id] } });
    const params = { userId: rita.userId };
    actAs(f.admin);
    const put = (scope: Record<string, unknown>) => call(r.memberScope.PUT, `/api/instance/members/${rita.userId}/scope`, { method: "PUT", body: { scope }, params });
    assert.equal((await put({ mode: "restricted", agentIds: [], customerIds: [f.customerIn.id, f.customerOut.id] })).status, 200);
    const of = async () => (await db.select().from(resourceMemberships).where(eq(resourceMemberships.userId, rita.userId))).map((m) => m.resourceId).sort();
    assert.deepEqual(await of(), [f.customerIn.id, f.customerOut.id].sort());
    assert.equal((await put({ mode: "all" })).status, 200);
    assert.deepEqual(await of(), [f.customerIn.id, f.customerOut.id].sort(), "all access leaves memberships alone");
    assert.equal((await put({ mode: "restricted", agentIds: [] })).status, 200);
    assert.deepEqual(await of(), [], "restricted with customerIds omitted: no customers, as in 0.19");
    const got = await call(r.memberScope.GET, `/api/instance/members/${rita.userId}/scope`, { params });
    assert.deepEqual(got.json.scope, { mode: "restricted", agentIds: [], customerIds: [] });
});

// ─── Second review ──────────────────────────────────────────────────────────

maybe("Can view never writes folders, pipelines, approvals or proposal merges", async () => {
    const f = await fixture();
    const db = await getDb();
    const { pipelines, resourceProposals } = await getSchema();
    const folders = await import("@/app/api/ui/folders/route");
    const pipelineRoute = await import("@/app/api/pipelines/[id]/route");
    const approvals = await import("@/app/api/approvals/route");
    const proposalRoute = await import("@/app/api/resources/proposals/[id]/route");
    const [pipeline] = await db.insert(pipelines).values({ companyId: f.companyId, name: "Weekly", projectId: f.projectIn.id }).returning();
    const [proposal] = await db.insert(resourceProposals).values({ companyId: f.companyId, scopeType: "project", scopeId: f.projectIn.id, title: "Tone", proposedText: "Be brief" }).returning();
    const rita = await seedHuman(f.companyId, "member", { scope: { mode: "restricted", agentIds: [] } });
    await grant(f.companyId, rita, "project", f.projectIn.id, "viewer");

    actAs(rita);
    assert.equal((await call(folders.POST, "/api/ui/folders", { method: "POST", body: { name: "Briefs", projectId: f.projectIn.id } })).status, 403, "folder");
    assert.equal((await call(pipelineRoute.PATCH, `/api/pipelines/${pipeline.id}`, { method: "PATCH", body: { status: "paused" }, params: { id: pipeline.id } })).status, 403, "pipeline");
    assert.equal((await call(pipelineRoute.DELETE, `/api/pipelines/${pipeline.id}`, { method: "DELETE", params: { id: pipeline.id } })).status, 403, "pipeline delete");
    assert.equal((await call(approvals.POST, "/api/approvals", { method: "POST", body: { projectId: f.projectIn.id, taskIds: [f.taskIn.id] } })).status, 403, "approval request");
    assert.equal((await call(proposalRoute.PATCH, `/api/resources/proposals/${proposal.id}`, { method: "PATCH", body: { status: "merged" }, params: { id: proposal.id } })).status, 403, "proposal merge");

    // "Can edit" there: allowed (a company viewer elevated, too).
    const ed = await seedHuman(f.companyId, "viewer");
    await grant(f.companyId, ed, "project", f.projectIn.id, "editor");
    actAs(ed);
    assert.equal((await call(folders.POST, "/api/ui/folders", { method: "POST", body: { name: "Briefs", projectId: f.projectIn.id } })).status, 201);
    assert.equal((await call(pipelineRoute.PATCH, `/api/pipelines/${pipeline.id}`, { method: "PATCH", body: { status: "paused" }, params: { id: pipeline.id } })).status, 200);
    assert.equal((await call(folders.POST, "/api/ui/folders", { method: "POST", body: { name: "Company wide" } })).status, 403, "company-level records keep the company role");
});

maybe("member removal clears ownership; orphan recovery archives only shared threads", async () => {
    const f = await fixture();
    const r = await routes();
    const db = await getDb();
    const { agents, messageThreads, users } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const memberRoute = await import("@/app/api/instance/members/[userId]/route");
    const ana = await seedHuman(f.companyId, "member");
    const bob = await seedHuman(f.companyId, "member");
    const team = await seedAgent(f.companyId, { name: "Team", ownerUserId: ana.userId, access: "people" });
    actAs(ana);
    assert.equal((await call(r.agentAccess.PUT, `/api/agents/${team.id}/access`, { method: "PUT", body: { access: "people", userIds: [bob.userId] }, params: { id: team.id } })).status, 200);
    actAs(bob);
    assert.equal((await call(r.chat.POST, "/api/chat", { method: "POST", body: { text: "bob's own plan", targetAgentId: team.id } })).status, 200);
    const [bobThread] = await db.select().from(messageThreads).where(eq(messageThreads.ownerUserId, bob.userId));
    assert.ok(bobThread, "bob has a private chat with it");

    actAs(f.admin);
    assert.equal((await call(memberRoute.DELETE, `/api/instance/members/${ana.userId}`, { method: "DELETE", params: { userId: ana.userId } })).status, 200);
    const [after] = await db.select({ ownerUserId: agents.ownerUserId }).from(agents).where(eq(agents.id, team.id));
    assert.equal(after.ownerUserId, null, "the removed owner no longer owns it");
    assert.equal((await call(r.agentAccess.PUT, `/api/agents/${team.id}/access`, { method: "PUT", body: { access: "people", ownerUserId: f.admin.userId, userIds: [bob.userId] }, params: { id: team.id } })).status, 200);
    const [bobStill] = await db.select().from(messageThreads).where(eq(messageThreads.id, bobThread.id));
    assert.equal(bobStill.archivedAt, null, "another person's private chat is never archived");

    // An instance admin with no company membership may own an agent: not an orphan.
    const [ghost] = await db.insert(users).values({ email: `ia-${randomUUID()}@example.com`, passwordHash: "x", instanceRole: "instance_admin" }).returning();
    const owned = await seedAgent(f.companyId, { name: "Owned", ownerUserId: ghost.id, access: "owner" });
    assert.equal((await call(r.agentAccess.PUT, `/api/agents/${owned.id}/access`, { method: "PUT", body: { access: "everyone" }, params: { id: owned.id } })).status, 403);
});

maybe("delivery, reasoning and status of an agent limited to others are closed; metadata admins only tighten", async () => {
    const f = await fixture();
    const db = await getDb();
    const { messageThreads, threadMessages } = await getSchema();
    const delivery = await import("@/app/api/messages/[id]/delivery/route");
    const reasoning = await import("@/app/api/chat/reasoning/route");
    const status = await import("@/app/api/chat/status/route");
    const policies = await import("@/app/api/agents/[id]/action-policies/route");
    const ana = await seedHuman(f.companyId, "member");
    const secret = await seedAgent(f.companyId, { name: "Secret", ownerUserId: ana.userId, access: "owner" });
    const [thread] = await db.insert(messageThreads).values({ companyId: f.companyId, type: "direct", title: "Secret", directAgentId: secret.id }).returning();
    const [message] = await db.insert(threadMessages).values({ companyId: f.companyId, threadId: thread.id, senderType: "agent", senderId: secret.id, text: "thinking out loud" }).returning();

    actAs(f.member);
    assert.equal((await call(delivery.GET, `/api/messages/${message.id}/delivery`, { params: { id: message.id } })).status, 404);
    const why = await call(reasoning.GET, `/api/chat/reasoning?messageId=${message.id}`);
    assert.equal(why.json.reasoning, null);
    assert.equal((await call(status.POST, "/api/chat/status", { method: "POST", body: { threadId: thread.id, markRead: true } })).status, 403);
    actAs(ana);
    assert.equal((await call(delivery.GET, `/api/messages/${message.id}/delivery`, { params: { id: message.id } })).status, 200);
    assert.equal((await call(status.POST, "/api/chat/status", { method: "POST", body: { threadId: thread.id, markRead: true } })).status, 200);

    actAs(f.admin);
    const put = (policy: unknown) => call(policies.PUT, `/api/agents/${secret.id}/action-policies`, { method: "PUT", body: { policies: { send_email: policy } }, params: { id: secret.id } });
    assert.equal((await put("off")).status, 200, "tighten");
    assert.equal((await put("ask")).status, 200, "tighten");
    assert.equal((await put("allowed")).status, 403, "never loosen");
    assert.equal((await put(null)).status, 403, "nor back to a looser default");
    actAs(ana);
    assert.equal((await put("allowed")).status, 403, "its owner is not a company admin");
});

maybe("a group message never wakes an agent the sender may not use", async () => {
    const f = await fixture();
    const r = await routes();
    const db = await getDb();
    const { messageThreads, threadParticipants, threadMessages } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const { decideDelivery } = await import("@/lib/message-routing");
    const { isVerifiedReplyBy } = await import("@/lib/thread-access");
    const ana = await seedHuman(f.companyId, "member");
    const secret = await seedAgent(f.companyId, { name: "Secret", ownerUserId: ana.userId, access: "owner" });
    const open = await seedAgent(f.companyId, { name: "Open" });
    const [group] = await db.insert(messageThreads).values({ companyId: f.companyId, type: "group", title: "Ops" }).returning();
    await db.insert(threadParticipants).values([
        { threadId: group.id, companyId: f.companyId, participantType: "agent", participantId: secret.id },
        { threadId: group.id, companyId: f.companyId, participantType: "agent", participantId: open.id },
        { threadId: group.id, companyId: f.companyId, participantType: "human", participantRef: f.member.userId },
        { threadId: group.id, companyId: f.companyId, participantType: "human", participantRef: ana.userId },
    ]);
    const roster = [{ id: secret.id, name: "Secret" }, { id: open.id, name: "Open" }];
    const verdict = (message: typeof threadMessages.$inferSelect, agentId: string) => decideDelivery({
        agentId, message: { ...message, metadataJson: message.metadataJson }, threadType: "group", roster, agentStreak: 0,
    });

    actAs(f.member);
    const sent = await call(r.chat.POST, "/api/chat", { method: "POST", body: { text: "@all status please", threadId: group.id } });
    assert.equal(sent.status, 200, sent.text);
    const [stored] = await db.select().from(threadMessages).where(eq(threadMessages.id, (sent.json.message as { id: string }).id));
    assert.equal(verdict(stored, secret.id).addressedToYou, false, "the limited agent is not woken");
    assert.equal(verdict(stored, secret.id).routeReason, "out_of_scope");
    assert.equal(verdict(stored, open.id).addressedToYou, true, "everyone else is");
    assert.equal(await isVerifiedReplyBy(f.companyId, secret.id, group.id, stored.id), false, "nor may it reply as if addressed");

    actAs(ana);
    const own = await call(r.chat.POST, "/api/chat", { method: "POST", body: { text: "@Secret your turn", threadId: group.id } });
    assert.equal(own.status, 200, own.text);
    const [mine] = await db.select().from(threadMessages).where(eq(threadMessages.id, (own.json.message as { id: string }).id));
    assert.equal(verdict(mine, secret.id).addressedToYou, true, "its owner still wakes it");
});

maybe("an agent name used twice resolves to nobody", async () => {
    const f = await fixture();
    const r = await routes();
    await seedAgent(f.companyId, { name: "Twin" });
    await seedAgent(f.companyId, { name: "Twin" });
    actAs(f.member);
    assert.equal((await call(r.tasks.POST, "/api/tasks", { method: "POST", body: { projectId: f.projectIn.id, title: "x", assignedAgentId: "Twin" } })).status, 404);
    const { resolveAgentId } = await import("@/lib/mcp");
    await assert.rejects(resolveAgentId(f.companyId, "Twin"), /more than one agent/);
});

// ─── Final review ───────────────────────────────────────────────────────────

maybe("an inbound sender that is not a member never breaks a post, and never wakes a limited agent", async () => {
    const f = await fixture();
    const db = await getDb();
    const { messageThreads, threadMessages } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const { appendThreadMessage } = await import("@/lib/control-plane");
    const { decideDelivery, UNREACHABLE_MENTIONS_KEY } = await import("@/lib/message-routing");
    const open = await seedAgent(f.companyId, { name: "Open" });
    const [team] = await db.insert(messageThreads).values({ companyId: f.companyId, type: "team", title: "Team" }).returning();

    // No limited agent in the company: posts exactly as before, nothing recorded.
    const plain = await appendThreadMessage({ companyId: f.companyId, threadId: team.id, senderType: "human", senderId: "slack:U123", text: "@Open hi" });
    const [plainRow] = await db.select().from(threadMessages).where(eq(threadMessages.id, plain.id));
    assert.equal((plainRow.metadataJson as Record<string, unknown> | null)?.[UNREACHABLE_MENTIONS_KEY], undefined);

    const ana = await seedHuman(f.companyId, "member");
    const secret = await seedAgent(f.companyId, { name: "Secret", ownerUserId: ana.userId, access: "owner" });
    const roster = [{ id: secret.id, name: "Secret" }, { id: open.id, name: "Open" }];
    for (const senderId of ["slack:U123", "not a uuid at all", randomUUID()]) {
        const posted = await appendThreadMessage({ companyId: f.companyId, threadId: team.id, senderType: "human", senderId, text: "@Secret @Open hello" });
        const [row] = await db.select().from(threadMessages).where(eq(threadMessages.id, posted.id));
        assert.ok(row, `stored for sender ${senderId}`);
        const verdict = (agentId: string) => decideDelivery({ agentId, message: row, threadType: "team", roster, agentStreak: 0 }).addressedToYou;
        assert.equal(verdict(secret.id), false, `an unknown sender (${senderId}) never wakes a limited agent`);
        assert.equal(verdict(open.id), true);
    }
});

maybe("rejecting a proposal works even when its note is gone; merging still needs edit access to it", async () => {
    const f = await fixture();
    const db = await getDb();
    const { resourceProposals, scopedResources } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const proposalRoute = await import("@/app/api/resources/proposals/[id]/route");
    const { createScopedResource } = await import("@/lib/resources");
    const note = await createScopedResource({
        companyId: f.companyId, scopeType: "project", scopeId: f.projectIn.id, provider: "generic", resourceType: "note",
        name: "tone", configText: "", secretText: "", status: "active", ownership: "managed", createdByType: "user", createdById: f.member.userId,
    } as never);
    const [proposal] = await db.insert(resourceProposals).values({ companyId: f.companyId, scopeType: "project", scopeId: f.projectIn.id, targetResourceId: note.id, action: "update", title: "Tone", proposedText: "Brief" }).returning();
    await db.update(scopedResources).set({ deletedAt: new Date() }).where(eq(scopedResources.id, note.id));
    actAs(f.member);
    const params = { id: proposal.id };
    const rejected = await call(proposalRoute.PATCH, `/api/resources/proposals/${proposal.id}`, { method: "PATCH", body: { status: "rejected" }, params });
    assert.equal(rejected.status, 200, rejected.text);
    const [second] = await db.insert(resourceProposals).values({ companyId: f.companyId, scopeType: "project", scopeId: f.projectIn.id, targetResourceId: note.id, action: "update", title: "Tone 2", proposedText: "Brief" }).returning();
    assert.equal((await call(proposalRoute.PATCH, `/api/resources/proposals/${second.id}`, { method: "PATCH", body: { status: "merged" }, params: { id: second.id } })).status, 404, "merging into a missing note");
});

maybe("tasks held by an agent the viewer may not use show a stand-in, never the agent", async () => {
    const f = await fixture();
    const db = await getDb();
    const { tasks } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const { loadProjectsBoard } = await import("@/lib/projects-board-reads");
    const { requireRole } = await import("@/lib/roles");
    const ana = await seedHuman(f.companyId, "member");
    const secret = await seedAgent(f.companyId, { name: "Secret", ownerUserId: ana.userId, access: "owner" });
    await db.update(tasks).set({ assignedAgentId: secret.id }).where(eq(tasks.id, f.taskIn.id));

    actAs(f.member);
    const member = await loadProjectsBoard(await requireRole("viewer")());
    assert.equal(member.agents.some((a) => a.id === secret.id), false);
    assert.deepEqual(member.limitedAgents, [{ id: secret.id, name: null, limited: true }], "Private agent");
    actAs(f.admin);
    const admin = await loadProjectsBoard(await requireRole("viewer")());
    assert.deepEqual(admin.limitedAgents, [{ id: secret.id, name: "Secret", limited: true }], "its name, locked");
    assert.equal(JSON.stringify(admin.agents).includes("llmApiKey"), false, "never secret columns");
    actAs(ana);
    const owner = await loadProjectsBoard(await requireRole("viewer")());
    assert.deepEqual(owner.limitedAgents, []);
    assert.equal(owner.agents.some((a) => a.id === secret.id), true);
});
