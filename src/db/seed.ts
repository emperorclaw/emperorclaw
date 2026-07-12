import { config } from "dotenv";
config(); // Load .env before initializing DB

import { db } from "./index";
import { users, companies, companyMembers, companyTokens, agents, customers, projects, incidents, tasks } from "./schema";
import { hash } from "argon2";
import * as crypto from "crypto";
import { eq, sql } from "drizzle-orm";

async function main() {
    console.log("Seeding database...");

    // Check if any company already exists — if so, skip (idempotent).
    const existing = await db.select({ count: sql<number>`count(*)` }).from(companies);
    if (Number(existing[0]?.count) > 0) {
        console.log(`Database already has ${existing[0].count} company/companies — skipping seed.`);
        console.log("Use db:seed --force to re-seed despite existing data.");
        if (!process.argv.includes("--force")) {
            process.exit(0);
        }
        console.log("--force flag set, proceeding with seed anyway.");
    }

    console.log("WARNING: This creates demo data. For production, register via the UI instead.\n");

    // 1. Create an Admin User (skip if already exists)
    const [existingUser] = await db.select().from(users).where(eq(users.email, "admin@acme.com")).limit(1);
    let adminUser = existingUser;
    if (!adminUser) {
        const passwordHash = await hash("password123");
        [adminUser] = await db.insert(users).values({
            email: "admin@acme.com",
            passwordHash,
        }).returning();
        console.log(`Created admin user: ${adminUser.email}`);
    } else {
        console.log(`Admin user already exists: ${adminUser.email}`);
    }

    // 2. Create a Company tied to the Admin User (skip if already exists)
    const [existingCompany] = await db.select().from(companies).where(eq(companies.name, "Acme Corporation")).limit(1);
    let acmeCompany = existingCompany;
    if (!acmeCompany) {
        [acmeCompany] = await db.insert(companies).values({
            name: "Acme Corporation",
            createdByUserId: adminUser.id,
        }).returning();
        console.log(`Created company: ${acmeCompany.name} (ID: ${acmeCompany.id})`);
    } else {
        console.log(`Company already exists: ${acmeCompany.name} (ID: ${acmeCompany.id})`);
    }

    // 3. Link user to company (skip if already linked)
    const [existingMember] = await db.select().from(companyMembers)
        .where(eq(companyMembers.userId, adminUser.id))
        .limit(1);
    if (!existingMember) {
        await db.insert(companyMembers).values({
            companyId: acmeCompany.id,
            userId: adminUser.id,
            role: "owner",
        });
        console.log("Linked admin user to company as owner.");
    }

    // 4. Generate API Token (skip if one already exists)
    const [existingToken] = await db.select().from(companyTokens)
        .where(eq(companyTokens.companyId, acmeCompany.id))
        .limit(1);
    if (!existingToken) {
        const rawToken = crypto.randomBytes(32).toString("hex");
        const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

        await db.insert(companyTokens).values({
            companyId: acmeCompany.id,
            tokenHash: tokenHash,
            name: "Default MCP Token",
            scope: "mcp_full",
        });

        console.log(`\n================================`);
        console.log(`MCP API Token (save this — it won't be shown again):`);
        console.log(`  ${rawToken}`);
        console.log(`================================\n`);
    }

    // 5. Create Agents (skip if any exist)
    const [existingAgents] = await db.select({ count: sql<number>`count(*)` }).from(agents)
        .where(eq(agents.companyId, acmeCompany.id));
    if (Number(existingAgents.count) === 0) {
        const agentData = [
            { name: "Researcher Bot", role: "analyst", skillsJson: ["web_search", "document_parsing"] },
            { name: "Support AI", role: "support", skillsJson: ["ticket_routing", "customer_reply"] },
            { name: "Deployment Automator", role: "devops", skillsJson: ["github_actions", "docker", "aws"] },
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
    }

    // 6. Create a sample Customer
    const [existingCustomer] = await db.select().from(customers)
        .where(eq(customers.companyId, acmeCompany.id))
        .limit(1);
    let customerA = existingCustomer;
    if (!customerA) {
        [customerA] = await db.insert(customers).values({
            companyId: acmeCompany.id,
            name: "Globex Industries",
            notes: "Key enterprise account requesting highly available architecture.",
        }).returning();
        console.log("Created demo customer.");
    }

    // 7. Create a Project and Tasks
    const [existingProject] = await db.select().from(projects)
        .where(eq(projects.companyId, acmeCompany.id))
        .limit(1);
    let projectX = existingProject;
    if (!projectX) {
        [projectX] = await db.insert(projects).values({
            companyId: acmeCompany.id,
            customerId: customerA.id,
            goal: "Migrate legacy infrastructure to AWS",
            status: "active",
        }).returning();
    }

    const [existingTask] = await db.select({ count: sql<number>`count(*)` }).from(tasks)
        .where(eq(tasks.companyId, acmeCompany.id));
    if (Number(existingTask.count) === 0) {
        const taskData: Array<typeof tasks.$inferInsert> = [
            { companyId: acmeCompany.id, projectId: projectX.id, taskType: "Analyze current network topology", state: "done" },
            { companyId: acmeCompany.id, projectId: projectX.id, taskType: "Provision VPC and Subnets", state: "in_progress" },
            { companyId: acmeCompany.id, projectId: projectX.id, taskType: "Migrate DB Schema", state: "inbox" },
        ];
        for (const t of taskData) {
            await db.insert(tasks).values(t);
        }
        console.log("Created 3 demo tasks.");
    }

    // 8. Create an Incident
    const [existingIncident] = await db.select({ count: sql<number>`count(*)` }).from(incidents)
        .where(eq(incidents.companyId, acmeCompany.id));
    if (Number(existingIncident.count) === 0) {
        await db.insert(incidents).values({
            companyId: acmeCompany.id,
            projectId: projectX.id,
            severity: "high",
            status: "open",
            reasonCode: "sla_breach_timeout",
            summary: "API Root endpoint latency exceeded 500ms SLA for Globex DB migration stream.",
        });
        console.log("Created demo incident.");
    }

    console.log("Seeding complete! You can log in with `admin@acme.com` and password `password123`.");
    process.exit(0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
