import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { db } from "@/db";
import { companyMembers, companyTokens, companies } from "@/db/schema";
import { and, desc, eq, isNull } from "drizzle-orm";
import { redirect } from "next/navigation";
import SettingsClient from "./settings-client";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
    const session = await getServerSession(authOptions);
    const sessionUserId = (session?.user as { id?: string } | undefined)?.id;
    if (!sessionUserId) {
        redirect("/login");
    }

    const [membership] = await db.select().from(companyMembers)
        .where(eq(companyMembers.userId, sessionUserId))
        .limit(1);

    if (!membership) {
        return <div className="p-8 text-zinc-400">Company not found.</div>;
    }

    const [companyParams] = await db.select({ contextNotes: companies.contextNotes })
        .from(companies)
        .where(eq(companies.id, membership.companyId))
        .limit(1);

    const tokens = await db.select().from(companyTokens)
        .where(and(
            eq(companyTokens.companyId, membership.companyId),
            isNull(companyTokens.revokedAt),
        ))
        .orderBy(desc(companyTokens.createdAt));

    return <SettingsClient initialTokens={tokens.map((token) => ({
        id: token.id,
        name: token.name,
        scope: token.scope,
        createdAt: token.createdAt.toISOString(),
        lastUsedAt: token.lastUsedAt ? token.lastUsedAt.toISOString() : null,
    }))} initialContextNotes={companyParams?.contextNotes || ""} />;
}
