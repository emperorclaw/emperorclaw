import { NextRequest, NextResponse } from "next/server";
import { eq, and, ne } from "drizzle-orm";
import { verify } from "argon2";
import { z } from "zod";
import { db } from "@/db";
import { users, userMfa, sessions } from "@/db/schema";
import { getValidatedServerSession } from "@/lib/auth";
import { canManageSecrets, encryptSecretPayload, decryptSecretPayload } from "@/lib/secrets";
import { consumeRateLimit } from "@/lib/rate-limit";
import { generateTotpSecret, matchingTotpStep, generateRecoveryCodes, recoveryHash } from "@/lib/totp";

const response = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
const schema = z.object({
    action: z.enum(["setup", "confirm", "disable"]),
    password: z.string().min(1).max(1024),
    code: z.string().max(100).default(""),
});
export async function GET() {
    const session = await getValidatedServerSession();
    if (!session?.user?.id) return response({ error: "Unauthorized" }, 401);
    const [row] = await db.select({ enabled: userMfa.enabled }).from(userMfa).where(eq(userMfa.userId, session.user.id));
    return response({ enabled: row?.enabled ?? false, available: canManageSecrets() });
}
export async function POST(req: NextRequest) {
    // Mutations are browser-only, authenticated and same-origin.
    // Next may normalize nextUrl's hostname to localhost; use the actual
    // request Host for the browser origin while retaining its resolved scheme.
    const requestOrigin = `${req.nextUrl.protocol}//${req.headers.get("host") || req.nextUrl.host}`;
    if (req.headers.get("origin") !== requestOrigin) return response({ error: "Invalid origin" }, 403);
    const session = await getValidatedServerSession();
    if (!session?.user?.id) return response({ error: "Unauthorized" }, 401);
    const userId = session.user.id;
    const limit = consumeRateLimit({ key: `mfa:manage:${userId}`, limit: 10, windowMs: 60_000 });
    if (!limit.allowed) return response({ error: "Too many attempts. Try again in a minute." }, 429);
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return response({ error: "Invalid request" }, 400);
    const { action, password, code } = parsed.data;
    if (!canManageSecrets()) return response({ error: "Authenticator setup requires EMPEROR_CLAW_MASTER_KEY on the server." }, 503);
    return db.transaction(async (tx) => {
        // Also serializes first-time enrollment when no MFA row exists yet.
        const [user] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
        if (!user || !(await verify(user.passwordHash, password))) return response({ error: "Incorrect password" }, 400);
        const [mfa] = await tx.select().from(userMfa).where(eq(userMfa.userId, userId)).for("update");
        if (action === "setup") {
            if (mfa?.enabled) return response({ error: "Two-factor authentication is already enabled." }, 409);
            const secret = generateTotpSecret();
            const encrypted = encryptSecretPayload({ secret })!;
            const values = { secretEncrypted: encrypted.encryptedSecret, enabled: false, lastStep: -1, recoveryHashes: [], setupExpiresAt: new Date(Date.now() + 10 * 60_000) };
            await tx.insert(userMfa).values({ userId, ...values }).onConflictDoUpdate({ target: userMfa.userId, set: values });
            return response({ secret });
        }
        if (!mfa) return response({ error: "Start authenticator setup first." }, 400);
        const { secret } = decryptSecretPayload(mfa.secretEncrypted) as { secret: string };
        const step = matchingTotpStep(secret, code.trim(), mfa.lastStep);
        if (action === "confirm") {
            if (mfa.enabled || mfa.setupExpiresAt.getTime() <= Date.now()) return response({ error: "Setup expired or already completed. Start again." }, 400);
            if (step === null) return response({ error: "Invalid authenticator code" }, 400);
            const recoveryCodes = generateRecoveryCodes();
            await tx.update(userMfa).set({ enabled: true, lastStep: step, recoveryHashes: recoveryCodes.map(recoveryHash) }).where(eq(userMfa.userId, userId));
            await tx.delete(sessions).where(and(eq(sessions.userId, userId), ne(sessions.id, session.sessionId!)));
            return response({ enabled: true, recoveryCodes });
        }
        if (!mfa.enabled || (step === null && !mfa.recoveryHashes.includes(recoveryHash(code)))) return response({ error: "Invalid authenticator or recovery code" }, 400);
        await tx.delete(userMfa).where(eq(userMfa.userId, userId));
        await tx.delete(sessions).where(and(eq(sessions.userId, userId), ne(sessions.id, session.sessionId!)));
        return response({ enabled: false });
    });
}
