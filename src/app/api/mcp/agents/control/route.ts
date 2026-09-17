import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, resolveBoundAgentId } from "@/lib/mcp";
import { db } from "@/db";
import { threadMessages } from "@/db/schema";
import { and, asc, eq, sql } from "drizzle-orm";
import { broadcastMcpEvent } from "@/lib/pubsub";

async function actor(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) return { error: NextResponse.json({ error: auth.error }, { status: auth.status }) };
    const companyId = auth.companyToken!.companyId;
    const agentId = await resolveBoundAgentId(companyId, auth.companyToken!, new URL(req.url).searchParams.get("agentId"));
    if (!agentId) return { error: NextResponse.json({ error: "agentId is required" }, { status: 400 }) };
    return { companyId, agentId };
}
export async function GET(req: NextRequest) {
    try {
        const auth = await actor(req);
        if (auth.error) return auth.error;
        const { companyId, agentId } = auth;
        const commands = await db.select().from(threadMessages).where(and(
            eq(threadMessages.companyId, companyId!), eq(threadMessages.targetAgentId, agentId!),
            eq(threadMessages.senderType, "system"), eq(threadMessages.deliveryState, "queued"),
            sql`${threadMessages.metadataJson}->'runtimeControl'->>'action' IN ('kill', 'replace')`,
        )).orderBy(asc(threadMessages.createdAt), asc(threadMessages.id)).limit(100);
        const messageId = new URL(req.url).searchParams.get("messageId");
        let cancelled = false;
        if (messageId) {
            const [message] = await db.select({ state: threadMessages.deliveryState }).from(threadMessages).where(and(
                eq(threadMessages.companyId, companyId!), eq(threadMessages.id, messageId),
            )).limit(1);
            cancelled = !message || message.state === "cancelled";
        }
        return NextResponse.json({ commands, cancelled });
    } catch (e) {
        const error = e instanceof Error ? e.message : "Control polling failed";
        return NextResponse.json({ error }, { status: error.startsWith("Access denied") ? 403 : 500 });
    }
}
export async function POST(req: NextRequest) {
    try {
        const auth = await actor(req);
        if (auth.error) return auth.error;
        const body = await req.json();
        if (typeof body.commandId !== "string") return NextResponse.json({ error: "commandId required" }, { status: 400 });
        const [message] = await db.update(threadMessages).set({ deliveryState: "resolved", text: "Hermes stopped the previous work and cleared its session. Pending prompts were cancelled." }).where(and(
            eq(threadMessages.companyId, auth.companyId!), eq(threadMessages.targetAgentId, auth.agentId!),
            eq(threadMessages.id, body.commandId), eq(threadMessages.senderType, "system"),
            eq(threadMessages.deliveryState, "queued"),
            sql`${threadMessages.metadataJson}->'runtimeControl'->>'action' IN ('kill', 'replace')`,
        )).returning();
        if (message) broadcastMcpEvent(auth.companyId!, { type: "thread_message", threadId: message.threadId, message });
        return NextResponse.json({ ok: true });
    } catch (e) {
        const error = e instanceof Error ? e.message : "Control acknowledgment failed";
        return NextResponse.json({ error }, { status: error.startsWith("Access denied") ? 403 : 500 });
    }
}
