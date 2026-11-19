import { db } from "@/db";
import { consumeMfaChallenge } from "@/lib/account-security";

/** Lock the credential row: concurrent attempts cannot reuse a code. */
export async function verifyLoginMfa(userId: string, code: string): Promise<boolean> {
    return db.transaction((tx) => consumeMfaChallenge(tx, userId, code));
}
