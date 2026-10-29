/**
 * The UI language preference: PATCH /api/user/profile saves users.locale and
 * mirrors it in the NEXT_LOCALE cookie (null = Automatic clears it), GET
 * returns it, and anything outside the supported locales is refused.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { dbAvailable, getDb, getSchema, makeRequest, resetDb, seedCompanyWithToken } from "./_helper";
import { actAs, seedHuman } from "./_access-helper";

describe("user locale preference", { skip: !dbAvailable }, () => {
    let user: { userId: string; sessionId: string };

    before(async () => {
        await resetDb();
        const { companyId } = await seedCompanyWithToken();
        user = await seedHuman(companyId, "member");
        actAs(user);
    });
    after(() => actAs(null));

    const patch = async (body: unknown) => {
        const { PATCH } = await import("@/app/api/user/profile/route");
        return PATCH(makeRequest("http://localhost/api/user/profile", { method: "PATCH", body }));
    };
    const stored = async () => {
        const db = await getDb();
        const { users } = await getSchema();
        const { eq } = await import("drizzle-orm");
        const [row] = await db.select({ locale: users.locale }).from(users).where(eq(users.id, user.userId));
        return row.locale;
    };

    test("a new account has no preference (Automatic)", async () => {
        const { GET } = await import("@/app/api/user/profile/route");
        const body = await (await GET()).json() as { locale: string | null };
        assert.equal(body.locale, null);
    });

    test("saving Simplified Chinese stores it and sets the cookie", async () => {
        const res = await patch({ locale: "zh-CN" });
        assert.equal(res.status, 200);
        assert.equal(await stored(), "zh-CN");
        const cookies = res.headers.getSetCookie();
        assert.ok(cookies.some((c) => /^NEXT_LOCALE=zh-CN; Path=\/; Max-Age=\d+; SameSite=Lax$/.test(c)), cookies.join(" | "));
        assert.ok(cookies.some((c) => /^EC_LOCALE_AT=\d+;/.test(c)), "the mirror is stamped as synced");
        assert.ok(cookies.every((c) => !/Secure/.test(c)), "plain HTTP: no Secure flag");
    });

    test("Automatic clears the preference and the cookie", async () => {
        const res = await patch({ locale: null });
        assert.equal(res.status, 200);
        assert.equal(await stored(), null);
        assert.match(res.headers.get("set-cookie") ?? "", /NEXT_LOCALE=;/);
    });

    test("an unsupported locale is refused and changes nothing", async () => {
        await patch({ locale: "en" });
        const res = await patch({ locale: "fr" });
        assert.equal(res.status, 400);
        assert.equal(await stored(), "en");
    });

    test("the app's sync mirrors the saved preference into the cookie (other devices)", async () => {
        const { POST } = await import("@/app/api/i18n/sync/route");
        await patch({ locale: "zh-CN" });
        const res = await POST(makeRequest("https://emperor.example/api/i18n/sync", { method: "POST" }));
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { locale: "zh-CN" });
        const cookies = res.headers.getSetCookie();
        assert.ok(cookies.some((c) => /^NEXT_LOCALE=zh-CN; .*; Secure$/.test(c)), "HTTPS: Secure flag");
        assert.ok(cookies.some((c) => /^EC_LOCALE_AT=\d+;/.test(c)));
        await patch({ locale: "en" });
    });

    test("the sync refuses signed-out callers", async () => {
        const { POST } = await import("@/app/api/i18n/sync/route");
        actAs(null);
        try {
            const res = await POST(makeRequest("http://localhost/api/i18n/sync", { method: "POST" }));
            assert.equal(res.status, 401);
            assert.deepEqual(res.headers.getSetCookie(), []);
        } finally {
            actAs(user);
        }
    });

    test("saving the name alone leaves the language and the cookie alone", async () => {
        const res = await patch({ displayName: "Mei" });
        assert.equal(res.status, 200);
        assert.equal(await stored(), "en");
        assert.equal(res.headers.get("set-cookie"), null);
    });
});
