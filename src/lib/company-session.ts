import { getValidatedServerSession } from "@/lib/auth";
import { companyMembers } from "@/db/schema";
import { db } from "@/db";
import { eq } from "drizzle-orm";

export interface SessionCompany {
    companyId: string;
    userId: string;
}

export async function requireCompanyFromSession(): Promise<SessionCompany> {
    const session = await getValidatedServerSession();
    const userId = session?.user?.id;
    if (!userId) {
        throw new Error("Unauthorized");
    }

    // Deterministic when a user belongs to more than one company: the oldest
    // membership is the active one, instead of whichever row Postgres returns.
    const [membership] = await db.select().from(companyMembers).where(
        eq(companyMembers.userId, userId)
    ).orderBy(companyMembers.createdAt).limit(1);
    if (!membership) {
        throw new Error("Company not found");
    }

    return { companyId: membership.companyId, userId };
}
