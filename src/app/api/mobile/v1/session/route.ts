import { eq } from "drizzle-orm";
import { db } from "@/db";
import { sessions } from "@/db/schema";
import { mobileIdentity } from "@/lib/mobile-auth";
import { mobileJson, mobileError } from "@/lib/mobile-response";

export async function DELETE(request: Request) {
    try {
        const identity = await mobileIdentity(request);
        await db.delete(sessions).where(eq(sessions.id, identity.sessionId));
        return mobileJson({ revoked: true });
    } catch (error) { return mobileError(error); }
}
