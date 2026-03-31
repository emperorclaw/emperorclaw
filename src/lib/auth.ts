import type { Session } from "next-auth";
import type { JWT } from "next-auth/jwt";
import { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { db } from "@/db";
import { users, sessions } from "@/db/schema";
import { eq } from "drizzle-orm";
import * as argon2 from "argon2";

type AuthToken = JWT & {
    id?: string;
    sessionId?: string;
};

type SessionWithUserId = Session & {
    user: Session["user"] & { id?: string };
    sessionId?: string;
};

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

                const [userRecord] = await db
                    .select()
                    .from(users)
                    .where(eq(users.email, credentials.email))
                    .limit(1);

                if (!userRecord) {
                    return null;
                }

                const isValid = await argon2.verify(userRecord.passwordHash, credentials.password);
                if (!isValid) {
                    return null;
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
            }
            return authToken;
        },
        async session({ session, token }) {
            const authSession = session as SessionWithUserId;
            const authToken = token as AuthToken;
            if (session.user) {
                if (authToken.id) {
                    authSession.user.id = authToken.id;
                }
                if (authToken.sessionId) {
                    authSession.sessionId = authToken.sessionId;
                }

                // Verification that the DB session still exists and is valid could happen here
                // For performance, we trust the JWT in Edge/middleware, but we have the DB record 
                // to implement exact revocation if needed in the API.
            }
            return authSession;
        }
    }
};

export async function getCompanyId() {
    const { getServerSession } = await import("next-auth/next");
    const session = await getServerSession(authOptions);
    const typedSession = session as SessionWithUserId | null;
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
    const { getServerSession } = await import("next-auth/next");
    const session = await getServerSession(authOptions);
    const typedSession = session as SessionWithUserId | null;
    if (!typedSession || !typedSession.user || !typedSession.user.id) {
        return null;
    }

    return typedSession.user.id;
}
