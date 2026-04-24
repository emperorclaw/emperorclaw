import { getValidatedServerSession } from "@/lib/auth";
import { db } from "@/db";
import { companyMembers, companyTokens } from "@/db/schema";
import { and, desc, eq, isNull } from "drizzle-orm";
import { redirect } from "next/navigation";
import SettingsClient from "./settings-client";
import { serializeCompanyToken } from "@/lib/mcp";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
    const session = await getValidatedServerSession();
    const sessionUserId = session?.user?.id;
    if (!sessionUserId) {
        redirect("/login");
    }

    const [membership] = await db.select().from(companyMembers)
        .where(eq(companyMembers.userId, sessionUserId))
        .limit(1);

    if (!membership) {
        return <div className="p-8 text-zinc-400">Company not found.</div>;
    }

    const tokens = await db.select().from(companyTokens)
        .where(and(
            eq(companyTokens.companyId, membership.companyId),
            isNull(companyTokens.revokedAt),
        ))
        .orderBy(desc(companyTokens.createdAt));

    return <SettingsClient initialTokens={tokens.map(serializeCompanyToken)} />;
}
