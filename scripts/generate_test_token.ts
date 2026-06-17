import { db } from './src/db';
import { companies, companyTokens, agents } from './src/db/schema';
import * as crypto from 'crypto';

async function generateTestToken() {
    const allCompanies = await db.select().from(companies).limit(1);
    if (allCompanies.length === 0) {
        process.exit(1);
    }
    const companyId = allCompanies[0].id;

    const allAgents = await db.select().from(agents).where(require('drizzle-orm').eq(agents.companyId, companyId)).limit(1);
    if (allAgents.length === 0) {
        process.exit(1);
    }
    const agentId = allAgents[0].id;

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    await db.insert(companyTokens).values({
        companyId,
        name: 'Simulation Test Token',
        tokenHash,
        scope: 'mcp_full'
    });

    console.log(rawToken);
    console.log(agentId);
    process.exit(0);
}

generateTestToken().catch(console.error);
