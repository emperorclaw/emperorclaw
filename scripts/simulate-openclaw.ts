import { randomUUID } from 'crypto';

/**
 * OpenClaw OS Simulation Script
 * 
 * Usage:
 *   TEST_API_TOKEN="your_company_token" CLAW_URL="http://localhost:3000" npx tsx simulate-openclaw.ts
 */

const API_TOKEN = process.env.TEST_API_TOKEN;
const BASE_URL = process.env.CLAW_URL || 'http://localhost:3000';
const AGENT_ID = process.env.AGENT_ID;

if (!API_TOKEN || !AGENT_ID) {
    console.error("Please set TEST_API_TOKEN and AGENT_ID before running this script.");
    process.exit(1);
}

// Helper for making idempotent MCP requests
async function mcpRequest(endpoint: string, payload: any) {
    const res = await fetch(`${BASE_URL}${endpoint}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_TOKEN}`,
            'Idempotency-Key': randomUUID()
        },
        body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok) {
        throw new Error(`API Error [${res.status}] at ${endpoint}: ${JSON.stringify(data)}`);
    }
    return data;
}

// Helper: send message to chat
async function chat(text: string) {
    console.log(`💬 Agent says: ${text}`);
    return mcpRequest('/api/mcp/messages/send', {
        text,
        chat_id: 'default' // Our system puts it in the company stream
    });
}

async function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function run() {
    console.log("🚀 Starting OpenClaw End-to-End Simulation...\n");

    try {
        // 1. Create a Customer
        console.log("👤 Creating a new Customer context...");
        const customerRes = await mcpRequest('/api/mcp/customers', {
            name: "Acme Corp (Simulation)",
            notes: "Targeting enterprise accounts only. Strict SLA required."
        });
        const customerId = customerRes.customer.id;
        await sleep(1000);
        await chat("Initialized new customer context for Acme Corp.");

        // 2. Create a Project
        console.log("📁 Initializing a new Project...");
        const projectRes = await mcpRequest('/api/mcp/projects', {
            customerId,
            goal: "Scrape and identify leading SaaS competitor pricing pages.",
            status: "planning" // initial state
        });
        const projectId = projectRes.project.id;
        await sleep(1000);
        await chat(`Project PRJ-${projectId.substring(0, 6)} active. Breaking down objectives...`);

        // 3. Generate Tasks
        console.log("📋 Generating sub-tasks...");
        const task1Res = await mcpRequest('/api/mcp/tasks', {
            projectId,
            taskType: 'research', priority: 1, inputJson: { target: 'competitor_list' }
        });
        const task2Res = await mcpRequest('/api/mcp/tasks', {
            projectId,
            taskType: 'scraping', priority: 0, inputJson: { target: 'pricing' }
        });
        const task1Id = task1Res.task.id;
        const task2Id = task2Res.task.id;
        await sleep(1000);
        await chat("Generated 2 tactical loops. Assigning tasks to available agents.");

        // 4. Claim Task
        console.log("🤖 Agent claiming task 1...");
        const claimRes = await mcpRequest('/api/mcp/tasks/claim', {
            agentId: AGENT_ID
        });
        await sleep(1000);
        await chat("Researcher-01 beginning execution on Competitor List Generation.");

        // 5. Skill Sharing Simulation
        console.log("🧠 Agent learns a generalized tactic...");
        await sleep(2000);
        await chat("Researcher-01 identified recurring pattern in SERP rate-limiting logic. Extracting generalized bypass tactic.");
        const tacticRes = await mcpRequest('/api/mcp/skills/promote', {
            name: "Stealth SERP Retries",
            intent: "Bypass generic 429s from search engine providers without burning proxies.",
            stepsJson: { behavior: "exponential_backoff_with_jitter", maxRetries: 7 }
        });
        await chat(`Tactic successfully promoted to library as [${tacticRes.tactic.name}]. Active for workforce.`);

        // 6. SLA Breach / Blocked Incident
        console.log("🚨 Simulating a blocked task & incident...");
        await sleep(2000);
        await chat("Agent scraping target blocked by harsh WAF. Task cannot proceed under current protocol.");
        const incidentRes = await mcpRequest('/api/mcp/incidents', {
            projectId,
            taskId: task2Id,
            severity: "critical",
            reasonCode: "SLA_BREACH_WAF_BLOCK",
            summary: "Competitor B pricing page scraping failed due to WAF challenge. Task SLA is breaching."
        });
        console.log("  ⚠️ Incident created:", incidentRes.incident.id);

        // 7. Complete the Task
        console.log("✅ Resolving the initial task...");
        await sleep(2000);
        await chat("Researcher-01 completed list generation. Awaiting human check on the WAF blocker.");
        await mcpRequest(`/api/mcp/tasks/${task1Id}/result`, {
            state: "done",
            agentId: AGENT_ID
        });

        console.log("\n✅ Simulation completed successfully! Check the Emperor Claw Dashboard.");

    } catch (err: any) {
        console.error("\n❌ Simulation Failed:", err.message);
    }
}

run();
