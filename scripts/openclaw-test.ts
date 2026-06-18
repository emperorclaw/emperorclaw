import { config } from "dotenv";
config();

const API_URL = "http://localhost:3000/api/mcp";

async function mcpRequest(endpoint: string, method: string, body: any) {
    const companyToken = process.env.TEST_API_TOKEN;
    if (!companyToken) throw new Error("Missing TEST_API_TOKEN");

    const res = await fetch(`${API_URL}${endpoint}`, {
        method,
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${companyToken}`,
            "Idempotency-Key": `test-request-${Date.now()}-${Math.random()}`,
        },
        body: JSON.stringify(body)
    });

    if (!res.ok) {
        const err = await res.json().catch(() => null);
        throw new Error(`API Error [${res.status}]: ${JSON.stringify(err)}`);
    }

    return await res.json();
}

import { db } from "./src/db/index";
import { agents, customers } from "./src/db/schema";
import { eq } from "drizzle-orm";

async function simulateOpenClaw() {
    console.log("=== 🤖 1. Starting OpenClaw Simulation ===");

    // Fetch required IDs from DB to use in the API calls
    const [agent] = await db.select().from(agents).limit(1);
    const [customer] = await db.select().from(customers).limit(1);
    if (!agent || !customer) {
        throw new Error("Missing Agent or Customer in database. Please seed the DB first.");
    }

    // Step 2: Create a Project
    console.log("\n=== 2. Creating an Active Project ===");
    const projectRes = await mcpRequest("/projects", "POST", {
        customerId: customer.id,
        goal: "Deploy the new User Auth flow UI",
        status: "active"
    });
    console.log(`✅ Project created: ${projectRes.project.id}`);

    // Step 3: Generate Tasks (Manager logic)
    console.log("\n=== 3. Generating Tasks ===");
    const tasksToGen = [
        { title: "Design Login Screen UI", taskType: "design", priority: 80, proofRequired: true },
        { title: "Implement Auth API", taskType: "execution", priority: 90, proofRequired: true },
    ];
    const generatedTasks = [];
    for (const t of tasksToGen) {
        const genRes = await mcpRequest("/tasks/generate", "POST", {
            projectId: projectRes.project.id,
            taskType: t.taskType,
            priority: t.priority,
            proofRequired: t.proofRequired,
            inputJson: { title: t.title }
        });
        generatedTasks.push(genRes.task);
    }
    console.log(`✅ Generated ${generatedTasks.length} tasks in "queued" state`);

    // Step 4: Claim a Task (Worker local loop)
    console.log("\n=== 4. Claiming a Task ===");
    const claimRes = await mcpRequest("/tasks/claim", "POST", {
        agentId: agent.id
    });

    let claimedTask = claimRes?.task;

    if (!claimedTask) {
        console.log("No task claimed. Faking it for the rest of the script...");
        claimedTask = generatedTasks[0];
    } else {
        console.log(`✅ Claimed Task: ${claimedTask.id} (Now in 'in_progress' state)`);
    }


    // Step 5: Emulate Agent Team Chat 
    console.log("\n=== 5. Emitting Agent Team Coordination Messages ===");
    await mcpRequest("/messages/send", "POST", {
        chat_id: "human_manager",
        text: `[Agent Output] I am beginning work on TASK-${claimedTask.id.substring(0, 8)}. I will let you know when the UI renders are ready for QA.`,
    });
    console.log(`✅ Message broadcast to UI Agent Team Chat.`);


    // Step 6: Mark Task as Done with Proof
    console.log("\n=== 6. Submitting Task Result (Done) ===");
    await mcpRequest(`/tasks/${claimedTask.id}/result`, "POST", {
        agentId: agent.id,
        state: "done",
        outputJson: { "status": "Files created", "files": ["/src/app/login/page.tsx"] },
        proofSummary: "Rendered successfully without linter errors in standard responsive breakpoints.",
    });
    console.log(`✅ Task marked 'done' with Proof artifacts attached.`);

    console.log("\n=== 🚀 OpenClaw Simulation Complete. Check your UI! ===");
}

simulateOpenClaw().catch(err => {
    console.error("Simulation failed:", err.message);
    process.exit(1);
});
