import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { getValidatedServerSession } from "@/lib/auth";
import { db } from "@/db";
import { companyMembers, companyTokens } from "@/db/schema";
import { broadcastMcpEvent } from "@/lib/pubsub";
import { serializeCompanyToken } from "@/lib/mcp";

async function getUserCompanyId() {
    const session = await getValidatedServerSession();
    const sessionUserId = session?.user?.id;
    if (!session || !sessionUserId) return null;

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
        const [existingToken] = await db.select().from(companyTokens).where(and(
            eq(companyTokens.companyId, companyId),
            eq(companyTokens.id, id),
            isNull(companyTokens.revokedAt),
        )).limit(1);

        if (!existingToken) {
            return NextResponse.json({ error: "Token not found" }, { status: 404 });
        }

        const [revokedToken] = await db.update(companyTokens).set({
            revokedAt: new Date(),
        }).where(eq(companyTokens.id, existingToken.id)).returning();

        await broadcastMcpEvent(companyId, {
            type: "company_token_revoked",
            token: serializeCompanyToken(revokedToken),
        });

        return NextResponse.json({ token: serializeCompanyToken(revokedToken) });
    } catch (err) {
        console.error("Error revoking token:", err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
