/**
 * Integration-test harness. Runs route handlers IN-PROCESS against a real
 * Postgres (imported via @/db), so there is no HTTP server to boot.
 *
 * Requires POSTGRES_CONNECTION_STRING to point at a throwaway test database with
 * the migration chain applied. When it is unset, `dbAvailable` is false and
 * suites skip cleanly (so `npm test` on a machine without a DB stays green).
 *
 *   docker run -d --name ec-test-pg -e POSTGRES_USER=emperor \
 *     -e POSTGRES_PASSWORD=emperor -e POSTGRES_DB=emperor_test \
 *     -p 5433:5432 postgres:16-alpine
 *   export POSTGRES_CONNECTION_STRING=postgres://emperor:emperor@localhost:5433/emperor_test
 *   npm run db:migrate && npm run test:integration
 *
 * Tests seed their own reference rows (e.g. pricing) rather than relying on
 * migration seed data, so they're independent of how the DB was provisioned.
 */

// Deterministic env for the routes under test.
process.env.DEPLOYMENT_MODE ??= "self-hosted";
// Ensure the email-optional path is exercised unless a test opts in.
delete process.env.SMTP_HOST;
delete process.env.SMTP_USER;
delete process.env.SMTP_PASS;
delete process.env.SMTP_FROM;

export const dbAvailable = Boolean(process.env.POSTGRES_CONNECTION_STRING);

import { NextRequest } from "next/server";
import { createHash, randomUUID } from "node:crypto";

// These imports open a DB pool at load time — only pull them in when a DB exists.
type Db = typeof import("@/db")["db"];
type Schema = typeof import("@/db/schema");

let _db: Db | null = null;
let _schema: Schema | null = null;

export async function getDb() {
    if (!_db) _db = (await import("@/db")).db;
    return _db;
}
export async function getSchema() {
    if (!_schema) _schema = await import("@/db/schema");
    return _schema;
}

/** Truncate everything we touch and clear the cached instance company. */
export async function resetDb() {
    const db = await getDb();
    const { sql } = await import("drizzle-orm");
    await db.execute(sql`TRUNCATE TABLE users, companies, company_members, company_tokens, agents, token_usage_log, instance_settings, invitations, llm_pricing RESTART IDENTITY CASCADE`);
    const { clearInstanceCompanyCache } = await import("@/lib/instance");
    clearInstanceCompanyCache();
}

/** Build a NextRequest for a route handler. */
export function makeRequest(
    url: string,
    opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): NextRequest {
    const headers = new Headers(opts.headers ?? {});
    const init: RequestInit = { method: opts.method ?? "GET", headers };
    if (opts.body !== undefined) {
        if (!headers.has("content-type")) headers.set("content-type", "application/json");
        init.body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
    }
    return new NextRequest(new Request(url, init));
}

/** Seed a company (with an owner user) and an MCP token. Returns the raw token. */
export async function seedCompanyWithToken(scope: "mcp_full" | "mcp_danger" = "mcp_full") {
    const db = await getDb();
    const { users, companies, companyTokens } = await getSchema();
    const [user] = await db.insert(users).values({
        email: `owner-${randomUUID()}@example.com`,
        passwordHash: "x",
    }).returning();
    const [company] = await db.insert(companies).values({
        name: "Test Co",
        createdByUserId: user.id,
    }).returning();
    const rawToken = `ec_test_${randomUUID().replace(/-/g, "")}`;
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    await db.insert(companyTokens).values({
        companyId: company.id, tokenHash, name: "test", scope,
    });
    return { companyId: company.id, userId: user.id, rawToken };
}

/** Seed an llm_pricing row (cents per 1M tokens). `push` provisions no seed data. */
export async function seedPricing(model: string, inputCentsPer1M: number, outputCentsPer1M: number, provider = "deepseek") {
    const db = await getDb();
    const { llmPricing } = await getSchema();
    await db.insert(llmPricing).values({
        provider, model, label: model,
        inputPricePer1k: inputCentsPer1M,
        outputPricePer1k: outputCentsPer1M,
        active: true,
    }).onConflictDoNothing();
}

/** Seed an agent under a company. */
export async function seedAgent(companyId: string, overrides: Record<string, unknown> = {}) {
    const db = await getDb();
    const { agents } = await getSchema();
    const [agent] = await db.insert(agents).values({
        companyId,
        name: "Test Agent",
        llmModel: "deepseek-v4-flash",
        monthlyBudgetCents: 0,
        budgetStatus: "active",
        ...overrides,
    }).returning();
    return agent;
}
