import { NextResponse } from "next/server";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { getCompanyId } from "@/lib/auth";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET() {
    const companyId = await getCompanyId();
    if (!companyId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const allAgents = await db.select({
            id: agents.id,
            name: agents.name,
        }).from(agents)
            .where(eq(agents.companyId, companyId));

        return NextResponse.json({ agents: allAgents });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
