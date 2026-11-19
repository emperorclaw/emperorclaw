import type { NextRequest } from "next/server";
import { and, eq, gt } from "drizzle-orm";
import { verify } from "argon2";
import { db } from "@/db";
import { users, sessions, userMfa, userSecurityEvents } from "@/db/schema";
import { decryptSecretPayload } from "@/lib/secrets";
import { matchingTotpStep, recoveryHash } from "@/lib/totp";

export type SecurityTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export const SECURITY_EVENTS = ["signed_in", "signed_out", "password_changed", "password_reset", "sessions_revoked", "mfa_enabled", "mfa_disabled", "recovery_codes_regenerated"] as const;
export type SecurityEvent = typeof SECURITY_EVENTS[number];
export class AccountSecurityError extends Error {
    constructor(public code: "INVALID_CREDENTIALS" | "MFA_REQUIRED" | "MFA_INVALID" | "SESSION_EXPIRED" | "PASSWORD_UNCHANGED", public status = 400) { super(code); }
}
export function isSameOriginRequest(req: NextRequest): boolean {
    return req.headers.get("origin") === `${req.nextUrl.protocol}//${req.headers.get("host") || req.nextUrl.host}`;
}
export async function recordSecurityEvent(tx: SecurityTransaction, userId: string, event: SecurityEvent, sessionCount?: number) {
    await tx.insert(userSecurityEvents).values({ userId, event, sessionCount });
}
/** Consumed in the caller's transaction, so a failed mutation cannot burn a code. */
export async function consumeMfaChallenge(tx: SecurityTransaction, userId: string, code: string): Promise<boolean> {
    const [mfa] = await tx.select().from(userMfa).where(eq(userMfa.userId, userId)).for("update");
    if (!mfa?.enabled) return true;
    if (!code) throw new AccountSecurityError("MFA_REQUIRED");
    const { secret } = decryptSecretPayload(mfa.secretEncrypted) as { secret: string };
    const step = matchingTotpStep(secret, code.trim(), mfa.lastStep);
    if (step !== null) {
        await tx.update(userMfa).set({ lastStep: step }).where(eq(userMfa.userId, userId));
        return true;
    }
    const hash = recoveryHash(code);
    if (!mfa.recoveryHashes.includes(hash)) return false;
    await tx.update(userMfa).set({ recoveryHashes: mfa.recoveryHashes.filter((h) => h !== hash) }).where(eq(userMfa.userId, userId));
    return true;
}
/** Lock the account before checking credentials and changing security state. */
export async function reauthenticate(tx: SecurityTransaction, userId: string, sessionId: string, password: string, code: string) {
    const [user] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
    const [active] = await tx.select({ id: sessions.id }).from(sessions).where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId), gt(sessions.expiresAt, new Date()))).for("update");
    if (!user || user.deletedAt || !active) throw new AccountSecurityError("SESSION_EXPIRED", 401);
    if (!(await verify(user.passwordHash, password))) throw new AccountSecurityError("INVALID_CREDENTIALS");
    if (!(await consumeMfaChallenge(tx, userId, code))) throw new AccountSecurityError("MFA_INVALID");
    return user;
}
