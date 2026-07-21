import test from "node:test";
import assert from "node:assert/strict";
import { dbAvailable, resetDb, makeRequest, getDb, getSchema } from "./_helper";

const maybe = dbAvailable ? test : test.skip;

async function register(body: unknown) {
    const { POST } = await import("@/app/api/auth/register/route");
    const res = await POST(makeRequest("http://localhost/api/auth/register", {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.1" },
        body,
    }));
    return { res, json: await res.json() };
}

maybe("bootstrap: first signup creates the instance and is auto-verified", async () => {
    await resetDb();
    const { res, json } = await register({
        email: "admin@example.com",
        password: "supersecret",
        companyName: "Acme",
        acceptBetaDisclaimer: true,
    });
    assert.equal(res.status, 201);
    assert.equal(json.instanceCreated, true);

    const db = await getDb();
    const { users } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const [user] = await db.select().from(users).where(eq(users.email, "admin@example.com"));
    assert.ok(user.emailVerifiedAt, "first admin must be auto-verified (no SMTP lockout)");
    assert.equal(user.instanceRole, "instance_admin");
});

maybe("open registration auto-verifies when SMTP is not configured", async () => {
    await resetDb();
    // Bootstrap first, then flip to open registration.
    await register({ email: "admin@example.com", password: "supersecret", companyName: "Acme", acceptBetaDisclaimer: true });
    const db = await getDb();
    const { instanceSettings } = await getSchema();
    const { eq } = await import("drizzle-orm");
    await db.update(instanceSettings).set({ value: "open" }).where(eq(instanceSettings.key, "registration_mode"));

    const { res, json } = await register({ email: "member@example.com", password: "supersecret" });
    assert.equal(res.status, 201);
    assert.equal(json.emailVerificationRequired, false, "no SMTP → account should be auto-verified");

    const { users } = await getSchema();
    const [member] = await db.select().from(users).where(eq(users.email, "member@example.com"));
    assert.ok(member.emailVerifiedAt, "member should be able to log in immediately");
});

maybe("registration rejects duplicate email", async () => {
    await resetDb();
    await register({ email: "admin@example.com", password: "supersecret", companyName: "Acme", acceptBetaDisclaimer: true });
    const { res } = await register({ email: "admin@example.com", password: "supersecret", companyName: "Acme", acceptBetaDisclaimer: true });
    assert.equal(res.status, 400);
});
