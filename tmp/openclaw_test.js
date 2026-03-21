const API_BASE = "http://localhost:3030/api/mcp";
const TOKEN = "DEBUG_MASTER_TOKEN_123";

async function request(path, method = "GET", body = null) {
    const url = `${API_BASE}${path}`;
    const options = {
        method,
        headers: {
            "Authorization": `Bearer ${TOKEN}`,
            "Content-Type": "application/json",
            "Idempotency-Key": `test-${Date.now()}-${Math.random()}`
        }
    };
    if (body) options.body = JSON.stringify(body);
    
    const res = await fetch(url, options);
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status} ${res.statusText}: ${text}`);
    }
    return res.json();
}

async function main() {
    console.log("🚀 Starting Full OpenClaw Emulation Test...");

    // 1. Register Agent
    console.log("\n1. Registering Agent...");
    const agent = await request("/agents", "POST", {
        name: "OpenClaw Simulation Bot",
        role: "checker",
        memory: "I am a diagnostic bot."
    });
    console.log(`✅ Registered: ${agent.id}`);
    const agentId = agent.id;

    // 2. Start Session
    console.log("\n2. Starting Session...");
    const session = await request(`/agents/${agentId}/sessions/start`, "POST", {
        openclawSessionId: `session-${Date.now()}`,
        sessionType: "diagnostic"
    });
    console.log(`✅ Session Active: ${session.id}`);

    // 3. Initial Sync
    console.log("\n3. Performing Initial Sync...");
    const sync1 = await request("/messages/sync?mode=all");
    console.log(`✅ Sync Result: Found ${sync1.messages?.length || 0} messages.`);
    const lastTime = sync1.messages?.length > 0 ? sync1.messages[sync1.messages.length - 1].createdAt : null;

    // 4. Send Message
    const textSample = "HELLO_WORLD_" + Date.now();
    console.log(`\n4. Sending Message: ${textSample}`);
    const sendResult = await request("/messages/send", "POST", {
        chat_id: "test_room",
        thread_id: "default",
        text: textSample,
        agentId: agentId
    });
    console.log(`✅ Message sent. ID: ${sendResult.message_id}`);

    // 5. High-Speed Sync (The "Shadow Buffer" Test)
    console.log("\n5. Verifying High-Speed Sync...");
    const sync2 = await request(`/messages/sync?mode=all${lastTime ? `&since=${encodeURIComponent(lastTime)}` : ""}`);
    const found = sync2.messages?.some(m => m.text === textSample);
    
    if (found) {
        console.log("🔥 SUCCESS: The 'Shadow Buffer' captured the message perfectly!");
    } else {
        console.log("❌ FAILURE: Message not found in immediate sync.");
        console.log("Sync Response:", JSON.stringify(sync2, null, 2));
    }

    // 6. Typing Signal
    console.log("\n6. Signaling Typing...");
    await request("/chat/status", "POST", {
        thread_id: "default",
        agentId: agentId,
        isTyping: true
    });
    console.log("✅ Typing status broadcasted.");

    console.log("\n🏁 Test Complete!");
}

main().catch(err => {
    console.error("\n💥 TEST CRASHED:");
    console.error(err);
    process.exit(1);
});
