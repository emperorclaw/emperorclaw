import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { dbAvailable, getDb, getSchema, resetDb, makeRequest, seedCompanyWithToken, seedAgent } from "./_helper";
import { seedHuman } from "./_access-helper";

const maybe = dbAvailable ? test : test.skip;

async function fixture() {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const human = await seedHuman(companyId, "viewer", { scope: { mode: "restricted", agentIds: [], customerIds: [] } });
    const mobile = await import("@/lib/mobile-auth");
    const verifier = "v".repeat(43);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const code = await mobile.issueMobileCode(human.sessionId, human.userId, challenge, "Test iPhone");
    return { companyId, human, mobile, verifier, code };
}
const authRequest = (token: string) => makeRequest("https://example.com/api/mobile/v1/companies", { headers: { authorization: `Bearer ${token}` } });

maybe("native code is single-use and wrong PKCE cannot consume it", async () => {
    const f = await fixture();
    await assert.rejects(f.mobile.exchangeMobileCode(f.code, "x".repeat(43)));
    const attempts = await Promise.allSettled([f.mobile.exchangeMobileCode(f.code, f.verifier), f.mobile.exchangeMobileCode(f.code, f.verifier)]);
    assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
    await assert.rejects(f.mobile.exchangeMobileCode(f.code, f.verifier));
});

maybe("rotating refresh token accepts only one concurrent refresh and invalidates old access", async () => {
    const f = await fixture();
    const initial = await f.mobile.exchangeMobileCode(f.code, f.verifier);
    const attempts = await Promise.allSettled([f.mobile.refreshMobileToken(initial.refreshToken), f.mobile.refreshMobileToken(initial.refreshToken)]);
    assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
    await assert.rejects(f.mobile.mobileIdentity(authRequest(initial.accessToken)));
    const winner = attempts.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<typeof initial>;
    assert.equal((await f.mobile.mobileIdentity(authRequest(winner.value.accessToken))).userId, f.human.userId);
});

maybe("native sessions preserve viewer scope and reject other companies and removed memberships", async () => {
    const f = await fixture();
    const token = await f.mobile.exchangeMobileCode(f.code, f.verifier);
    const request = authRequest(token.accessToken);
    const ctx = await f.mobile.mobileCompanyAccess(request, f.companyId);
    assert.equal(ctx.role, "viewer");
    assert.ok(ctx.scope);
    assert.deepEqual(ctx.scope.agentIds, []);
    await assert.rejects(f.mobile.mobileCompanyAccess(request, randomUUID()));
    const db = await getDb();
    const { companyMembers } = await getSchema();
    const { eq } = await import("drizzle-orm");
    await db.delete(companyMembers).where(eq(companyMembers.userId, f.human.userId));
    await assert.rejects(f.mobile.mobileCompanyAccess(request, f.companyId));
});

maybe("account session revocation cascades to mobile credentials and pending authorization codes", async () => {
    const f = await fixture();
    const initial = await f.mobile.exchangeMobileCode(f.code, f.verifier);
    const identity = await f.mobile.mobileIdentity(authRequest(initial.accessToken));
    const db = await getDb();
    const { sessions } = await getSchema();
    const { eq } = await import("drizzle-orm");
    await db.delete(sessions).where(eq(sessions.id, identity.sessionId));
    await assert.rejects(f.mobile.mobileIdentity(authRequest(initial.accessToken)));
    await assert.rejects(f.mobile.refreshMobileToken(initial.refreshToken));
    const next = await f.mobile.issueMobileCode(f.human.sessionId, f.human.userId, createHash("sha256").update(f.verifier).digest("base64url"), "Next phone");
    await db.delete(sessions).where(eq(sessions.id, f.human.sessionId));
    await assert.rejects(f.mobile.exchangeMobileCode(next, f.verifier));
});

maybe("watch receives a distinct session and cannot provision another watch", async () => {
    const f = await fixture();
    const phone = await f.mobile.exchangeMobileCode(f.code, f.verifier);
    const watch = await f.mobile.pairMobileWatch(authRequest(phone.accessToken));
    assert.notEqual(phone.deviceId, watch.deviceId);
    assert.equal((await f.mobile.mobileIdentity(authRequest(watch.accessToken))).deviceKind, "watch");
    await assert.rejects(f.mobile.pairMobileWatch(authRequest(watch.accessToken)));
    const db = await getDb();
    const { sessions } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const phoneIdentity = await f.mobile.mobileIdentity(authRequest(phone.accessToken));
    await db.delete(sessions).where(eq(sessions.id, phoneIdentity.sessionId));
    assert.equal((await f.mobile.mobileIdentity(authRequest(watch.accessToken))).userId, f.human.userId);
});

maybe("reconnecting a watch revokes only the same user's selected watch session", async () => {
    const f = await fixture();
    const phone = await f.mobile.exchangeMobileCode(f.code, f.verifier);
    const watch = await f.mobile.pairMobileWatch(authRequest(phone.accessToken));
    const replacement = await f.mobile.pairMobileWatch(authRequest(phone.accessToken), watch.deviceId);
    await assert.rejects(f.mobile.mobileIdentity(authRequest(watch.accessToken)));
    assert.equal((await f.mobile.mobileIdentity(authRequest(replacement.accessToken))).userId, f.human.userId);
    const other = await seedHuman(f.companyId, "member");
    const code = await f.mobile.issueMobileCode(other.sessionId, other.userId, createHash("sha256").update(f.verifier).digest("base64url"), "Other phone");
    const otherPhone = await f.mobile.exchangeMobileCode(code, f.verifier);
    await f.mobile.pairMobileWatch(authRequest(otherPhone.accessToken), replacement.deviceId);
    assert.equal((await f.mobile.mobileIdentity(authRequest(replacement.accessToken))).userId, f.human.userId);
});

maybe("mobile snapshot route denies foreign companies and applies live agent scope", async () => {
    const f = await fixture();
    const agent = await seedAgent(f.companyId);
    const phone = await f.mobile.exchangeMobileCode(f.code, f.verifier);
    const route = await import("@/app/api/mobile/v1/companies/[companyId]/snapshot/route");
    const request = authRequest(phone.accessToken);
    const result = await route.GET(request, { params: Promise.resolve({ companyId: f.companyId }) });
    assert.equal(result.status, 200);
    assert.deepEqual((await result.json()).agents, []);
    const db = await getDb();
    const { companyMembers } = await getSchema();
    const { eq } = await import("drizzle-orm");
    await db.update(companyMembers).set({ scopeJson: { mode: "restricted", agentIds: [agent.id] } }).where(eq(companyMembers.id, f.human.membershipId));
    const visible = await route.GET(request, { params: Promise.resolve({ companyId: f.companyId }) });
    assert.deepEqual((await visible.json()).agents.map((row: { id: string }) => row.id), [agent.id]);
    const denied = await route.GET(request, { params: Promise.resolve({ companyId: randomUUID() }) });
    assert.equal(denied.status, 404);
    const anonymous = await route.GET(makeRequest("https://example.com/api/mobile/v1/companies"), { params: Promise.resolve({ companyId: f.companyId }) });
    assert.equal(anonymous.status, 401);
});

maybe("expired access can refresh, but an expired account session cannot", async () => {
    const f = await fixture();
    const phone = await f.mobile.exchangeMobileCode(f.code, f.verifier);
    const identity = await f.mobile.mobileIdentity(authRequest(phone.accessToken));
    const db = await getDb();
    const { sessions, mobileSessions } = await getSchema();
    const { eq } = await import("drizzle-orm");
    await db.update(mobileSessions).set({ accessExpiresAt: new Date(0) }).where(eq(mobileSessions.id, phone.deviceId));
    await assert.rejects(f.mobile.mobileIdentity(authRequest(phone.accessToken)));
    const refreshed = await f.mobile.refreshMobileToken(phone.refreshToken);
    await db.update(sessions).set({ expiresAt: new Date(0) }).where(eq(sessions.id, identity.sessionId));
    await assert.rejects(f.mobile.refreshMobileToken(refreshed.refreshToken));
    await assert.rejects(f.mobile.mobileIdentity(authRequest(refreshed.accessToken)));
});
