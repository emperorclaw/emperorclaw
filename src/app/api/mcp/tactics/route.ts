import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { tactics } from "@/db/schema";
import { verifyMcpToken } from "@/lib/mcp";
import { and, desc, eq, isNull } from "drizzle-orm";

export async function GET(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { searchParams } = new URL(req.url);
    const limit = Math.min(parseInt(searchParams.get("limit") || "100", 10), 500);
    const status = searchParams.get("status");

    try {
        const conditions = [
            eq(tactics.companyId, companyId),
            isNull(tactics.deletedAt),
        ];
        if (status) {
            conditions.push(eq(tactics.status, status));
        }

        const rows = await db.select()
            .from(tactics)
            .where(and(...conditions))
            .orderBy(desc(tactics.createdAt))
            .limit(limit);

        return NextResponse.json({ tactics: rows });
    } catch (err) {
        console.error("Error fetching tactics:", err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
