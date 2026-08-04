import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import { eq } from "drizzle-orm";
import { getCompanyId } from "@/lib/auth";
import { requireRole, AuthError } from "@/lib/roles";
import { db } from "@/db";
import { agents, llmPricing } from "@/db/schema";
import { DOCKER_SOCKET, isDocker } from "@/lib/docker";
import { encryptSecretPayload } from "@/lib/secrets";
import { mintAgentSetupToken, provisionHermesContainer, type SetupOutput } from "@/lib/hermes-provisioning";
import { resolveAgentModelConfiguration } from "@/lib/agent-model-config";

export const dynamic = "force-dynamic";

export const MAX_EASY_SETUP_AGENTS = 10;

const VALID_LLM_PROVIDERS = ["openai", "anthropic", "google", "openrouter", "grok", "deepseek"];

// GET /api/agents/easy-setup — availability check for the Easy Setup entry
// point: only meaningful when the app itself is running in Docker with the
// socket mounted (sibling-container provisioning requires it).
export async function GET() {
    const companyId = await getCompanyId();
    const available = !!companyId && isDocker() && fs.existsSync(DOCKER_SOCKET);
    return NextResponse.json({ available });
}

type AgentSpec = {
    role: string;
    name: string;
    doctrineJson?: Record<string, string>;
};

type AgentBatchResult = {
    name: string;
    agentId: string | null;
    success: boolean;
    message: string;
    outputs: SetupOutput[];
};

// POST /api/agents/easy-setup — batch-provision N Hermes agents in one call.
// Gated to owner/admin (stricter than the general agents:manage permission)
// since this is the one place that owns Docker orchestration for a whole
// batch. Processes specs sequentially, no rollback on partial failure — a
// failed spec doesn't undo earlier successes, and always returns 200 so the
// per-agent results can be inspected individually.
export async function POST(req: NextRequest) {
    let ctx;
    try {
        ctx = await requireRole("owner", "admin")();
    } catch (err) {
        if (err instanceof AuthError) {
            return NextResponse.json({ error: err.message }, { status: err.statusCode });
        }
        throw err;
    }
    const { companyId } = ctx;

    if (!isDocker() || !fs.existsSync(DOCKER_SOCKET)) {
        return NextResponse.json({ error: "Easy Setup requires a Docker install with the Docker socket mounted." }, { status: 400 });
    }

    const body = await req.json().catch(() => ({}));
    const llmProvider = typeof body.llmProvider === "string" && VALID_LLM_PROVIDERS.includes(body.llmProvider)
        ? body.llmProvider
        : null;
    const llmApiKey = typeof body.llmApiKey === "string" ? body.llmApiKey.trim() : "";
    const specs: AgentSpec[] = Array.isArray(body.agents)
        ? body.agents
            .filter((a: unknown): a is AgentSpec =>
                !!a && typeof a === "object" && typeof (a as AgentSpec).role === "string" && typeof (a as AgentSpec).name === "string"
            )
        : [];

    if (specs.length === 0) {
        return NextResponse.json({ error: "agents must be a non-empty array of { role, name }" }, { status: 400 });
    }
    if (specs.length > MAX_EASY_SETUP_AGENTS) {
        return NextResponse.json({ error: `Cannot create more than ${MAX_EASY_SETUP_AGENTS} agents in one batch` }, { status: 400 });
    }

    let llmApiKeyEncrypted: string | null = null;
    let llmApiKeyVersion: string | null = null;
    if (llmApiKey) {
        const encrypted = encryptSecretPayload({ apiKey: llmApiKey });
        if (!encrypted) {
            return NextResponse.json(
                { error: "EMPEROR_CLAW_MASTER_KEY is not configured; cannot store LLM API keys." },
                { status: 500 }
            );
        }
        llmApiKeyEncrypted = encrypted.encryptedSecret;
        llmApiKeyVersion = encrypted.keyVersion;
    }

    const pricing = await db.select({ provider: llmPricing.provider, model: llmPricing.model }).from(llmPricing);
    const llmConfiguration = resolveAgentModelConfiguration({
        current: { llmProvider: null, llmModel: null },
        provider: llmProvider,
        model: null,
        pricing,
    });

    const results: AgentBatchResult[] = [];

    // Sequential on purpose — Promise.all would race Docker container-name
    // collisions and make partial-failure attribution ambiguous.
    for (const spec of specs) {
        const name = spec.name.trim();
        const role = spec.role.trim() || "operator";
        if (!name) {
            results.push({ name: spec.name, agentId: null, success: false, message: "Agent name is required", outputs: [] });
            continue;
        }

        let agentId: string | null = null;
        try {
            const [agent] = await db.insert(agents).values({
                companyId,
                name,
                role,
                provider: "hermes",
                deploymentMode: "local",
                doctrineJson: spec.doctrineJson && typeof spec.doctrineJson === "object" ? spec.doctrineJson : {},
                llmProvider: llmConfiguration.llmProvider,
                llmModel: llmConfiguration.llmModel,
                llmApiKeyEncrypted,
                llmApiKeyVersion,
                status: "offline",
            }).returning();
            agentId = agent.id;

            const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
            const { rawToken } = await mintAgentSetupToken(companyId, safeName);
            const provisionResult = await provisionHermesContainer({ agent, apiToken: rawToken, safeName, role });

            if (provisionResult.success && provisionResult.containerId) {
                await db.update(agents).set({
                    containerId: provisionResult.containerId,
                    containerName: provisionResult.containerName,
                    status: "online",
                    lastSeenAt: new Date(),
                }).where(eq(agents.id, agent.id));
            }

            results.push({
                name,
                agentId: agent.id,
                success: provisionResult.success,
                message: provisionResult.message,
                outputs: provisionResult.outputs,
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : "Unknown error";
            results.push({ name, agentId, success: false, message: `Failed to create/provision agent: ${msg}`, outputs: [] });
        }
    }

    return NextResponse.json({ results });
}
