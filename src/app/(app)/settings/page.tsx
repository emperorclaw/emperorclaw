import { getValidatedServerSession } from "@/lib/auth";
import { db } from "@/db";
import { companyMembers, companyTokens, users } from "@/db/schema";
import { and, desc, eq, isNull } from "drizzle-orm";
import { redirect } from "next/navigation";
import { Suspense } from "react";
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

    // Get instance role
    const [userRecord] = await db
        .select({ instanceRole: users.instanceRole })
        .from(users)
        .where(eq(users.id, sessionUserId))
        .limit(1);

    const tokens = await db.select().from(companyTokens)
        .where(and(
            eq(companyTokens.companyId, membership.companyId),
            isNull(companyTokens.revokedAt),
        ))
        .orderBy(desc(companyTokens.createdAt));

    return (
        <Suspense fallback={<div className="p-8"><div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-cyan-400/30 border-t-cyan-400" /></div>}>
            <SettingsClient
                initialTokens={tokens.map(serializeCompanyToken)}
                companyRole={membership.role}
                instanceRole={userRecord?.instanceRole ?? "member"}
            />
        </Suspense>
    );
}
