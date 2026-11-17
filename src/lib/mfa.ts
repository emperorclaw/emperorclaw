import { db } from "@/db";
import { userMfa } from "@/db/schema";
import { eq } from "drizzle-orm";
import { decryptSecretPayload } from "@/lib/secrets";
import { matchingTotpStep, recoveryHash } from "@/lib/totp";

/** Lock the credential row: concurrent attempts cannot reuse a code. */
export async function verifyLoginMfa(userId: string, code: string): Promise<boolean> {
    return db.transaction(async (tx) => {
        const [mfa] = await tx.select().from(userMfa).where(eq(userMfa.userId, userId)).for("update");
        if (!mfa?.enabled) return true;
        if (!code) throw new Error("MFA_REQUIRED");
        const { secret } = decryptSecretPayload(mfa.secretEncrypted) as { secret: string };
        const step = matchingTotpStep(secret, code, mfa.lastStep);
        if (step !== null) {
            await tx.update(userMfa).set({ lastStep: step }).where(eq(userMfa.userId, userId));
            return true;
        }
        const hash = recoveryHash(code);
        if (!mfa.recoveryHashes.includes(hash)) return false;
        await tx.update(userMfa).set({ recoveryHashes: mfa.recoveryHashes.filter((h) => h !== hash) }).where(eq(userMfa.userId, userId));
        return true;
    });
}
