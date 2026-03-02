import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { playbooks } from "@/db/schema";
import { verifyMcpToken, checkIdempotency, saveIdempotencyResponse } from "@/lib/mcp";
import { and, desc, eq } from "drizzle-orm";
import { randomUUID } from "crypto";

export async function GET(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { searchParams } = new URL(req.url);
    const limit = Math.min(parseInt(searchParams.get("limit") || "100", 10), 500);
    const name = searchParams.get("name");

    try {
        const conditions = [eq(playbooks.companyId, companyId)];
        if (name) {
            conditions.push(eq(playbooks.name, name));
        }

        const rows = await db.select()
            .from(playbooks)
            .where(and(...conditions))
            .orderBy(desc(playbooks.createdAt))
            .limit(limit);

        return NextResponse.json({ playbooks: rows });
    } catch (err) {
        console.error("Error fetching playbooks:", err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const endpoint = "/mcp/playbooks";

    const { requestHash, cachedResponse, error: idempError, status } = await checkIdempotency(req, companyId, endpoint);
    if (idempError) return NextResponse.json({ error: idempError }, { status });
    if (cachedResponse) return NextResponse.json(cachedResponse);

    try {
        const body = await req.json();
        const { name, description, requiredSkillsJson = [], instructionsJson = [] } = body;

        if (!name) {
            return NextResponse.json({ error: "name is required" }, { status: 400 });
        }

        const [newPlaybook] = await db.insert(playbooks).values({
            id: randomUUID(),
            companyId,
            name,
            description,
            requiredSkillsJson,
            instructionsJson,
        }).returning();

        const res = { message: "Playbook created", playbook: newPlaybook };
        await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
        return NextResponse.json(res, { status: 201 });
    } catch (e: any) {
        console.error("Playbooks POST Error:", e);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
