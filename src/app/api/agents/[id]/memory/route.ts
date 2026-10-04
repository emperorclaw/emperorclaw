import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { agentMemoryEntries, agents } from "@/db/schema";
import { AuthError, requireRole } from "@/lib/roles";
import { writeAgentMemory } from "@/lib/control-plane";
import { MEMORY_KINDS, MAX_MEMORY_LENGTH } from "@/lib/agent-memory";

export const dynamic = "force-dynamic";

async function agentFor(companyId: string, id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const [agent] = await db.select({ id: agents.id }).from(agents)
        .where(and(eq(agents.id, id), eq(agents.companyId, companyId), isNull(agents.deletedAt))).limit(1);
    return agent ?? null;
}

function failure(error: unknown) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
    console.error("Agent memory error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
}

/** What the agent remembers, newest first. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const ctx = await requireRole("member")();
        const { id } = await params;
        if (!(await agentFor(ctx.companyId, id))) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
        const entries = await db.select().from(agentMemoryEntries)
            .where(and(eq(agentMemoryEntries.companyId, ctx.companyId), eq(agentMemoryEntries.agentId, id)))
            .orderBy(desc(agentMemoryEntries.createdAt)).limit(100);
        return NextResponse.json({ entries });
    } catch (error) {
        return failure(error);
    }
}

/** Teach the agent something: { content, kind }. It reads it on its next turn. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const ctx = await requireRole("admin")();
        const { id } = await params;
        if (!(await agentFor(ctx.companyId, id))) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
        const body = await req.json().catch(() => ({}));
        const content = typeof body.content === "string" ? body.content.trim() : "";
        if (!content) return NextResponse.json({ error: "Write what the agent should remember" }, { status: 400 });
        if (content.length > MAX_MEMORY_LENGTH) return NextResponse.json({ error: `Keep it under ${MAX_MEMORY_LENGTH} characters` }, { status: 400 });
        const kind = (MEMORY_KINDS as readonly string[]).includes(body.kind) ? body.kind : "preference";
        const { entry } = await writeAgentMemory({ companyId: ctx.companyId, agentId: id, kind, content, metadataJson: { source: "operator", userId: ctx.userId } });
        return NextResponse.json({ entry }, { status: 201 });
    } catch (error) {
        return failure(error);
    }
}

/** Forget one memory: ?entryId= */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const ctx = await requireRole("admin")();
        const { id } = await params;
        const entryId = new URL(req.url).searchParams.get("entryId") ?? "";
        if (!/^[0-9a-f-]{36}$/i.test(entryId)) return NextResponse.json({ error: "entryId is required" }, { status: 400 });
        const deleted = await db.delete(agentMemoryEntries).where(and(
            eq(agentMemoryEntries.companyId, ctx.companyId), eq(agentMemoryEntries.agentId, id), eq(agentMemoryEntries.id, entryId),
        )).returning({ id: agentMemoryEntries.id });
        if (deleted.length === 0) return NextResponse.json({ error: "Memory not found" }, { status: 404 });
        return NextResponse.json({ ok: true });
    } catch (error) {
        return failure(error);
    }
}
