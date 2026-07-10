import type { Session } from "next-auth";
import type { JWT } from "next-auth/jwt";
import { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { db } from "@/db";
import { users, sessions } from "@/db/schema";
import { and, eq, gt } from "drizzle-orm";
import * as argon2 from "argon2";
import { consumeRateLimit } from "@/lib/rate-limit";

type AuthToken = JWT & {
    id?: string;
    sessionId?: string;
};

type SessionWithUserId = Session & {
    user: Session["user"] & { id?: string };
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
    return token;
}

export const authOptions: NextAuthOptions = {
    providers: [
        CredentialsProvider({
            name: "Credentials",
            credentials: {
                email: { label: "Email", type: "email" },
                password: { label: "Password", type: "password" }
            },
            async authorize(credentials) {
                if (!credentials?.email || !credentials?.password) {
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

                const [userRecord] = await db
                    .select()
                    .from(users)
                    .where(eq(users.email, normalizedEmail))
                    .limit(1);

                if (!userRecord) {
                    return null;
                }

                const isValid = await argon2.verify(userRecord.passwordHash, credentials.password);
                if (!isValid) {
                    return null;
                }

                if (!userRecord.emailVerifiedAt) {
                    throw new Error("EMAIL_NOT_VERIFIED");
                }

                return {
                    id: userRecord.id,
                    email: userRecord.email,
                };
            }
        })
    ],
    session: {
        strategy: "jwt",
    },
    callbacks: {
        async jwt({ token, user }) {
            const authToken = token as AuthToken;
            if (user) {
                authToken.id = user.id;

                // Create a DB-backed session record when they log in
                const expiresAt = new Date();
                expiresAt.setDate(expiresAt.getDate() + 30);

                const [newSession] = await db.insert(sessions).values({
                    userId: user.id,
                    expiresAt
                }).returning();

                authToken.sessionId = newSession.id;
                return authToken;
            }

            const activeSession = await getActiveBrowserSession(authToken.sessionId);
            if (!activeSession || (authToken.id && activeSession.userId !== authToken.id)) {
                return stripAuthToken(authToken);
            }

            return authToken;
        },
        async session({ session, token }) {
            const authSession = session as SessionWithUserId;
            const authToken = token as AuthToken;
            const activeSession = await getActiveBrowserSession(authToken.sessionId);
            if (!session.user || !authToken.id || !authToken.sessionId || !activeSession || activeSession.userId !== authToken.id) {
                return null as any;
            }

            authSession.user.id = authToken.id;
            authSession.sessionId = authToken.sessionId;
            return authSession;
        }
    }
};

export async function getValidatedServerSession() {
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

export async function getCompanyId() {
    const typedSession = await getValidatedServerSession();
    if (!typedSession || !typedSession.user || !typedSession.user.id) {
        return null;
    }

    const { companyMembers } = await import("@/db/schema");
    const [membership] = await db.select().from(companyMembers)
        .where(eq(companyMembers.userId, typedSession.user.id))
        .limit(1);

    return membership ? membership.companyId : null;
}

export async function getUserId() {
    const typedSession = await getValidatedServerSession();
    if (!typedSession || !typedSession.user || !typedSession.user.id) {
        return null;
    }

    return typedSession.user.id;
}
