import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { agentRuns } from "@/db/schema";
import { resolveBoundAgentId, verifyMcpToken } from "@/lib/mcp";
import { mcpTokenMayUseThreadId } from "@/lib/thread-access";
import { consumeRateLimit } from "@/lib/rate-limit";
import { broadcastMcpEvent } from "@/lib/pubsub";
import { responseSnapshotSchema, PREVIEW_MAX_BYTES } from "@/lib/chat/response-contract";
import { chatStreamingEnabled, saveResponseSnapshot } from "@/lib/chat/responses";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const auth = await verifyMcpToken(req);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const companyId = auth.companyToken!.companyId;
    if (!chatStreamingEnabled(companyId)) return NextResponse.json({ error: "Streaming disabled" }, { status: 404 });
    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Invalid run id" }, { status: 400 });
    if (!consumeRateLimit({ key: `chat:preview:${companyId}:${id}`, limit: 360, windowMs: 60_000 }).allowed)
        return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
    const raw = await req.text();
    if (Buffer.byteLength(raw) > PREVIEW_MAX_BYTES * 2) return NextResponse.json({ error: "Payload too large" }, { status: 413 });
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
    const parsed = responseSnapshotSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "Invalid response snapshot" }, { status: 400 });
    const [run] = await db.select().from(agentRuns).where(and(eq(agentRuns.id, id), eq(agentRuns.companyId, companyId)));
    if (!run?.threadId || !run.agentId) return NextResponse.json({ error: "Run not found" }, { status: 404 });
    let acting: string | null;
    try { acting = await resolveBoundAgentId(companyId, auth.companyToken!, req.nextUrl.searchParams.get("agentId")); }
    catch { return NextResponse.json({ error: "Run not found" }, { status: 404 }); }
    if (acting !== run.agentId || !(await mcpTokenMayUseThreadId(companyId, acting, run.threadId)))
        return NextResponse.json({ error: "Run not found" }, { status: 404 });
    if (run.replyMessageId || run.status !== "running") return NextResponse.json({ accepted: false, terminal: true });
    try {
        const stored = await saveResponseSnapshot({ id: run.id, companyId, threadId: run.threadId, agentId: run.agentId }, parsed.data);
        if (stored) await broadcastMcpEvent(companyId, { type: "chat_response_updated", threadId: run.threadId, agentId: run.agentId });
        return NextResponse.json({ accepted: Boolean(stored) });
    } catch (error) {
        // Response-id/segment collisions are conflicts, never another run's text.
        if ((error as { cause?: { code?: string }; code?: string })?.cause?.code === "23505" || (error as { code?: string })?.code === "23505")
            return NextResponse.json({ error: "Response identity conflict" }, { status: 409 });
        return NextResponse.json({ error: "Unable to store preview" }, { status: 500 });
    }
}
