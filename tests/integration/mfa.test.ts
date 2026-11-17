import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { randomUUID } from "node:crypto";
import { dbAvailable, getDb, getSchema, makeRequest, resetDb } from "./_helper";
import { eq } from "drizzle-orm";
import { totpAt } from "../../src/lib/totp";

process.env.EMPEROR_CLAW_MASTER_KEY = "test-only-mfa-key";
let activeSession: unknown = null;
function stubSession() {
    const path = require.resolve("next-auth/next");
    const cached = new Module(path);
    cached.filename = path; cached.loaded = true;
    cached.exports = { getServerSession: async () => activeSession };
    require.cache[path] = cached;
}

describe("optional MFA", { skip: !dbAvailable }, () => {
    let userId: string, email: string, sessionId: string;
    const password = "mfa-test-password";
    const call = async (body: unknown, origin = "http://localhost") => {
        const { POST } = await import("@/app/api/user/mfa/route");
        return POST(makeRequest("http://localhost/api/user/mfa", { method: "POST", headers: { origin, host: "localhost" }, body }));
    };
    const authorize = async (code = "", suppliedPassword = password) => {
        const { authOptions } = await import("@/lib/auth");
        const provider = authOptions.providers[0] as any;
        return provider.options.authorize({ email, password: suppliedPassword, code });
    };
    before(async () => { stubSession(); });
    const seed = async () => {
        await resetDb();
        const db = await getDb();
        const schema = await getSchema();
        const { hash } = await import("argon2");
        email = `mfa-${randomUUID()}@example.com`;
        const [user] = await db.insert(schema.users).values({ email, passwordHash: await hash(password), emailVerifiedAt: new Date() }).returning();
        userId = user.id;
        const [session] = await db.insert(schema.sessions).values({ userId, expiresAt: new Date(Date.now() + 3600_000) }).returning();
        sessionId = session.id;
        activeSession = { user: { id: userId }, sessionId };
    };
    test("password login remains available until enrollment is confirmed", async () => {
        await seed();
        assert.equal((await authorize()).id, userId);
        assert.equal(await authorize("", "wrong"), null);
        assert.equal((await call({ action: "setup", password }, "https://attacker.example")).status, 403);
        assert.equal((await call({ action: "setup", password: "wrong" })).status, 400);
        const setup = await call({ action: "setup", password });
        assert.equal(setup.status, 200);
        const { secret } = await setup.json();
        assert.match(secret, /^[A-Z2-7]{32}$/);
        assert.equal((await authorize()).id, userId);
        const { GET } = await import("@/app/api/user/mfa/route");
        const status = await GET();
        assert.deepEqual(await status.json(), { enabled: false, available: true });
        assert.equal(status.headers.get("cache-control"), "no-store");
        const db = await getDb(), schema = await getSchema();
        await db.update(schema.userMfa).set({ setupExpiresAt: new Date(0) }).where(eq(schema.userMfa.userId, userId));
        assert.equal((await call({ action: "confirm", password, code: totpAt(secret, Math.floor(Date.now() / 30000)) })).status, 400);
    });
    test("confirmed MFA gates login, blocks replay and atomically consumes recovery codes", async () => {
        await seed();
        const db = await getDb(), schema = await getSchema();
        const [otherSession] = await db.insert(schema.sessions).values({ userId, expiresAt: new Date(Date.now() + 3600_000) }).returning();
        const { secret } = await (await call({ action: "setup", password })).json();
        const step = Math.floor(Date.now() / 30000);
        const confirm = await call({ action: "confirm", password, code: totpAt(secret, step) });
        assert.equal(confirm.status, 200);
        const { recoveryCodes } = await confirm.json();
        assert.equal(recoveryCodes.length, 10);
        assert.equal((await db.select().from(schema.sessions).where(eq(schema.sessions.id, otherSession.id))).length, 0);
        assert.equal((await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId))).length, 1);
        await assert.rejects(authorize(), /MFA_REQUIRED/);
        await assert.rejects(authorize(totpAt(secret, step)), /MFA_INVALID/);
        await assert.rejects(authorize("bad-code"), /MFA_INVALID/);
        const { verifyLoginMfa } = await import("@/lib/mfa");
        const attempts = await Promise.all([verifyLoginMfa(userId, totpAt(secret, step + 1)), verifyLoginMfa(userId, totpAt(secret, step + 1))]);
        assert.deepEqual(attempts.sort(), [false, true]);
        const recoveryAttempts = await Promise.all([verifyLoginMfa(userId, recoveryCodes[0]), verifyLoginMfa(userId, recoveryCodes[0])]);
        assert.deepEqual(recoveryAttempts.sort(), [false, true]);
        assert.equal((await authorize(recoveryCodes[1])).id, userId);
        const [stored] = await db.select().from(schema.userMfa).where(eq(schema.userMfa.userId, userId));
        assert.ok(!stored.secretEncrypted.includes(secret));
        assert.ok(!JSON.stringify(stored.recoveryHashes).includes(recoveryCodes[2]));
        assert.equal((await call({ action: "setup", password })).status, 409);
        assert.equal((await call({ action: "disable", password, code: "bad-code" })).status, 400);
        assert.equal((await call({ action: "disable", password: "wrong", code: recoveryCodes[2] })).status, 400);
        assert.equal((await call({ action: "disable", password, code: recoveryCodes[2] })).status, 200);
        assert.equal((await authorize()).id, userId);
    });
    test("uses the request Host when Next normalizes the URL hostname", async () => {
        await seed();
        const { POST } = await import("@/app/api/user/mfa/route");
        const request = makeRequest("http://localhost:3211/api/user/mfa", { method: "POST", headers: { origin: "http://127.0.0.1:3211", host: "127.0.0.1:3211" }, body: { action: "setup", password } });
        assert.equal((await POST(request)).status, 200);
    });
    test("unauthenticated users cannot inspect or configure MFA", async () => {
        activeSession = null;
        const { GET } = await import("@/app/api/user/mfa/route");
        assert.equal((await GET()).status, 401);
        assert.equal((await call({ action: "setup", password })).status, 401);
    });
});
