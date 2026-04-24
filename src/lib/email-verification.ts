import crypto from "crypto";
import { hash } from "argon2";
import { and, eq, gt } from "drizzle-orm";
import { db } from "@/db";
import { emailVerifications, users } from "@/db/schema";

const EMAIL_VERIFICATION_TTL_HOURS = 24;

export async function issueEmailVerificationToken(userId: string) {
    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = await hash(rawToken);
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + EMAIL_VERIFICATION_TTL_HOURS);

    await db.transaction(async (tx) => {
        await tx.delete(emailVerifications).where(eq(emailVerifications.userId, userId));
        await tx.insert(emailVerifications).values({
            userId,
            tokenHash,
            expiresAt,
        });
    });

    return { rawToken, expiresAt };
}

export async function verifyEmailVerificationToken(userId: string, token: string) {
    const now = new Date();
    const activeVerifications = await db.select().from(emailVerifications).where(and(
        eq(emailVerifications.userId, userId),
        gt(emailVerifications.expiresAt, now),
    ));

    if (activeVerifications.length === 0) {
        return false;
    }

    const argon2 = await import("argon2");

    for (const verificationRecord of activeVerifications) {
        try {
            if (await argon2.verify(verificationRecord.tokenHash, token)) {
                await db.transaction(async (tx) => {
                    await tx.update(users)
                        .set({ emailVerifiedAt: now })
                        .where(eq(users.id, userId));

                    await tx.delete(emailVerifications)
                        .where(eq(emailVerifications.userId, userId));
                });

                return true;
            }
        } catch {
            // Ignore malformed hashes and keep scanning active tokens.
        }
    }

    return false;
}
