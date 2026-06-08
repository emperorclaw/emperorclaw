import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { getCompanyId } from "@/lib/auth";
import { and, eq, isNull } from "drizzle-orm";
import { writeAgentMemory } from "@/lib/control-plane";

export const dynamic = "force-dynamic";

export async function GET() {
    const companyId = await getCompanyId();
    if (!companyId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const allAgents = await db.select({
            id: agents.id,
            name: agents.name,
            avatarUrl: agents.avatarUrl,
        }).from(agents)
            .where(and(eq(agents.companyId, companyId), isNull(agents.deletedAt)));

        return NextResponse.json({ agents: allAgents });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Internal Server Error";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    const companyId = await getCompanyId();
    if (!companyId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const body = await req.json();
        const name = typeof body.name === "string" ? body.name.trim() : "";
        const role = typeof body.role === "string" ? body.role.trim() : "";
        const memory = typeof body.memory === "string" ? body.memory.trim() : "";
        const avatarUrl = typeof body.avatarUrl === "string" ? body.avatarUrl.trim() : "";
        const concurrencyLimit = Math.max(1, Number(body.concurrencyLimit) || 1);

        if (!name) {
            return NextResponse.json({ error: "name is required" }, { status: 400 });
        }

        const [agent] = await db.insert(agents).values({
            companyId,
            name,
            role: role || "operator",
            avatarUrl: avatarUrl || `https://api.dicebear.com/9.x/pixel-art/svg?seed=${encodeURIComponent(name)}`,
            skillsJson: Array.isArray(body.skillsJson) ? body.skillsJson : [],
            memory: memory || null,
            modelPolicyJson: body.modelPolicyJson && typeof body.modelPolicyJson === "object" ? body.modelPolicyJson : {},
            concurrencyLimit,
            status: "offline",
            currentLoad: 0,
        }).returning();

        if (memory) {
            await writeAgentMemory({
                companyId,
                agentId: agent.id,
                kind: "context",
                content: memory,
                summary: `Initial profile for ${name}`,
                snapshot: memory,
            });
        }

        return NextResponse.json({ agent }, { status: 201 });
    } catch (error: unknown) {
        console.error("Agent create error:", error);
        const message = error instanceof Error ? error.message : "Internal Server Error";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
