import { consumeMfaChallenge, recordSecurityEvent } from "@/lib/account-security";
import { mobileRequestContext } from "@/lib/mobile-context";
import type { Session } from "next-auth";
import type { JWT } from "next-auth/jwt";
import { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { db } from "@/db";
import { users, sessions, companyMembers } from "@/db/schema";
import { and, eq, gt, lt } from "drizzle-orm";
import * as argon2 from "argon2";
import { consumeRateLimit } from "@/lib/rate-limit";
import { isSelfHosted, getInstanceCompany } from "@/lib/instance";

type AuthToken = JWT & {
    id?: string;
    sessionId?: string;
    instanceRole?: string;
    companyRole?: string;
    scopeJson?: Record<string, unknown>;
};

export type SessionWithUserId = Session & {
    user: Session["user"] & {
        id?: string;
        instanceRole?: string;
        companyRole?: string;
        scopeJson?: Record<string, unknown>;
    };
    sessionId?: string;
};

async function getActiveBrowserSession(sessionId?: string | null) {
    if (!sessionId) {
        return null;
    }

    const [session] = await db.select().from(sessions).where(and(
        eq(sessions.id, sessionId),
        gt(sessions.expiresAt, new Date()),
    )).limit(1);

    return session || null;
}

function stripAuthToken(token: AuthToken): AuthToken {
    delete token.id;
    delete token.sessionId;
    delete token.sub;
    delete token.email;
    delete token.name;
    delete token.picture;
    delete token.instanceRole;
    delete token.companyRole;
    delete token.scopeJson;
    return token;
}

export const authOptions: NextAuthOptions = {
    providers: [
        CredentialsProvider({
            name: "Credentials",
            credentials: {
                email: { label: "Email", type: "email" },
                password: { label: "Password", type: "password" },
                code: { label: "Authenticator or recovery code", type: "text" }
            },
            async authorize(credentials, request) {
                if (!credentials?.email || !credentials?.password || credentials.email.length > 320 || credentials.password.length > 1024) {
                    return null;
                }

                const normalizedEmail = String(credentials.email).trim().toLowerCase();

                // Rate limit login attempts: 10 per minute per email
                const rateLimitKey = `login:${normalizedEmail}`;
                const rateResult = consumeRateLimit({
                    key: rateLimitKey,
                    limit: 10,
                    windowMs: 60_000,
                });
                if (!rateResult.allowed) {
                    throw new Error("RATE_LIMITED");
                }

                // Password checks, MFA consumption and session creation share the
                // account lock: an old password cannot create a session after a change.
                return db.transaction(async (tx) => {
                    const [userRecord] = await tx.select().from(users).where(eq(users.email, normalizedEmail)).for("update");
                    if (!userRecord || userRecord.deletedAt || !(await argon2.verify(userRecord.passwordHash, credentials.password))) return null;
                    if (!userRecord.emailVerifiedAt) throw new Error("EMAIL_NOT_VERIFIED");
                    if (!(await consumeMfaChallenge(tx, userRecord.id, String(credentials.code || "").trim()))) throw new Error("MFA_INVALID");
                    const [newSession] = await tx.insert(sessions).values({
                        userId: userRecord.id,
                        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
                        userAgent: String(request?.headers?.["user-agent"] || "").slice(0, 512) || null,
                    }).returning();
                    await recordSecurityEvent(tx, userRecord.id, "signed_in");
                    return { id: userRecord.id, email: userRecord.email, sessionId: newSession.id };
                });
            }
        })
    ],
    session: {
        strategy: "jwt",
    },
    events: {
        async signOut({ token }) {
            const authToken = token as AuthToken | null;
            if (!authToken?.sessionId || !authToken.id) return;
            await db.transaction(async (tx) => {
                await tx.select({ id: users.id }).from(users).where(eq(users.id, authToken.id!)).for("update");
                const removed = await tx.delete(sessions).where(and(eq(sessions.id, authToken.sessionId!), eq(sessions.userId, authToken.id!))).returning({ id: sessions.id });
                if (removed.length) await recordSecurityEvent(tx, authToken.id!, "signed_out");
            });
        },
    },
    callbacks: {
        async jwt({ token, user }) {
            const authToken = token as AuthToken;
            if (user) {
                authToken.id = user.id;
                authToken.sessionId = (user as typeof user & { sessionId?: string }).sessionId;
            }
            const activeSession = await getActiveBrowserSession(authToken.sessionId);
            if (!activeSession || !authToken.id || activeSession.userId !== authToken.id) return stripAuthToken(authToken);
            const [account] = await db.select({ displayName: users.displayName, email: users.email, instanceRole: users.instanceRole, deletedAt: users.deletedAt }).from(users).where(eq(users.id, authToken.id));
            if (!account || account.deletedAt) return stripAuthToken(authToken);
            const [membership] = await db.select({ role: companyMembers.role, scopeJson: companyMembers.scopeJson }).from(companyMembers).where(eq(companyMembers.userId, authToken.id)).limit(1);
            // Read current roles and identity rather than trusting a month-old JWT.
            authToken.name = account.displayName || account.email.split("@")[0] || "User";
            authToken.email = account.email;
            authToken.instanceRole = account.instanceRole;
            authToken.companyRole = membership?.role;
            authToken.scopeJson = membership?.scopeJson as Record<string, unknown> | undefined;
            const cutoff = new Date(Date.now() - 5 * 60_000);
            if (activeSession.lastSeenAt < cutoff) await db.update(sessions).set({ lastSeenAt: new Date() }).where(and(eq(sessions.id, activeSession.id), lt(sessions.lastSeenAt, cutoff)));
            return authToken;
        },
        async session({ session, token }) {
            const authSession = session as SessionWithUserId;
            const authToken = token as AuthToken;
            const activeSession = await getActiveBrowserSession(authToken.sessionId);
            if (!session.user || !authToken.id || !authToken.sessionId || !activeSession || activeSession.userId !== authToken.id) {
                return null as unknown as Session;
            }

            authSession.user.id = authToken.id;
            authSession.sessionId = authToken.sessionId;
            authSession.user.instanceRole = authToken.instanceRole;
            authSession.user.companyRole = authToken.companyRole;
            authSession.user.scopeJson = authToken.scopeJson as Record<string, unknown> | undefined;
            authSession.user.name = authToken.name ?? null;
            return authSession;
        }
    }
};

export async function getValidatedServerSession(): Promise<SessionWithUserId | null> {
    const native = mobileRequestContext.getStore();
    if (native) return { user: { id: native.ctx.userId }, sessionId: native.sessionId, expires: new Date(Date.now() + 60_000).toISOString() };
    const { getServerSession } = await import("next-auth/next");
    const session = await getServerSession(authOptions);
    const typedSession = session as SessionWithUserId | null;
    if (!typedSession || !typedSession.user || !typedSession.user.id || !typedSession.sessionId) {
        return null;
    }

    const activeSession = await getActiveBrowserSession(typedSession.sessionId);
    if (!activeSession || activeSession.userId !== typedSession.user.id) {
        return null;
    }

    return typedSession;
}

/** Minimal cookie-header parser for the WebSocket upgrade path (avoids a runtime dependency). */
function parseCookieHeader(header: string | string[] | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    const raw = Array.isArray(header) ? header.join("; ") : header ?? "";
    for (const part of raw.split(";")) {
        const eq = part.indexOf("=");
        if (eq < 0) continue;
        const name = part.slice(0, eq).trim();
        const value = part.slice(eq + 1).trim();
        // Browsers send cookie values URL-encoded; next-auth expects them decoded
        // (an encoded callback-url cookie fails its validation and the upgrade is refused).
        let decoded = value;
        try { decoded = decodeURIComponent(value); } catch { /* keep the raw value */ }
        if (name) out[name] = decoded;
    }
    return out;
}

/**
 * Validate a signed-in person's session from a raw Node request — the WebSocket
 * upgrade path, which runs before Next handles the request, so the RSC form of
 * getServerSession cannot be used. Decodes the session cookie through next-auth
 * (its own cookie name + JWT secret logic) and re-checks the DB-backed session
 * record, exactly like getValidatedServerSession.
 */
export async function getValidatedSessionFromNodeRequest(request: {
    headers: { host?: string; cookie?: string | string[]; "x-forwarded-proto"?: string | string[]; "x-forwarded-host"?: string | string[]; [key: string]: unknown };
}): Promise<SessionWithUserId | null> {
    const { getServerSession } = await import("next-auth/next");
    const cookies = parseCookieHeader(request.headers.cookie);
    const session = (await getServerSession(
        { headers: request.headers as Record<string, unknown>, cookies, method: "GET" } as never,
        { getHeader() {}, setCookie() {}, setHeader() {} } as never,
        authOptions,
    )) as SessionWithUserId | null;
    if (!session?.user?.id || !session.sessionId) return null;

    const activeSession = await getActiveBrowserSession(session.sessionId);
    if (!activeSession || activeSession.userId !== session.user.id) return null;

    return session;
}

/**
 * Whether a browser session record is still live and belongs to `userId` (not
 * signed out, not expired). Long-lived realtime sockets re-check this on their
 * scope refresh, so signing out closes them.
 */
export async function isBrowserSessionActive(sessionId: string | null | undefined, userId: string): Promise<boolean> {
    const activeSession = await getActiveBrowserSession(sessionId);
    return Boolean(activeSession && activeSession.userId === userId);
}

export async function getCompanyId() {
    const native = mobileRequestContext.getStore();
    if (native) return native.ctx.companyId;
    const typedSession = await getValidatedServerSession();
    if (!typedSession || !typedSession.user || !typedSession.user.id) {
        return null;
    }

    // Always check the user's company membership first
    const [membership] = await db.select().from(companyMembers)
        .where(eq(companyMembers.userId, typedSession.user.id))
        .limit(1);

    if (membership) {
        return membership.companyId;
    }

    // Self-hosted: fall back to the instance company only for an instance admin
    // without a membership yet (NFR-8). Anyone else without a membership (e.g.
    // a removed member with a live session) gets no company at all.
    if (isSelfHosted() && typedSession.user.instanceRole === "instance_admin") {
        const company = await getInstanceCompany();
        return company?.id ?? null;
    }

    return null;
}

export async function getCompanyRole(userId: string, companyId: string): Promise<string | null> {
    const [membership] = await db
        .select({ role: companyMembers.role })
        .from(companyMembers)
        .where(
            and(
                eq(companyMembers.userId, userId),
                eq(companyMembers.companyId, companyId)
            )
        )
        .limit(1);
    return membership?.role ?? null;
}

export async function getUserId() {
    const typedSession = await getValidatedServerSession();
    if (!typedSession || !typedSession.user || !typedSession.user.id) {
        return null;
    }

    return typedSession.user.id;
}
