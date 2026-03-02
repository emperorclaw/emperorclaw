import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { db } from "@/db";
import { companyMembers, companyTokens, companies } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { redirect } from "next/navigation";
import SettingsClient from "./settings-client";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
    const session = await getServerSession(authOptions);
    if (!session || !session.user || !(session.user as any).id) {
        redirect("/api/auth/signin");
    }

    const [membership] = await db.select().from(companyMembers)
        .where(eq(companyMembers.userId, (session.user as any).id))
        .limit(1);

    if (!membership) {
        return <div className="p-8 text-zinc-400">Company not found.</div>;
    }

    const [companyParams] = await db.select({ contextNotes: companies.contextNotes })
        .from(companies)
        .where(eq(companies.id, membership.companyId))
        .limit(1);

    const tokens = await db.select().from(companyTokens)
        .where(eq(companyTokens.companyId, membership.companyId))
        .orderBy(desc(companyTokens.createdAt));

    return <SettingsClient initialTokens={tokens} initialContextNotes={companyParams?.contextNotes || ""} />;
}
