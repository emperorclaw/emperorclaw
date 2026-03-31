import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { companyMembers } from "@/db/schema";
import { db } from "@/db";
import { and, eq, isNull } from "drizzle-orm";

export interface SessionCompany {
    companyId: string;
    userId: string;
}

export async function requireCompanyFromSession(): Promise<SessionCompany> {
    const session = await getServerSession(authOptions);
    const userId = session?.user?.id;
    if (!userId) {
        throw new Error("Unauthorized");
    }

    const [membership] = await db.select().from(companyMembers).where(
        and(eq(companyMembers.userId, userId), isNull(companyMembers.deletedAt))
    ).limit(1);
    if (!membership) {
        throw new Error("Company not found");
    }

    return { companyId: membership.companyId, userId };
}
