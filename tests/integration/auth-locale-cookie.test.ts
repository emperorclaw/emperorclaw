/**
 * Credentials sign-in through the real next-auth route handler mirrors the
 * person's saved language into NEXT_LOCALE on the same response (next to
 * next-auth's own session cookie); sign-out clears it.
 *
 * next-auth's App Router handler reads next/headers, which only works inside
 * a Next request; the stub below serves the request under test instead.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { dbAvailable, getDb, getSchema, makeRequest, resetDb } from "./_helper";

process.env.NEXTAUTH_SECRET ??= "integration-test-secret";
process.env.NEXTAUTH_URL ??= "http://localhost:3000";

let current: NextRequest | null = null;
function installHeadersStub() {
    const requireFromNextAuth = Module.createRequire(require.resolve("next-auth"));
    const path = requireFromNextAuth.resolve("next/headers");
    const stub = {
        headers: async () => new Headers(current?.headers),
        cookies: async () => ({
            getAll: () => current?.cookies.getAll() ?? [],
            get: (name: string) => current?.cookies.get(name),
        }),
    };
    const cached = new Module(path);
    cached.filename = path;
    cached.loaded = true;
    cached.exports = stub;
    (require.cache as Record<string, NodeModule>)[path] = cached;
}

/** Every Set-Cookie of a response as name → full header. */
function setCookies(res: Response): Map<string, string> {
    return new Map(res.headers.getSetCookie().map((cookie) => [cookie.slice(0, cookie.indexOf("=")), cookie]));
}

describe("locale cookie on sign-in and sign-out", { skip: !dbAvailable }, () => {
    const password = `pw-${randomUUID()}`;
    const users: Record<string, string> = {};

    before(async () => {
        installHeadersStub();
        await resetDb();
        const db = await getDb();
        const schema = await getSchema();
        const argon2 = await import("argon2");
        const hash = await argon2.hash(password);
        for (const [name, locale] of [["chinese", "zh-CN"], ["automatic", null]] as const) {
            const email = `${name}-${randomUUID()}@example.com`;
            const [user] = await db.insert(schema.users).values({ email, passwordHash: hash, emailVerifiedAt: new Date(), locale }).returning();
            const [company] = await db.insert(schema.companies).values({ name: `${name} co`, createdByUserId: user.id }).returning();
            await db.insert(schema.companyMembers).values({ companyId: company.id, userId: user.id, role: "owner" });
            users[name] = email;
        }
    });
    after(() => { current = null; });

    const route = () => import("@/app/api/auth/[...nextauth]/route");
    const call = async (method: "GET" | "POST", action: string[], init: { cookie?: string; form?: Record<string, string> } = {}) => {
        const { GET, POST } = await route();
        const headers: Record<string, string> = { host: "localhost:3000" };
        if (init.cookie) headers.cookie = init.cookie;
        if (init.form) headers["content-type"] = "application/x-www-form-urlencoded";
        const req = makeRequest(`http://localhost:3000/api/auth/${action.join("/")}`, {
            method, headers, body: init.form ? new URLSearchParams(init.form).toString() : undefined,
        });
        current = req;
        const context = { params: Promise.resolve({ nextauth: action }) };
        return method === "GET" ? GET(req, context as never) : POST(req, context as never);
    };

    const signIn = async (email: string) => {
        const csrf = await call("GET", ["csrf"]);
        const { csrfToken } = await csrf.json() as { csrfToken: string };
        const csrfCookie = [...setCookies(csrf).values()].map((c) => c.split(";")[0]).join("; ");
        return call("POST", ["callback", "credentials"], {
            cookie: csrfCookie,
            form: { csrfToken, email, password, json: "true" },
        });
    };

    test("a saved Simplified Chinese preference is set next to the session cookie", async () => {
        const res = await signIn(users.chinese);
        assert.equal(res.status, 200);
        const cookies = setCookies(res);
        assert.match(cookies.get("next-auth.session-token") ?? "", /^next-auth\.session-token=[^;]+;/, "next-auth still sets its session cookie");
        assert.match(cookies.get("NEXT_LOCALE") ?? "", /^NEXT_LOCALE=zh-CN; Path=\/; Max-Age=\d+; SameSite=Lax$/);
        assert.match(cookies.get("EC_LOCALE_AT") ?? "", /^EC_LOCALE_AT=\d+;/);
    });

    test("Automatic (no saved locale) clears any NEXT_LOCALE left from someone else", async () => {
        const res = await signIn(users.automatic);
        const cookies = setCookies(res);
        assert.ok(cookies.has("next-auth.session-token"));
        assert.match(cookies.get("NEXT_LOCALE") ?? "", /^NEXT_LOCALE=; Path=\/; Max-Age=0;/);
    });

    test("a failed sign-in sets no locale cookie", async () => {
        const csrf = await call("GET", ["csrf"]);
        const { csrfToken } = await csrf.json() as { csrfToken: string };
        const res = await call("POST", ["callback", "credentials"], {
            cookie: [...setCookies(csrf).values()].map((c) => c.split(";")[0]).join("; "),
            form: { csrfToken, email: users.chinese, password: "wrong", json: "true" },
        });
        assert.equal(setCookies(res).has("NEXT_LOCALE"), false);
        assert.equal(setCookies(res).has("next-auth.session-token"), false);
    });

    test("sign-out clears the mirrored preference", async () => {
        const csrf = await call("GET", ["csrf"]);
        const { csrfToken } = await csrf.json() as { csrfToken: string };
        const res = await call("POST", ["signout"], {
            cookie: [...setCookies(csrf).values()].map((c) => c.split(";")[0]).join("; ") + "; NEXT_LOCALE=zh-CN",
            form: { csrfToken, json: "true" },
        });
        const cookies = setCookies(res);
        assert.match(cookies.get("NEXT_LOCALE") ?? "", /^NEXT_LOCALE=; Path=\/; Max-Age=0;/);
        assert.match(cookies.get("EC_LOCALE_AT") ?? "", /Max-Age=0/);
    });
});
