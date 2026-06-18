import { resolveAgentId } from "./src/lib/mcp";
import { db } from "./src/db";
import { companies } from "./src/db/schema";

async function run() {
    try {
        const c = await db.select().from(companies).limit(1);
        console.log("Company:", c[0].id);
        const id = await resolveAgentId(c[0].id, "probe-agent-01");
        console.log("Resolved:", id);
    } catch (e) {
        console.error("ERRORED:", e);
    }
    process.exit(0);
}
run();
