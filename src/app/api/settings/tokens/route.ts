import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { companyTokens, companyMembers } from "@/db/schema";
import { randomBytes, createHash } from "crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
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

export async function GET() {
    const companyId = await getUserCompanyId();
    if (!companyId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const tokens = await db.select({
            id: companyTokens.id,
            name: companyTokens.name,
            scope: companyTokens.scope,
            lastUsedAt: companyTokens.lastUsedAt,
            createdAt: companyTokens.createdAt,
        }).from(companyTokens)
            .where(and(
                eq(companyTokens.companyId, companyId),
                isNull(companyTokens.revokedAt),
            ))
            .orderBy(desc(companyTokens.createdAt));

        return NextResponse.json({ tokens });
    } catch (err) {
        console.error("Error fetching tokens:", err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    const companyId = await getUserCompanyId();
    if (!companyId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const body = await req.json();
        const { name } = body;

        if (!name) return NextResponse.json({ error: "Token name is required" }, { status: 400 });

        const rawToken = `ec_${randomBytes(24).toString('hex')}`;
        const tokenHash = createHash("sha256").update(rawToken).digest("hex");

        const [newToken] = await db.insert(companyTokens).values({
            companyId,
            name,
            scope: "mcp_full",
            tokenHash,
        }).returning({
            id: companyTokens.id,
            name: companyTokens.name,
            scope: companyTokens.scope,
            createdAt: companyTokens.createdAt,
        });

        await broadcastMcpEvent(companyId, {
            type: "company_token_created",
            token: newToken,
        });

        return NextResponse.json({ token: newToken, secret: rawToken }, { status: 201 });

    } catch (err) {
        console.error("Error creating token:", err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
