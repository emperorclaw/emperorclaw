import { config } from "dotenv";
config(); // Load .env before initializing DB

import { db } from "./index";
import { users, companies, companyMembers, companyTokens, agents, customers, projects, incidents, tasks } from "./schema";
import { hash } from "argon2";
import * as crypto from "crypto";

async function main() {
    console.log("Seeding database...");

    // 0. Flush existing data to avoid unique constraint errors
    await db.delete(companies);
    await db.delete(users);

    // 1. Create an Admin User
    const passwordHash = await hash("password123");
    const [adminUser] = await db.insert(users).values({
        email: "admin@acme.com",
        passwordHash,
    }).returning();

    console.log(`Created admin user: ${adminUser.email}`);

    // 2. Create a Company tied to the Admin User
    const [acmeCompany] = await db.insert(companies).values({
        name: "Acme Corporation",
        createdByUserId: adminUser.id,
    }).returning();

    console.log(`Created company: ${acmeCompany.name} (ID: ${acmeCompany.id})`);

    // 3. Link user to company
    await db.insert(companyMembers).values({
        companyId: acmeCompany.id,
        userId: adminUser.id,
        role: "owner",
    });

    // 4. Generate an API Token for testing OpenClaw MCP integration
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    await db.insert(companyTokens).values({
        companyId: acmeCompany.id,
        tokenHash: tokenHash,
        name: "Test MCP Token",
        scope: "mcp_full",
    });

    console.log(`\n================================`);
    console.log(`IMPORTANT: Your API Token for MCP Integration`);
    console.log(`Token: ${rawToken}`);
    console.log(`================================\n`);

    // 5. Create Agents
    const agentData = [
        { name: "Researcher Bot", role: "analyst", skillsJson: ["web_search", "document_parsing"] },
        { name: "Support AI", role: "support", skillsJson: ["ticket_routing", "customer_reply"] },
        { name: "Deployment Automator", role: "devops", skillsJson: ["github_actions", "docker", "aws"] }
    ];

    for (const a of agentData) {
        await db.insert(agents).values({
            companyId: acmeCompany.id,
            name: a.name,
            role: a.role,
            skillsJson: a.skillsJson,
            concurrencyLimit: Math.floor(Math.random() * 5) + 1,
        });
    }
    console.log("Created 3 agents.");

    // 4. Create Customers
    const [customerA] = await db.insert(customers).values({
        companyId: acmeCompany.id,
        name: "Globex Industries",
        notes: "Key enterprise account requesting highly available architecture.",
    }).returning();

    // 5. Create a Project and Tasks
    const [projectX] = await db.insert(projects).values({
        companyId: acmeCompany.id,
        customerId: customerA.id,
        goal: "Migrate legacy infrastructure to AWS",
        status: "active",
    }).returning();

    const taskData: Array<typeof tasks.$inferInsert> = [
        { companyId: acmeCompany.id, projectId: projectX.id, taskType: "Analyze current network topology", state: "done" },
        { companyId: acmeCompany.id, projectId: projectX.id, taskType: "Provision VPC and Subnets", state: "in_progress" },
        { companyId: acmeCompany.id, projectId: projectX.id, taskType: "Migrate DB Schema", state: "inbox" },
    ];

    for (const t of taskData) {
        await db.insert(tasks).values(t);
    }

    // 6. Create an Incident
    await db.insert(incidents).values({
        companyId: acmeCompany.id,
        projectId: projectX.id,
        severity: "high",
        status: "open",
        reasonCode: "sla_breach_timeout",
        summary: "API Root endpoint latency exceeded 500ms SLA for Globex DB migration stream.",
    });

    console.log("Seeding complete! You can log in with `admin@acme.com` and password `password123`.");
    process.exit(0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
