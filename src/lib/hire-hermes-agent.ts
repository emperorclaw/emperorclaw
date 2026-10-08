import fs from "fs";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { DOCKER_SOCKET, isDocker } from "@/lib/docker";
import { mintAgentSetupToken, provisionHermesContainer } from "@/lib/hermes-provisioning";
import { hermesSafeName } from "@/lib/hermes-names";
import { logAudit } from "@/lib/mcp";
import { assignAgentToIdleWorker } from "@/lib/worker-pairing";

/** Hire an isolated worker without exposing the source worker's credentials. */
export async function hireHermesAgent(input: {
    companyId: string;
    name: string;
    role?: string;
    sourceAgentId: string;
    doctrineJson?: Record<string, string>;
}) {
    const name = input.name.trim();
    if (!name || name.length > 200) throw new Error("Agent name must contain 1–200 characters");
    const [source] = await db.select().from(agents).where(and(
        eq(agents.id, input.sourceAgentId), eq(agents.companyId, input.companyId),
        eq(agents.provider, "hermes"), isNull(agents.deletedAt),
    )).limit(1);
    if (!source?.llmApiKeyEncrypted || !source.llmProvider) throw new Error("Choose a Hermes agent with a stored LLM key and provider");
    const role = input.role?.trim() || "operator";
    // With a Docker socket the agent runs in a sibling container; without one,
    // it is assigned to an idle paired worker (Render). Either way the agent
    // record is created; the runtime is what differs.
    const dockerAvailable = isDocker() && fs.existsSync(DOCKER_SOCKET);
    const [agent] = await db.insert(agents).values({
        companyId: input.companyId, name, role, provider: "hermes",
        deploymentMode: dockerAvailable ? "local" : "remote_paired",
        llmProvider: source.llmProvider, llmModel: source.llmModel,
        llmApiKeyEncrypted: source.llmApiKeyEncrypted, llmApiKeyVersion: source.llmApiKeyVersion,
        scopeJson: source.scopeJson,
        doctrineJson: input.doctrineJson ?? {}, status: "offline",
    }).returning();
    const safeName = hermesSafeName(name);
    try {
        if (!dockerAvailable) {
            const workerId = await assignAgentToIdleWorker(input.companyId, agent);
            await logAudit(input.companyId, "agent", source.id, "hire_hermes_agent", "agent", agent.id, { success: Boolean(workerId), deploymentMode: "remote_paired" });
            if (!workerId) {
                return { agentId: agent.id, name, success: false, message: "No idle remote worker available to run this agent.", outputs: [] };
            }
            return { agentId: agent.id, name, success: true, message: `${name} is assigned to a remote worker and will come online when it pairs.`, outputs: [] };
        }
        const { rawToken } = await mintAgentSetupToken(input.companyId, safeName, agent.id);
        const result = await provisionHermesContainer({ agent, apiToken: rawToken, safeName, role });
        if (result.success) {
            await db.update(agents).set({ containerId: result.containerId, containerName: result.containerName }).where(eq(agents.id, agent.id));
        }
        await logAudit(input.companyId, "agent", source.id, "hire_hermes_agent", "agent", agent.id, { success: result.success });
        return { agentId: agent.id, name, success: result.success, message: result.message, outputs: result.outputs };
    } catch (error) {
        return { agentId: agent.id, name, success: false, message: error instanceof Error ? error.message : "Hermes provisioning failed", outputs: [] };
    }
}
