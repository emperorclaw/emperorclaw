import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { workflowTemplates } from "@/db/schema";
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

    try {
        const templates = await db.select()
            .from(workflowTemplates)
            .where(and(eq(workflowTemplates.companyId, companyId), isNull(workflowTemplates.deletedAt)))
            .orderBy(desc(workflowTemplates.createdAt))
            .limit(limit);

        return NextResponse.json({ templates });
    } catch (err) {
        console.error("Error fetching templates:", err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
