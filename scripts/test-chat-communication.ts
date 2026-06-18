import { db } from './src/db';
import { chatMessages, companies, users } from './src/db/schema';
import { eq } from 'drizzle-orm';
import * as crypto from 'crypto';

const API_TOKEN = process.env.TEST_API_TOKEN;
const BASE_URL = process.env.CLAW_URL || 'http://localhost:3000';

async function mcpRequest(endpoint: string, payload: any) {
    const res = await fetch(`${BASE_URL}${endpoint}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_TOKEN}`,
            'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify(payload)
    });

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`API Error [${res.status}] at ${endpoint}: ${err}`);
    }
    return res.json();
}

async function mcpRequestGET(endpoint: string) {
    const res = await fetch(`${BASE_URL}${endpoint}`, {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_TOKEN}`,
        }
    });

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`API Error [${res.status}] at ${endpoint}: ${err}`);
    }
    return res.json();
}

async function runChatTest() {
    console.log("🚀 Starting Human-Agent Chat Communication Test...");

    if (!API_TOKEN) {
        throw new Error("Missing TEST_API_TOKEN");
    }

    // 1. Setup Company & User
    const [company] = await db.select().from(companies).limit(1);
    const [user] = await db.select().from(users).limit(1);

    if (!company || !user) {
        throw new Error("Missing Company or User. Make sure db is seeded.");
    }

    const threadId = crypto.randomUUID();

    // 2. Simulate Human sending a message from UI
    console.log("👤 Human sending a direct message via UI (/api/chat simulation)...");
    const [humanMsg] = await db.insert(chatMessages).values({
        companyId: company.id,
        threadId,
        senderType: 'human',
        fromUserId: user.id,
        text: "OpenClaw, status report on recent SLA incidents."
    }).returning();
    console.log(`✅ Direct Message Sent. ID: ${humanMsg.id}`);

    // Wait a sec
    await new Promise(r => setTimeout(r, 1000));

    // 2.5. Simulate OpenClaw polling for messages
    console.log("🤖 OpenClaw polling for new instructions (/api/mcp/messages/sync)...");
    const syncRes = await mcpRequestGET('/api/mcp/messages/sync');
    console.log(`✅ Polled messages count: ${syncRes.messages.length}`);
    const foundMsg = syncRes.messages.find((m: any) => m.id === humanMsg.id);
    if (!foundMsg) {
        throw new Error(`OpenClaw did not receive the human message via sync endpoint!`);
    }

    // Wait a sec
    await new Promise(r => setTimeout(r, 1000));

    // 3. Simulate OpenClaw replying via MCP
    console.log("🤖 OpenClaw Agent replying via MCP (/api/mcp/messages/send)...");
    const replyRes = await mcpRequest('/api/mcp/messages/send', {
        chat_id: threadId,
        text: "I have reviewed the metrics. We had 1 Blocked Task due to a WAF trigger. I have promoted the Stealth SERP tactic to compensate.",
        reply_to_message_id: humanMsg.id
    });
    console.log(`✅ MCP Reply Sent. Response:`, replyRes);

    // 4. Verify thread in DB
    console.log("🔍 Verifying thread in Database...");
    const threadMessages = await db.select().from(chatMessages).where(eq(chatMessages.threadId, threadId)).orderBy(chatMessages.createdAt);

    if (threadMessages.length !== 2) {
        throw new Error(`Expected 2 messages in thread, found ${threadMessages.length}`);
    }

    console.log("--- CHAT LOG ---");
    for (const msg of threadMessages) {
        const sender = msg.senderType === 'human' ? '👤 Admin' : '🤖 OpenClaw';
        console.log(`[${sender}]: ${msg.text}`);
    }
    console.log("----------------");

    console.log("🎉 Chat Communication Test Success!");
}

runChatTest().catch(console.error).then(() => process.exit(0));
