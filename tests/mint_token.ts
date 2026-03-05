import { config } from "dotenv";
config();

import { db } from '../src/db';
import { companies, companyTokens, agents, customers } from '../src/db/schema';
import { eq } from "drizzle-orm";
import * as crypto from 'crypto';

async function mintToken() {
    try {
        const allCompanies = await db.select().from(companies).limit(1);
        if (allCompanies.length === 0) {
            console.log(JSON.stringify({ error: "No companies found. Create an account first." }));
            process.exit(1);
        }

        // Grab whichever company is first (often our test_account)
        const companyId = allCompanies[0].id;

        let agentId;
        const allAgents = await db.select().from(agents).where(eq(agents.companyId, companyId)).limit(1);
        if (allAgents.length === 0) {
            const [a] = await db.insert(agents).values({
                companyId,
                name: "Auto Test Agent",
                role: "operator",
                concurrencyLimit: 2,
            }).returning();
            agentId = a.id;
        } else {
            agentId = allAgents[0].id;
        }

        let customerId;
        const allCustomers = await db.select().from(customers).where(eq(customers.companyId, companyId)).limit(1);
        if (allCustomers.length === 0) {
            const [c] = await db.insert(customers).values({
                companyId,
                name: "Auto Test Customer",
                notes: "Auto Test Notes"
            }).returning();
            customerId = c.id;
        } else {
            customerId = allCustomers[0].id;
        }

        const rawToken = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

        await db.insert(companyTokens).values({
            companyId,
            name: 'API Automation Token',
            tokenHash,
            scope: 'mcp_full'
        });

        console.log(JSON.stringify({ rawToken, agentId, customerId }));
        process.exit(0);

    } catch (e: any) {
        console.log(JSON.stringify({ error: e.message }));
        process.exit(1);
    }
}

mintToken();
