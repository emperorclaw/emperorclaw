import { z } from "zod";
import { hireHermesAgent } from "@/lib/hire-hermes-agent";
import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { getCompanyId } from "@/lib/auth";
import { requireRole, AuthError } from "@/lib/roles";
import { db } from "@/db";
import { agents, llmPricing } from "@/db/schema";
import { DOCKER_SOCKET, isDocker, dockerCall } from "@/lib/docker";
import { encryptSecretPayload } from "@/lib/secrets";
import { mintAgentSetupToken, provisionHermesContainer, type SetupOutput } from "@/lib/hermes-provisioning";
import { hermesSafeName } from "@/lib/hermes-names";
import { resolveAgentModelConfiguration } from "@/lib/agent-model-config";

export const dynamic = "force-dynamic";

export const MAX_EASY_SETUP_AGENTS = 10;

const VALID_LLM_PROVIDERS = ["openai", "anthropic", "google", "openrouter", "grok", "deepseek"];

// GET /api/agents/easy-setup — availability check for the Easy Setup entry
// point: only meaningful when the app itself is running in Docker with the
// socket mounted (sibling-container provisioning requires it).
export async function GET() {
    const companyId = await getCompanyId();
    let available = false;
    let reason = "Sign in to create a worker.";
    if (companyId) {
        if (!isDocker() || !fs.existsSync(DOCKER_SOCKET)) reason = "This installation needs Docker with its socket mounted for automatic Hermes setup.";
        else {
            try {
                available = (await dockerCall("GET", "/_ping")).code === 200;
                reason = available ? "" : "Docker is not responding. Restart Docker and retry.";
            } catch {
                reason = "The app cannot access Docker. Rerun the installer to repair socket permissions, then retry.";
            }
        }
    }
    const configurations = available ? await db.select({ id: agents.id, name: agents.name, llmProvider: agents.llmProvider, llmModel: agents.llmModel })
        .from(agents).where(and(eq(agents.companyId, companyId!), eq(agents.provider, "hermes"), isNull(agents.deletedAt), isNotNull(agents.llmApiKeyEncrypted), isNotNull(agents.llmProvider))) : [];
    return NextResponse.json({ available, configurations, reason });
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
        return NextResponse.json({ error: "Hiring a local agent requires a Docker install with the Docker socket mounted." }, { status: 400 });
    }

    const body = await req.json().catch(() => ({}));
    const llmProvider = typeof body.llmProvider === "string" && VALID_LLM_PROVIDERS.includes(body.llmProvider)
        ? body.llmProvider
        : null;
    const llmApiKey = typeof body.llmApiKey === "string" ? body.llmApiKey.trim() : "";
    const parsedModel = z.string().trim().max(200).optional().safeParse(body.llmModel);
    if (!parsedModel.success) return NextResponse.json({ error: "Model must be a name of at most 200 characters" }, { status: 400 });
    const parsedSpecs = z.array(z.object({
        name: z.string().trim().min(1).max(200),
        role: z.string().trim().max(200),
        doctrineJson: z.record(z.string(), z.string()).optional(),
    })).min(1).max(MAX_EASY_SETUP_AGENTS).safeParse(body.agents);
    if (!parsedSpecs.success) return NextResponse.json({ error: "Provide 1–10 agents with non-empty names, roles, and optional text doctrine files" }, { status: 400 });
    const specs: AgentSpec[] = parsedSpecs.data;

    if (typeof body.sourceAgentId === "string" && body.sourceAgentId) {
        const results: AgentBatchResult[] = [];
        for (const spec of specs) {
            try {
                results.push(await hireHermesAgent({ companyId, name: spec.name, role: spec.role, sourceAgentId: body.sourceAgentId, doctrineJson: spec.doctrineJson }));
            } catch (err) {
                results.push({ name: spec.name, agentId: null, success: false, message: err instanceof Error ? err.message : "Hiring failed", outputs: [] });
            }
        }
        return NextResponse.json({ results });
    }
    if (!llmProvider || !llmApiKey) return NextResponse.json({ error: "Choose an existing Hermes configuration or provide an LLM provider and API key" }, { status: 400 });

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
        model: parsedModel.data || null,
        pricing,
    });

    if (llmConfiguration.llmProvider !== llmProvider) return NextResponse.json({ error: "The selected model belongs to a different provider. Choose a matching model or leave it blank." }, { status: 400 });

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

            const safeName = hermesSafeName(name);
            const { rawToken } = await mintAgentSetupToken(companyId, safeName, agentId);
            const provisionResult = await provisionHermesContainer({ agent, apiToken: rawToken, safeName, role });

            if (provisionResult.success && provisionResult.containerId) {
                await db.update(agents).set({
                    containerId: provisionResult.containerId,
                    containerName: provisionResult.containerName,
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
