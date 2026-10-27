/**
 * Instance invitations are company-scoped: an admin of one company can neither
 * revoke nor resend (and so read) another company's invitation by id.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { dbAvailable, getDb, getSchema, resetDb, seedCompanyWithToken } from "./_helper";
import { actAs, call, seedHuman } from "./_access-helper";

const maybe = dbAvailable ? test : test.skip;

maybe("an admin can't revoke or resend another company's invitation", async () => {
    await resetDb();
    const a = await seedCompanyWithToken();
    const b = await seedCompanyWithToken();
    const adminA = await seedHuman(a.companyId, "admin");
    const adminB = await seedHuman(b.companyId, "admin");
    const { createInvitation } = await import("@/lib/invitations");
    const inviteB = await createInvitation({ email: "guest-b@example.com", role: "member", companyId: b.companyId, createdByUserId: adminB.userId });
    const route = await import("@/app/api/instance/invitations/[id]/route");

    actAs(adminA);
    const resend = await call(route.POST as never, `/api/instance/invitations/${inviteB.id}`, { method: "POST", params: { id: inviteB.id } });
    assert.equal(resend.status, 404, "resend of another company's invitation is not found");
    assert.equal(JSON.stringify(resend.json).includes("guest-b@example.com"), false, "the other company's invitee is never returned");
    const revoke = await call(route.DELETE as never, `/api/instance/invitations/${inviteB.id}`, { method: "DELETE", params: { id: inviteB.id } });
    assert.equal(revoke.status, 404, "revoke of another company's invitation is not found");

    const db = await getDb();
    const { invitations } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select().from(invitations).where(eq(invitations.id, inviteB.id));
    assert.equal(row.deletedAt, null, "the other company's invitation is untouched");

    actAs(adminB);
    const own = await call(route.DELETE as never, `/api/instance/invitations/${inviteB.id}`, { method: "DELETE", params: { id: inviteB.id } });
    assert.equal(own.status, 200, "its own admin can still revoke it");
});
