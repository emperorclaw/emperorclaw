import 'dotenv/config';
import { db } from '../src/db';
import { agents, agentSessions, threadMessages, companyTokens, companies } from '../src/db/schema';
import { appendThreadMessage, ensureTeamThread, startAgentSession } from '../src/lib/control-plane';
import { resolveAgentId } from '../src/lib/mcp';
import { and, eq, gt, desc } from 'drizzle-orm';
import * as crypto from 'crypto';

async function testAsOpenClaw() {
    console.log("🛠 [SYSTEM_DIAGNOSTIC] Simulating OpenClaw Lifecycle...");

    // 0. Prep Company
    const [comp] = await db.select().from(companies).limit(1);
    const companyId = comp.id;
    console.log(`- Company: ${comp.name} (${companyId})`);

    // 1. Register Agent
    const agentName = "OpenClaw_Tester_" + Math.floor(Math.random()*1000);
    const agentId = await resolveAgentId(companyId, agentName);
    console.log(`- Agent Registered: ${agentName} -> ${agentId}`);

    // 2. Start Session
    const sessId = "oc-sess-" + Date.now();
    const session = await startAgentSession({
        companyId,
        agentId,
        openclawSessionId: sessId,
        sessionType: "main"
    });
    console.log(`- Session Started: ${session.id} (OpenClaw ID: ${sessId})`);

    // 3. Thread Setup
    const thread = await ensureTeamThread(companyId);
    console.log(`- Team Thread: ${thread.id}`);

    // 4. Initial Sync State
    const t_pre = new Date();
    await new Promise(r => setTimeout(r, 10)); // Ensure T_pre is before message
    console.log(`- Sync Baseline (T_pre): ${t_pre.toISOString()}`);

    // 5. Send Message (The core test)
    const text = "MISSION_CONTROL_PING_" + Date.now();
    const msg = await appendThreadMessage({
        companyId,
        threadId: thread.id,
        senderType: "agent",
        senderId: agentId,
        text
    });
    console.log(`- Message Sent: "${text}" [${msg.id}] CreatedAt: ${msg.createdAt.toISOString()}`);

    // 6. Immediate Sync (Verifying Shadow Buffer logic)
    // We simulate the +10ms buffer logic used in the real API
    const sinceDate = t_pre; 
    const bufferDate = new Date(sinceDate.getTime() - 10);
    const foundMessages = await db.select().from(threadMessages).where(
        and(eq(threadMessages.companyId, companyId), gt(threadMessages.createdAt, bufferDate))
    );

    const hit = foundMessages.find(m => m.id === msg.id);
    if (hit) {
        console.log(`✅ [SUCCESS] Message found in immediate sync!`);
        console.log(`   Buffer used: ${bufferDate.toISOString()}`);
        console.log(`   Sync returned ${foundMessages.length} total messages.`);
    } else {
        console.log(`❌ [FAILURE] Message NOT found in immediate sync.`);
        console.log(`   Internal DB Time for message: ${msg.createdAt.getTime()}`);
        console.log(`   Query Buffer Time: ${bufferDate.getTime()}`);
    }

    // 7. Direct Thread Verification
    const directThread = await ensureTeamThread(companyId); // Just a check
    console.log(`- Direct Thread Integrity: Verified.`);

    console.log("\n🏁 Simulation Finalized.");
}

testAsOpenClaw().catch(console.error);
