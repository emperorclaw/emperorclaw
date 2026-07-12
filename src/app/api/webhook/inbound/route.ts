import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { chatMessages } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { verifyMcpToken } from "@/lib/mcp";
import { appendThreadMessage, ensureTeamThread } from "@/lib/control-plane";
import { broadcastMcpEvent } from "@/lib/pubsub";
import { parseJsonBody, optionalString } from "@/lib/validation";

const inboundWebhookSchema = z.object({
    event: z.string(),
    message: z.object({
        id: z.string().min(1),
        chat_id: z.string().min(1),
        thread_id: optionalString,
        from_user_id: optionalString,
        text: z.string().min(1),
        timestamp: z.union([z.string(), z.number()]).nullish(),
    }).loose(),
}).loose();

export async function POST(req: NextRequest) {
    try {
        // 1. Verify signature/token using our MCP standard company tokens
        const auth = await verifyMcpToken(req);
        if (auth.error) {
            return NextResponse.json({ error: auth.error }, { status: auth.status });
        }
        const companyId = auth.companyToken!.companyId;

        const parsed = await parseJsonBody(req, inboundWebhookSchema);
        if (parsed.error !== undefined) {
            return NextResponse.json({ error: parsed.error }, { status: 400 });
        }

        if (parsed.data.event !== "message.created") {
            return NextResponse.json({ error: "Unsupported event" }, { status: 400 });
        }

        // chat_id is required by the schema but only id/thread routing is used below.
        const { id, thread_id, from_user_id, text, timestamp } = parsed.data.message;

        // 2. Dedupe by message.id — scoped to the caller's company, so one
        // tenant can neither drop another tenant's messages by colliding ids
        // nor probe whether a given platform message id exists elsewhere.
        const [existingMessage] = await db.select().from(chatMessages)
            .where(and(
                eq(chatMessages.companyId, companyId),
                eq(chatMessages.platformMessageId, id),
            ))
            .limit(1);

        if (existingMessage) {
            // Idempotent success
            return NextResponse.json({ ok: true, note: "deduplicated" });
        }

        // 3. Transform and Route
        // This inserts the message into Emperor Claw's system-of-record.
        const thread = await ensureTeamThread(companyId);
        const newMessage = await appendThreadMessage({
            companyId,
            threadId: thread_id || thread.id,
            senderType: "human",
            senderId: from_user_id,
            text,
            platformMessageId: id,
            mirrorToLegacyChat: true,
            createdAt: timestamp ? new Date(timestamp) : new Date(),
        });

        broadcastMcpEvent(companyId, { type: 'thread_message', thread, message: newMessage });

        // 5. Return 200
        return NextResponse.json({ ok: true });

    } catch (error) {
        console.error("Inbound webhook error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
