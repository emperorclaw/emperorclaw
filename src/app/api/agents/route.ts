import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { agents, llmPricing } from "@/db/schema";
import { getCompanyId } from "@/lib/auth";
import { and, eq, isNull } from "drizzle-orm";
import { writeAgentMemory } from "@/lib/control-plane";
import { resolveAgentModelConfiguration } from "@/lib/agent-model-config";
import { encryptSecretPayload } from "@/lib/secrets";

export const dynamic = "force-dynamic";

export async function GET() {
    const companyId = await getCompanyId();
    if (!companyId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const allAgents = await db.select({
            id: agents.id,
            name: agents.name,
            avatarUrl: agents.avatarUrl,
        }).from(agents)
            .where(and(eq(agents.companyId, companyId), isNull(agents.deletedAt)));

        return NextResponse.json({ agents: allAgents });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Internal Server Error";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    const companyId = await getCompanyId();
    if (!companyId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const body = await req.json();
        const name = typeof body.name === "string" ? body.name.trim() : "";
        const role = typeof body.role === "string" ? body.role.trim() : "";
        const memory = typeof body.memory === "string" ? body.memory.trim() : "";
        const avatarUrl = typeof body.avatarUrl === "string" ? body.avatarUrl.trim() : "";
        const concurrencyLimit = Math.max(1, Number(body.concurrencyLimit) || 1);
        const provider = typeof body.provider === "string" ? body.provider : "mcp";
        const deploymentMode = typeof body.deploymentMode === "string" && body.deploymentMode === "local"
            ? "local"
            : "remote";
        const doctrineJson = body.doctrineJson && typeof body.doctrineJson === "object"
            ? body.doctrineJson
            : {};
        const monthlyBudgetCents = typeof body.monthlyBudgetCents === "number" && body.monthlyBudgetCents >= 0
            ? Math.round(body.monthlyBudgetCents)
            : 0;

        // LLM provider (metadata only — keys live in the runtime)
        const requestedLlmProvider = (typeof body.llmProvider === "string" &&
            ["openai", "anthropic", "google", "openrouter", "grok", "deepseek"].includes(body.llmProvider))
            ? body.llmProvider : null;
        const requestedLlmModel = typeof body.llmModel === "string" ? body.llmModel : null;

        if (!name) {
            return NextResponse.json({ error: "name is required" }, { status: 400 });
        }

        const llmApiKey = typeof body.llmApiKey === "string" ? body.llmApiKey.trim() : "";
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
            provider: requestedLlmProvider,
            model: requestedLlmModel,
            pricing,
        });

        const [agent] = await db.insert(agents).values({
            companyId,
            name,
            role: role || "operator",
            avatarUrl: avatarUrl || `https://api.dicebear.com/9.x/pixel-art/svg?seed=${encodeURIComponent(name)}`,
            skillsJson: Array.isArray(body.skillsJson) ? body.skillsJson : [],
            memory: memory || null,
            modelPolicyJson: body.modelPolicyJson && typeof body.modelPolicyJson === "object" ? body.modelPolicyJson : {},
            concurrencyLimit,
            provider,
            deploymentMode,
            doctrineJson,
            monthlyBudgetCents,
            monthlyTokenUsage: 0,
            budgetStatus: "active",
            status: "offline",
            currentLoad: 0,
            llmProvider: llmConfiguration.llmProvider,
            llmModel: llmConfiguration.llmModel,
            llmApiKeyEncrypted,
            llmApiKeyVersion,
        }).returning();

        if (memory) {
            await writeAgentMemory({
                companyId,
                agentId: agent.id,
                kind: "context",
                content: memory,
                summary: `Initial profile for ${name}`,
                snapshot: memory,
            });
        }

        const { llmApiKeyEncrypted: _redactedEncrypted, llmApiKeyVersion: _redactedVersion, ...safeAgent } = agent;
        void _redactedEncrypted;
        void _redactedVersion;

        return NextResponse.json({ agent: safeAgent }, { status: 201 });
    } catch (error: unknown) {
        console.error("Agent create error:", error);
        const message = error instanceof Error ? error.message : "Internal Server Error";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
