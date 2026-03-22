import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { db } from "@/db";
import { companyMembers, companyTokens } from "@/db/schema";
import { broadcastMcpEvent } from "@/lib/pubsub";

async function getUserCompanyId() {
    const session = await getServerSession(authOptions);
    const sessionUserId = session?.user && "id" in session.user ? session.user.id as string | undefined : undefined;
    if (!session || !session.user || !sessionUserId) return null;

    const [membership] = await db.select().from(companyMembers)
        .where(eq(companyMembers.userId, sessionUserId))
        .limit(1);

    return membership ? membership.companyId : null;
}

export async function DELETE(
    _req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const companyId = await getUserCompanyId();
    if (!companyId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;

    try {
        const [existingToken] = await db.select({
            id: companyTokens.id,
            name: companyTokens.name,
            scope: companyTokens.scope,
            createdAt: companyTokens.createdAt,
            lastUsedAt: companyTokens.lastUsedAt,
        }).from(companyTokens).where(and(
            eq(companyTokens.companyId, companyId),
            eq(companyTokens.id, id),
            isNull(companyTokens.revokedAt),
        )).limit(1);

        if (!existingToken) {
            return NextResponse.json({ error: "Token not found" }, { status: 404 });
        }

        const [revokedToken] = await db.update(companyTokens).set({
            revokedAt: new Date(),
        }).where(eq(companyTokens.id, existingToken.id)).returning({
            id: companyTokens.id,
            name: companyTokens.name,
            scope: companyTokens.scope,
            createdAt: companyTokens.createdAt,
            lastUsedAt: companyTokens.lastUsedAt,
            revokedAt: companyTokens.revokedAt,
        });

        await broadcastMcpEvent(companyId, {
            type: "company_token_revoked",
            token: revokedToken,
        });

        return NextResponse.json({ token: revokedToken });
    } catch (err) {
        console.error("Error revoking token:", err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
