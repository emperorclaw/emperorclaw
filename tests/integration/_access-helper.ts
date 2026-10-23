/**
 * Fixtures for the access-control suites: a company with an in-scope and an
 * out-of-scope customer/project/task, agent-bound MCP tokens, and human users
 * of every role with a real DB session. Human route handlers resolve the
 * session through next-auth's getServerSession, which only works inside a
 * Next request; `actAs` swaps it for one that returns the chosen user (the
 * rest of the chain — the sessions table check, the membership and role
 * lookup, the scope load — is the production code path).
 */
import { createHash, randomUUID } from "node:crypto";
import { getDb, getSchema, makeRequest } from "./_helper";

type SessionUser = { userId: string; sessionId: string } | null;
let currentUser: SessionUser = null;
let installed = false;

function installSessionStub() {
    if (installed) return;
    installed = true;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nextAuth = require("next-auth/next") as { getServerSession: unknown };
    nextAuth.getServerSession = async () => currentUser
        ? { user: { id: currentUser.userId, email: "x@example.com" }, sessionId: currentUser.sessionId, expires: new Date(Date.now() + 3_600_000).toISOString() }
        : null;
}

/** Make human route handlers see `user` as the signed-in person (null = signed out). */
export function actAs(user: SessionUser) {
    installSessionStub();
    currentUser = user;
}

export async function seedMcpToken(companyId: string, agentId: string | null, scope: "mcp_full" | "mcp_danger" = "mcp_full") {
    const db = await getDb();
    const { companyTokens } = await getSchema();
    const rawToken = `ec_test_${randomUUID().replace(/-/g, "")}`;
    await db.insert(companyTokens).values({
        companyId, agentId, scope, name: agentId ? "agent-bound" : "operator",
        tokenHash: createHash("sha256").update(rawToken).digest("hex"),
    });
    return rawToken;
}

export async function seedHuman(
    companyId: string,
    role: "owner" | "admin" | "member" | "viewer",
    options: { scope?: Record<string, unknown>; instanceRole?: "instance_admin" | "member" } = {},
) {
    const db = await getDb();
    const { users, companyMembers, sessions } = await getSchema();
    const [user] = await db.insert(users).values({
        email: `${role}-${randomUUID()}@example.com`,
        passwordHash: "x",
        instanceRole: options.instanceRole ?? "member",
    }).returning();
    const [membership] = await db.insert(companyMembers).values({
        companyId, userId: user.id, role, scopeJson: options.scope ?? {},
    }).returning();
    const [session] = await db.insert(sessions).values({
        userId: user.id, expiresAt: new Date(Date.now() + 86_400_000),
    }).returning();
    return { userId: user.id, membershipId: membership.id, sessionId: session.id };
}

/**
 * Two customers / projects / tasks: "in" (granted to the scoped agent and the
 * restricted member) and "out" (granted to nobody restricted).
 */
export async function seedTwoTenantsOfWork(companyId: string) {
    const db = await getDb();
    const { customers, projects, tasks } = await getSchema();
    const [customerIn] = await db.insert(customers).values({ id: randomUUID(), companyId, name: "Customer In" }).returning();
    const [customerOut] = await db.insert(customers).values({ id: randomUUID(), companyId, name: "Customer Out" }).returning();
    const [projectIn] = await db.insert(projects).values({ companyId, goal: "Project In", status: "active", customerId: customerIn.id }).returning();
    const [projectOut] = await db.insert(projects).values({ companyId, goal: "Project Out", status: "active", customerId: customerOut.id }).returning();
    const [taskIn] = await db.insert(tasks).values({ companyId, projectId: projectIn.id, taskType: "work", state: "inbox", inputJson: { title: "Task In" } }).returning();
    const [taskOut] = await db.insert(tasks).values({ companyId, projectId: projectOut.id, taskType: "work", state: "inbox", inputJson: { title: "Task Out" } }).returning();
    return { customerIn, customerOut, projectIn, projectOut, taskIn, taskOut };
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** Call a route handler; `params` becomes the dynamic-segment promise. */
export async function call(
    handler: (req: ReturnType<typeof makeRequest>, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>,
    url: string,
    opts: { method?: string; headers?: Record<string, string>; body?: unknown; params?: Record<string, string> } = {},
) {
    const res = await handler(makeRequest(`http://localhost${url}`, opts), { params: Promise.resolve(opts.params ?? {}) });
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, json: json as Record<string, unknown> & { [key: string]: unknown }, text };
}

/** Connect an in-process MCP client as the given bound agent. */
export async function mcpClientFor(companyId: string, callerAgentId: string | null) {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { buildMcpServer } = await import("@/lib/mcp-server");
    const server = await buildMcpServer(companyId, callerAgentId, null);
    const client = new Client({ name: "acl-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return {
        async tool(name: string, args: Record<string, unknown>) {
            const result = await client.callTool({ name, arguments: args });
            const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
            return { isError: Boolean(result.isError), text };
        },
    };
}
