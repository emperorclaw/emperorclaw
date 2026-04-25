import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { companyTokens, companyMembers } from "@/db/schema";
import { randomBytes, createHash } from "crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { getValidatedServerSession } from "@/lib/auth";
import { broadcastMcpEvent } from "@/lib/pubsub";
import { isCompanyTokenScope, serializeCompanyToken } from "@/lib/mcp";

async function getUserCompanyId() {
    const session = await getValidatedServerSession();
    const sessionUserId = session?.user?.id;
    if (!session || !sessionUserId) return null;

    const [membership] = await db.select().from(companyMembers)
        .where(eq(companyMembers.userId, sessionUserId))
        .limit(1);

    return membership ? membership.companyId : null;
}

export async function GET() {
    const companyId = await getUserCompanyId();
    if (!companyId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const tokens = await db.select().from(companyTokens)
            .where(and(
                eq(companyTokens.companyId, companyId),
                isNull(companyTokens.revokedAt),
            ))
            .orderBy(desc(companyTokens.createdAt));

        return NextResponse.json({ tokens: tokens.map(serializeCompanyToken) });
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
        const name = typeof body.name === "string" ? body.name.trim() : "";
        const requestedScope = body.scope;

        if (!name) return NextResponse.json({ error: "Token name is required" }, { status: 400 });
        if (requestedScope !== undefined && !isCompanyTokenScope(requestedScope)) {
            return NextResponse.json({ error: "Invalid token scope" }, { status: 400 });
        }

        const scope = requestedScope ?? "mcp_full";

        const rawToken = `ec_${randomBytes(24).toString('hex')}`;
        const tokenHash = createHash("sha256").update(rawToken).digest("hex");

        const [newToken] = await db.insert(companyTokens).values({
            companyId,
            name,
            scope,
            tokenHash,
        }).returning();

        await broadcastMcpEvent(companyId, {
            type: "company_token_created",
            token: serializeCompanyToken(newToken),
        });

        return NextResponse.json({ token: serializeCompanyToken(newToken), secret: rawToken }, { status: 201 });

    } catch (err) {
        console.error("Error creating token:", err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
