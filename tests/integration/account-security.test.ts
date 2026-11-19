import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { hash, verify } from "argon2";
import { dbAvailable, getDb, getSchema, makeRequest, resetDb } from "./_helper";
import { generateTotpSecret, generateRecoveryCodes, recoveryHash } from "../../src/lib/totp";

process.env.EMPEROR_CLAW_MASTER_KEY = "account-security-test-key";
let activeSession: { user: { id: string }; sessionId: string } | null = null;
function stubSession() {
    const path = require.resolve("next-auth/next");
    const stub = new Module(path); stub.filename = path; stub.loaded = true;
    stub.exports = { getServerSession: async () => activeSession };
    require.cache[path] = stub;
}
const password = "current test passphrase";
const newPassword = "new secure test passphrase";
describe("account security and self-service", { skip: !dbAvailable }, () => {
    before(stubSession);
    const seed = async (withMfa = false) => {
        await resetDb();
        const db = await getDb(), schema = await getSchema();
        const [user] = await db.insert(schema.users).values({ email: `account-${randomUUID()}@example.com`, passwordHash: await hash(password), displayName: "Original Name", emailVerifiedAt: new Date() }).returning();
        const [other] = await db.insert(schema.users).values({ email: `other-${randomUUID()}@example.com`, passwordHash: await hash(password), emailVerifiedAt: new Date() }).returning();
        const [current, second] = await db.insert(schema.sessions).values([
            { userId: user.id, expiresAt: new Date(Date.now() + 3600_000), userAgent: "Firefox/100 Linux" },
            { userId: user.id, expiresAt: new Date(Date.now() + 3600_000), userAgent: "Chrome/100 Macintosh" },
        ]).returning();
        const [foreign] = await db.insert(schema.sessions).values({ userId: other.id, expiresAt: new Date(Date.now() + 3600_000) }).returning();
        await db.insert(schema.sessions).values({ userId: user.id, expiresAt: new Date(0) });
        activeSession = { user: { id: user.id }, sessionId: current.id };
        const recovery = generateRecoveryCodes();
        if (withMfa) {
            const { encryptSecretPayload } = await import("@/lib/secrets");
            await db.insert(schema.userMfa).values({ userId: user.id, enabled: true, secretEncrypted: encryptSecretPayload({ secret: generateTotpSecret() })!.encryptedSecret, setupExpiresAt: new Date(), recoveryHashes: recovery.map(recoveryHash) });
        }
        return { db, schema, user, other, current, second, foreign, recovery };
    };
    const request = (path: string, body: unknown, method = "POST", origin = "http://localhost") => makeRequest(`http://localhost/api/user/${path}`, { method, headers: { host: "localhost", origin }, body });
    test("sessions are private, omit expired entries and never expose credentials", async () => {
        const s = await seed();
        const { GET } = await import("@/app/api/user/sessions/route");
        const res = await GET(); assert.equal(res.status, 200); assert.equal(res.headers.get("cache-control"), "no-store");
        const data = await res.json(); assert.equal(data.sessions.length, 2);
        assert.equal(data.sessions.find((row: { id: string }) => row.id === s.current.id).current, true);
        assert.ok(!JSON.stringify(data).includes(s.foreign.id));
        assert.ok(!JSON.stringify(data).includes("passwordHash"));
    });
    test("session revocation checks origin, ownership, password and MFA before changing state", async () => {
        const s = await seed(true);
        const { DELETE } = await import("@/app/api/user/sessions/route");
        assert.equal((await DELETE(request("sessions", { others: true, password }, "DELETE", "https://attacker.example"))).status, 403);
        assert.equal((await DELETE(request("sessions", { sessionId: s.foreign.id, password, code: s.recovery[0] }, "DELETE"))).status, 404);
        const wrong = await DELETE(request("sessions", { others: true, password: "wrong", code: s.recovery[0] }, "DELETE"));
        assert.equal(wrong.status, 400);
        const missing = await DELETE(request("sessions", { others: true, password }, "DELETE"));
        assert.equal((await missing.json()).code, "MFA_REQUIRED");
        const revoked = await DELETE(request("sessions", { others: true, password, code: s.recovery[0] }, "DELETE"));
        assert.equal(revoked.status, 200);
        const { isBrowserSessionActive } = await import("@/lib/auth");
        assert.equal(await isBrowserSessionActive(s.second.id, s.user.id), false);
        assert.equal(await isBrowserSessionActive(s.current.id, s.user.id), true);
        assert.equal(await isBrowserSessionActive(s.foreign.id, s.other.id), true);
    });
    test("password changes revoke all sessions and reset links while preserving MFA", async () => {
        const s = await seed(true);
        await s.db.insert(s.schema.passwordResets).values({ userId: s.user.id, tokenHash: await hash("test-reset-token"), expiresAt: new Date(Date.now() + 3600_000) });
        const { POST } = await import("@/app/api/user/password/route");
        const weak = await POST(request("password", { currentPassword: password, newPassword: "short", code: s.recovery[0] })); assert.equal(weak.status, 400);
        const missing = await POST(request("password", { currentPassword: password, newPassword })); assert.equal((await missing.json()).code, "MFA_REQUIRED");
        const unchanged = await POST(request("password", { currentPassword: password, newPassword: password, code: s.recovery[0] })); assert.equal((await unchanged.json()).code, "PASSWORD_UNCHANGED");
        // The rejected unchanged-password attempt rolls back code consumption.
        const changed = await POST(request("password", { currentPassword: password, newPassword, code: s.recovery[0] })); assert.equal(changed.status, 200);
        const [stored] = await s.db.select().from(s.schema.users).where(eq(s.schema.users.id, s.user.id));
        assert.equal(await verify(stored.passwordHash, newPassword), true); assert.equal(await verify(stored.passwordHash, password), false);
        assert.equal((await s.db.select().from(s.schema.sessions).where(eq(s.schema.sessions.userId, s.user.id))).length, 0);
        assert.equal((await s.db.select().from(s.schema.passwordResets).where(eq(s.schema.passwordResets.userId, s.user.id))).length, 0);
        assert.equal((await s.db.select().from(s.schema.userMfa).where(eq(s.schema.userMfa.userId, s.user.id)))[0].enabled, true);
        const events = await s.db.select().from(s.schema.userSecurityEvents).where(eq(s.schema.userSecurityEvents.userId, s.user.id));
        assert.equal(events[0].event, "password_changed");
        assert.ok(!JSON.stringify(events).includes(newPassword)); assert.ok(!JSON.stringify(events).includes(s.recovery[0]));
        const { authOptions } = await import("@/lib/auth"); const authorize = (authOptions.providers[0] as any).options.authorize;
        assert.equal(await authorize({ email: s.user.email, password, code: s.recovery[1] }), null);
        assert.equal((await authorize({ email: s.user.email, password: newPassword, code: s.recovery[1] })).id, s.user.id);
    });
    test("concurrent password changes with the same session cannot both succeed", async () => {
        const s = await seed(); const { POST } = await import("@/app/api/user/password/route");
        const results = await Promise.all([
            POST(request("password", { currentPassword: password, newPassword })),
            POST(request("password", { currentPassword: password, newPassword: "another new passphrase" })),
        ]);
        assert.deepEqual(results.map((res) => res.status).sort(), [200, 401]);
        const events = await s.db.select().from(s.schema.userSecurityEvents).where(eq(s.schema.userSecurityEvents.userId, s.user.id));
        assert.equal(events.filter((event) => event.event === "password_changed").length, 1);
    });
    test("revoked or expired sessions cannot change a password even with valid credentials", async () => {
        const s = await seed();
        await s.db.delete(s.schema.sessions).where(eq(s.schema.sessions.id, s.current.id));
        const { POST } = await import("@/app/api/user/password/route");
        assert.equal((await POST(request("password", { currentPassword: password, newPassword }))).status, 401);
    });
    test("sign out revokes the database session and cannot revoke somebody else's session", async () => {
        const s = await seed();
        const { authOptions, isBrowserSessionActive } = await import("@/lib/auth");
        await authOptions.events!.signOut!({ token: { id: s.user.id, sessionId: s.foreign.id } } as any);
        assert.equal(await isBrowserSessionActive(s.foreign.id, s.other.id), true);
        await authOptions.events!.signOut!({ token: { id: s.user.id, sessionId: s.current.id } } as any);
        assert.equal(await isBrowserSessionActive(s.current.id, s.user.id), false);
        assert.equal((await s.db.select().from(s.schema.userSecurityEvents).where(eq(s.schema.userSecurityEvents.userId, s.user.id)))[0].event, "signed_out");
    });
    test("JWT refresh uses current profile and role data and strips deleted accounts", async () => {
        const s = await seed();
        const [company] = await s.db.insert(s.schema.companies).values({ name: "Security test", createdByUserId: s.user.id }).returning();
        await s.db.insert(s.schema.companyMembers).values({ userId: s.user.id, companyId: company.id, role: "viewer" });
        const { authOptions } = await import("@/lib/auth");
        await s.db.update(s.schema.users).set({ displayName: "New Name" }).where(eq(s.schema.users.id, s.user.id));
        const fresh = await authOptions.callbacks!.jwt!({ token: { id: s.user.id, sessionId: s.current.id, companyRole: "admin" } } as any);
        assert.equal(fresh.name, "New Name"); assert.equal(fresh.companyRole, "viewer");
        await s.db.update(s.schema.users).set({ deletedAt: new Date() }).where(eq(s.schema.users.id, s.user.id));
        const deleted = await authOptions.callbacks!.jwt!({ token: fresh } as any); assert.equal(deleted.id, undefined);
    });
    test("replacing recovery codes invalidates old codes and records the action", async () => {
        const s = await seed(true);
        const { POST } = await import("@/app/api/user/mfa/route");
        const changed = await POST(request("mfa", { action: "regenerate", password, code: s.recovery[0] }));
        assert.equal(changed.status, 200); const data = await changed.json(); assert.equal(data.recoveryCodes.length, 10);
        const { verifyLoginMfa } = await import("@/lib/mfa");
        assert.equal(await verifyLoginMfa(s.user.id, s.recovery[1]), false);
        assert.equal(await verifyLoginMfa(s.user.id, data.recoveryCodes[0]), true);
        const { GET } = await import("@/app/api/user/security/route");
        const history = await GET(); assert.equal(history.headers.get("cache-control"), "no-store");
        assert.equal((await history.json()).events[0].event, "recovery_codes_regenerated");
    });
    test("profile updates cannot change email or access roles and have bounded input", async () => {
        const s = await seed(); const { PATCH } = await import("@/app/api/user/profile/route");
        assert.equal((await PATCH(request("profile", { displayName: "Impersonated" }, "PATCH", "https://attacker.example"))).status, 403);
        for (const body of [{ email: "attacker@example.com" }, { instanceRole: "instance_admin" }, { role: "owner" }, { displayName: "x".repeat(121) }]) assert.equal((await PATCH(request("profile", body, "PATCH"))).status, 400);
        assert.equal((await PATCH(request("profile", { displayName: " New Name " }, "PATCH"))).status, 200);
        assert.equal((await s.db.select().from(s.schema.users).where(eq(s.schema.users.id, s.user.id)))[0].displayName, "New Name");
    });
    test("unauthenticated requests cannot read account sessions or history", async () => {
        activeSession = null;
        const sessions = await import("@/app/api/user/sessions/route"), security = await import("@/app/api/user/security/route");
        assert.equal((await sessions.GET()).status, 401); assert.equal((await security.GET()).status, 401);
    });
});
