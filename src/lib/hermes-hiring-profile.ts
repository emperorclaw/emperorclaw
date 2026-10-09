import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";

export class HermesHiringError extends Error {}

/** Retrying an interrupted hiring request must not create another worker. */
export async function reserveHermesHiringProfile(values: typeof agents.$inferInsert, requestId?: string) {
    if (requestId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) throw new HermesHiringError("Invalid hiring request ID");
    const [created] = await db.insert(agents).values({ ...values, ...(requestId ? { id: requestId } : {}) }).onConflictDoNothing({ target: agents.id }).returning();
    if (created) return { agent: created, created: true };
    if (!requestId) throw new HermesHiringError("Could not create the agent profile");
    const [existing] = await db.select().from(agents).where(eq(agents.id, requestId));
    if (!existing || existing.deletedAt || existing.companyId !== values.companyId || existing.name !== values.name || existing.role !== values.role || existing.provider !== "hermes" || existing.deploymentMode !== "local") throw new HermesHiringError("This hiring request was already used for a different agent");
    // Never replace credentials, access scope, doctrine, or a running runtime.
    return { agent: existing, created: false };
}

export function retainedHermesHiringResult(agent: typeof agents.$inferSelect) {
    return { name: agent.name, agentId: agent.id, success: agent.status === "online", reused: true,
        message: "Existing profile retained with its saved configuration. Check its live status in Agents; use Retry runtime if setup needs repair.", outputs: [] };
}
