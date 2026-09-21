import fs from "fs";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { DOCKER_SOCKET, isDocker } from "@/lib/docker";
import { mintAgentSetupToken, provisionHermesContainer } from "@/lib/hermes-provisioning";
import { hermesSafeName } from "@/lib/hermes-names";
import { logAudit } from "@/lib/mcp";

/** Hire an isolated worker without exposing the source worker's credentials. */
export async function hireHermesAgent(input: {
    companyId: string;
    name: string;
    role?: string;
    sourceAgentId: string;
    doctrineJson?: Record<string, string>;
}) {
    if (!isDocker() || !fs.existsSync(DOCKER_SOCKET)) throw new Error("Local Hermes hiring requires Docker with its socket mounted");
    const name = input.name.trim();
    if (!name || name.length > 200) throw new Error("Agent name must contain 1–200 characters");
    const [source] = await db.select().from(agents).where(and(
        eq(agents.id, input.sourceAgentId), eq(agents.companyId, input.companyId),
        eq(agents.provider, "hermes"), isNull(agents.deletedAt),
    )).limit(1);
    if (!source?.llmApiKeyEncrypted || !source.llmProvider) throw new Error("Choose a Hermes agent with a stored LLM key and provider");
    const role = input.role?.trim() || "operator";
    const [agent] = await db.insert(agents).values({
        companyId: input.companyId, name, role, provider: "hermes", deploymentMode: "local",
        llmProvider: source.llmProvider, llmModel: source.llmModel,
        llmApiKeyEncrypted: source.llmApiKeyEncrypted, llmApiKeyVersion: source.llmApiKeyVersion,
        scopeJson: source.scopeJson,
        doctrineJson: input.doctrineJson ?? {}, status: "offline",
    }).returning();
    const safeName = hermesSafeName(name);
    try {
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
