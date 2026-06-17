import { config } from "dotenv";
config();
import { db } from "./src/db/index";
import { agents, customers } from "./src/db/schema";
import { eq } from "drizzle-orm";

async function getIds() {
    const [agent] = await db.select().from(agents).limit(1);
    const [customer] = await db.select().from(customers).limit(1);
    console.log(`AGENT_ID=${agent?.id || "not-found"}`);
    console.log(`CUSTOMER_ID=${customer?.id || "not-found"}`);
    process.exit(0);
}
getIds();
