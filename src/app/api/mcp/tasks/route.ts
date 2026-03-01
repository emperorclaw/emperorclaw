import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { tasks } from "@/db/schema";
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
    const state = searchParams.get("state");
    const projectId = searchParams.get("projectId");

    try {
        const conditions = [
            eq(tasks.companyId, companyId),
            isNull(tasks.deletedAt),
        ];
        if (state) {
            conditions.push(eq(tasks.state, state));
        }
        if (projectId) {
            conditions.push(eq(tasks.projectId, projectId));
        }

        const rows = await db.select()
            .from(tasks)
            .where(and(...conditions))
            .orderBy(desc(tasks.createdAt))
            .limit(limit);

        return NextResponse.json({ tasks: rows });
    } catch (err) {
        console.error("Error fetching tasks:", err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
