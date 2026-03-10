import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { chatMessages } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { verifyMcpToken } from "@/lib/mcp";

export async function POST(req: NextRequest) {
    try {
        // 1. Verify signature/token using our MCP standard company tokens
        const auth = await verifyMcpToken(req);
        if (auth.error) {
            return NextResponse.json({ error: auth.error }, { status: auth.status });
        }
        const companyId = auth.companyToken!.companyId;

        const body = await req.json();

        if (body.event !== "message.created") {
            return NextResponse.json({ error: "Unsupported event" }, { status: 400 });
        }

        const { id, chat_id, thread_id, from_user_id, text, timestamp } = body.message;

        if (!id || !chat_id || !text) {
            return NextResponse.json({ error: "Missing required message fields" }, { status: 400 });
        }

        // 2. Dedupe by message.id
        const [existingMessage] = await db.select().from(chatMessages)
            .where(eq(chatMessages.platformMessageId, id))
            .limit(1);

        if (existingMessage) {
            // Idempotent success
            return NextResponse.json({ ok: true, note: "deduplicated" });
        }

        // 3. Transform and Route
        // This inserts the message into Emperor Claw's system-of-record.
        const [newMessage] = await db.insert(chatMessages).values({
            companyId, // Uses the authenticated company token's ID
            threadId: thread_id || chat_id,
            senderType: 'human', // Inbound usually comes from a human or external platform
            fromUserId: from_user_id,
            text: text,
            platformMessageId: id,
            createdAt: timestamp ? new Date(timestamp) : new Date()
        }).returning();

        import('@/lib/pubsub').then(({ broadcastMcpEvent }) => {
            broadcastMcpEvent(companyId, { type: 'new_message', message: newMessage });
        });

        // 5. Return 200
        return NextResponse.json({ ok: true });

    } catch (error) {
        console.error("Inbound webhook error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
