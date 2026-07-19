import { db } from "../src/db";
import { agents } from "../src/db/schema";
import { eq } from "drizzle-orm";

async function main() {
    const result = await db.update(agents)
        .set({ status: "offline" })
        .where(eq(agents.provider, "codex"))
        .returning({ id: agents.id, name: agents.name });
    console.log(`Set ${result.length} Codex agents to offline:`, result.map(a => a.name).join(", "));
}

main().catch(console.error);
