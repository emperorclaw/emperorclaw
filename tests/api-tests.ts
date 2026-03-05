import { config } from "dotenv";
config();

const API_URL = process.env.API_URL || "http://localhost:3000";

async function runApiTests() {
    console.log("🚀 Starting Emperor Claw API Automated Tests...\n");

    let apiToken = process.env.EMPEROR_CLAW_API_TOKEN;

    // 1. Setup Phase: Create an account and token if one isn't provided
    if (!apiToken) {
        console.log("📝 No API token found in ENV. Creating test account...");
        const email = `test_account_${Date.now()}@acme.com`;

        try {
            const { execSync } = require('child_process');

            // First we need to make sure an account exists
            const regRes = await fetch(`${API_URL}/api/auth/register`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    email,
                    password: "password123",
                    companyName: "Test Auto Corp"
                })
            });

            // Note: If email already in use, regRes may be 400 but that's fine if the company exists.

            // Spawn internal script to mint the token straight into the DB
            const tokenOutput = execSync('npx tsx tests/mint_token.ts', { encoding: 'utf-8' });

            // Find the last line that looks like our expected JSON payload
            const tokenOutputLines = tokenOutput.trim().split('\n');
            let jsonString = '';
            for (let i = tokenOutputLines.length - 1; i >= 0; i--) {
                if (tokenOutputLines[i].startsWith('{')) {
                    jsonString = tokenOutputLines[i];
                    break;
                }
            }

            if (!jsonString) throw new Error(`Could not parse JSON from token script: ${tokenOutput}`);

            const creds = JSON.parse(jsonString);

            if (creds.error) {
                throw new Error(`Token generation failed internally: ${creds.error}`);
            }

            apiToken = creds.rawToken;
            console.log(`✅ Test account ready. Token generated: ${apiToken.substring(0, 8)}...`);
        } catch (e: any) {
            console.error("❌ Setup failed:", e.message);
            process.exit(1);
        }
    }

    const mcpFetch = async (endpoint: string, method: string, body?: any) => {
        const res = await fetch(`${API_URL}/api/mcp${endpoint}`, {
            method,
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiToken}`,
                "Idempotency-Key": `test-run-${Date.now()}`
            },
            ...(body && { body: JSON.stringify(body) })
        });

        if (!res.ok) {
            throw new Error(`API Error [${res.status}]: ${await res.text()}`);
        }
        return res.json();
    };

    try {
        // 2. Test Customer Registration
        console.log("\n🔄 1. Testing Customer API...");
        const customerReq = await mcpFetch('/customers', 'POST', { name: "Integration Test Customer", notes: "Test notes" });
        const customerId = customerReq.customer.id;
        console.log(`✅ Customer OK (${customerId})`);

        // 3. Test Project Creation
        console.log("🔄 2. Testing Project API...");
        const projectReq = await mcpFetch('/projects', 'POST', { customerId, goal: "API Test Automation", status: "active" });
        const projectId = projectReq.project.id;
        console.log(`✅ Project OK (${projectId})`);

        // 4. Test Project Memory POST and GET
        console.log("🔄 3. Testing Project Memory API...");
        const memoryContent = `Memory recorded at ${new Date().toISOString()}`;
        const memoryPost = await mcpFetch(`/projects/${projectId}/memory`, 'POST', { content: memoryContent, tags: ["system_test"] });
        console.log(`✅ Memory POST OK. Content: ${memoryPost.data.content}`);

        const memoryGet = await mcpFetch(`/projects/${projectId}/memory`, 'GET');
        if (!memoryGet.data || memoryGet.data[0].content !== memoryContent) {
            throw new Error("Memory GET contents did not match POSTed contents.");
        }
        console.log(`✅ Memory GET OK`);

        // 5. Test Tasks Generate Payload Map Fix
        console.log("🔄 4. Testing Task Dependencies Payload Fix...");
        const blockedIds = ["f47ac10b-58cc-4372-a567-0e02b2c3d479", "12345678-1234-1234-1234-123456789012"];
        const taskGen = await mcpFetch('/tasks/generate', 'POST', {
            projectId,
            taskType: "api_test",
            priority: 100,
            blockedByTaskIds: blockedIds
        });

        if (!taskGen.task.blockedByTaskIds || taskGen.task.blockedByTaskIds.length !== 2) {
            throw new Error(`Task did not persist blockedByTaskIds correctly: ${JSON.stringify(taskGen.task.blockedByTaskIds)}`);
        }
        console.log(`✅ Task Generate OK. Dependency tracking returned successfully mapping array of size. [${taskGen.task.blockedByTaskIds.length}]`);

        console.log("\n🎉 ALL TESTS PASSED SUCCESSFULLY! The OpenClaw issues are formally resolved locally.");
    } catch (e: any) {
        console.error(`\n❌ TEST FAILED: ${e.message}`);
        process.exit(1);
    }
}

runApiTests();
