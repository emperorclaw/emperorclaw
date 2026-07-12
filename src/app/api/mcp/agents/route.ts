import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { verifyMcpToken, checkIdempotency, saveIdempotencyResponse, logAudit } from "@/lib/mcp";
import { and, desc, eq, isNull } from "drizzle-orm";
import { writeAgentMemory } from "@/lib/control-plane";
import { parseJsonBody, optionalString } from "@/lib/validation";

const registerAgentSchema = z.object({
    name: z.string().min(1, "name is required"),
    role: optionalString,
    avatarUrl: optionalString,
    skillsJson: z.array(z.unknown()).nullish(),
    memory: optionalString,
    modelPolicyJson: z.record(z.string(), z.unknown()).nullish(),
    concurrencyLimit: z.number().int().min(0).nullish(),
}).loose();

export async function GET(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { searchParams } = new URL(req.url);
    const limit = Math.min(parseInt(searchParams.get("limit") || "100", 10), 500);

    try {
        const rows = await db.select()
            .from(agents)
            .where(and(eq(agents.companyId, companyId), isNull(agents.deletedAt)))
            .orderBy(desc(agents.createdAt))
            .limit(limit);

        return NextResponse.json({ agents: rows });
    } catch (err) {
        console.error("Error fetching agents:", err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    const authResult = await verifyMcpToken(req);
    if ("error" in authResult) {
        return NextResponse.json({ error: authResult.error }, { status: authResult.status });
    }
    const { companyToken } = authResult;
    const companyId = companyToken.companyId;

    const idempotencyResult = await checkIdempotency(req, companyId, "/api/mcp/agents");
    if ("error" in idempotencyResult) {
        return NextResponse.json({ error: idempotencyResult.error }, { status: idempotencyResult.status });
    }
    if ("cachedResponse" in idempotencyResult) {
        return NextResponse.json(idempotencyResult.cachedResponse);
    }
    const { requestHash } = idempotencyResult;

    try {
        const parsed = await parseJsonBody(req, registerAgentSchema);
        if (parsed.error !== undefined) {
            return NextResponse.json({ error: parsed.error }, { status: 400 });
        }
        const { name, role, skillsJson, memory, modelPolicyJson, concurrencyLimit, avatarUrl } = parsed.data;

        const [agent] = await db.insert(agents).values({
            companyId,
            name,
            role: role || "operator",
            avatarUrl: avatarUrl || `https://api.dicebear.com/9.x/pixel-art/svg?seed=${encodeURIComponent(name)}`,
            skillsJson: Array.isArray(skillsJson) ? skillsJson : [],
            memory: memory || null,
            modelPolicyJson: modelPolicyJson || {},
            concurrencyLimit: typeof concurrencyLimit === "number" ? concurrencyLimit : 1,
            status: "online",
            lastSeenAt: new Date(),
            currentLoad: 0,
        }).returning();

        await logAudit(companyId, "agent", null, "register_agent", "agent", agent.id, { name, role });

        if (memory) {
            await writeAgentMemory({
                companyId,
                agentId: agent.id,
                kind: "context",
                content: memory,
                summary: `Initial memory bootstrap for ${name}`,
                snapshot: memory,
            });
        }

        const responseObj = { message: "Agent registered", agent };
        await saveIdempotencyResponse(companyId, "/api/mcp/agents", requestHash, responseObj);
        return NextResponse.json(responseObj, { status: 201 });
    } catch (error: unknown) {
        console.error("MCP Agents Register Error:", error);
        const details = error instanceof Error ? error.message : undefined;
        const responseBody = details
            ? { error: "Internal server error", details }
            : { error: "Internal server error" };
        return NextResponse.json(responseBody, { status: 500 });
    }
}
