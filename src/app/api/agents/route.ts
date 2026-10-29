import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { agents, llmPricing } from "@/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { writeAgentMemory } from "@/lib/control-plane";
import { resolveAgentModelConfiguration } from "@/lib/agent-model-config";
import { encryptSecretPayload } from "@/lib/secrets";
import { checkLlmModelName } from "@/lib/llm-endpoint";
import { legacyAvatarToAppearance, normalizeAppearance, resolveAvatarPhoto } from "@/lib/character/model";
import { companyRouteAccess } from "@/lib/company-access";
import { humanActor, recordAudit } from "@/lib/audit";
import { lengthError, NAME_MAX } from "@/lib/input-limits";
import { memberAgentCondition } from "@/lib/member-scope";
import { agentsNotUsableBy, applyHireAccess, ownerNames, usableAgentCondition } from "@/lib/agent-access-server";
import { canAdmin } from "@/lib/role-matrix";
import { HostJobError, checkHostedHire, queueAgentProvision, type HostedHireChoice } from "@/lib/runtime-hosts/agent-jobs";
import { deleteAgentAndData } from "@/lib/agent-deletion";

export const dynamic = "force-dynamic";

export async function GET() {
    const access = await companyRouteAccess("viewer");
    if (access.response) return access.response;
    const companyId = access.ctx.companyId;

    try {
        // Agents limited to other people (0.20): hidden from members, a locked
        // card (metadata) for owners and admins.
        const { hidden, metadata } = await agentsNotUsableBy(access.ctx);
        const allAgents = await db.select({
            id: agents.id,
            name: agents.name,
            role: agents.role,
            avatarUrl: agents.avatarUrl,
            avatarAppearance: agents.avatarAppearance,
            status: agents.status,
            lastSeenAt: agents.lastSeenAt,
            createdAt: agents.createdAt,
            access: agents.access,
            ownerUserId: agents.ownerUserId,
        }).from(agents)
            .where(and(eq(agents.companyId, companyId), isNull(agents.deletedAt), memberAgentCondition(access.ctx.scope, agents.id),
                canAdmin(access.ctx.role) ? undefined : usableAgentCondition(hidden, agents.id)));
        const owners = await ownerNames(allAgents.filter((a) => a.access !== "everyone").map((a) => a.ownerUserId));

        return NextResponse.json({
            agents: allAgents.map((agent) => ({
                ...agent,
                ownerName: agent.ownerUserId ? owners.get(agent.ownerUserId) ?? null : null,
                use: metadata.has(agent.id) ? "metadata" : "full",
            })),
        });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Internal Server Error";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    const access = await companyRouteAccess("member");
    if (access.response) return access.response;
    const companyId = access.ctx.companyId;

    try {
        const body = await req.json();
        const name = typeof body.name === "string" ? body.name.trim() : "";
        const role = typeof body.role === "string" ? body.role.trim() : "";
        const memory = typeof body.memory === "string" ? body.memory.trim() : "";
        const avatarUrl = typeof body.avatarUrl === "string" ? body.avatarUrl.trim() : "";
        const requestedAppearance = body.avatarAppearance === undefined ? undefined : normalizeAppearance(body.avatarAppearance);
        if (body.avatarAppearance !== undefined && !requestedAppearance) {
            return NextResponse.json({ error: "avatarAppearance is not a valid character appearance" }, { status: 400 });
        }
        const concurrencyLimit = Math.max(1, Number(body.concurrencyLimit) || 1);
        // On a runtime host (0.22): Emperor sets the agent up there (Hermes, remote).
        const onHost = body.runtimeHostId !== undefined && body.runtimeHostId !== null && body.runtimeHostId !== "";
        if (onHost && !canAdmin(access.ctx.role)) {
            return NextResponse.json({ error: "Only owners and admins can set up an agent on a host" }, { status: 403 });
        }
        const provider = onHost ? "hermes" : typeof body.provider === "string" ? body.provider : "mcp";
        const deploymentMode = !onHost && typeof body.deploymentMode === "string" && body.deploymentMode === "local"
            ? "local"
            : "remote";
        if (deploymentMode === "local" && provider !== "hermes") {
            return NextResponse.json({ error: "Only Hermes supports local deployment" }, { status: 400 });
        }
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
        const checkedModel = checkLlmModelName(body.llmModel);
        if (!checkedModel.ok) return NextResponse.json({ error: checkedModel.error }, { status: 400 });
        const requestedLlmModel = checkedModel.model || null;

        if (!name) {
            return NextResponse.json({ error: "name is required" }, { status: 400 });
        }
        const nameTooLong = lengthError("name", name, NAME_MAX);
        if (nameTooLong) return NextResponse.json({ error: nameTooLong }, { status: 400 });

        let hosted: HostedHireChoice | null = null;
        if (onHost) {
            try {
                hosted = await checkHostedHire(companyId, {
                    runtimeHostId: body.runtimeHostId, llmProvider: body.llmProvider, model: body.model ?? body.llmModel, name,
                });
            } catch (error) {
                if (error instanceof HostJobError) return NextResponse.json({ error: error.message }, { status: error.status });
                throw error;
            }
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
        const llmConfiguration = hosted
            ? { llmProvider: hosted.llmProvider, llmModel: hosted.model }
            : resolveAgentModelConfiguration({
                current: { llmProvider: null, llmModel: null },
                provider: requestedLlmProvider,
                model: requestedLlmModel,
                pricing,
            });

        const legacyAppearance = legacyAvatarToAppearance(avatarUrl);
        const avatarAppearance = requestedAppearance ?? legacyAppearance ?? null;
        const resolvedAvatarUrl = avatarAppearance ? null : resolveAvatarPhoto({ avatarUrl: avatarUrl || null });

        const [agent] = await db.insert(agents).values({
            companyId,
            name,
            role: role || "operator",
            avatarUrl: resolvedAvatarUrl,
            avatarAppearance,
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

        await recordAudit({ companyId, actor: humanActor(access.ctx.userId), action: "agent.created", target: { type: "agent", id: agent.id }, after: agent });
        // Who can use it (0.20): the hirer owns it; "Specific people" / "Only ..." limit it now.
        const accessError = await applyHireAccess(access.ctx, agent.id, body);
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

        // On a host: queue its setup there (idempotency key = the agent id). When that fails the hire is
        // undone (the agent is deleted again), so nothing is left half linked: the admin just hires again.
        let hostJob: { jobId: string; hostId: string; hostName: string } | null = null;
        if (hosted) {
            try {
                const job = await queueAgentProvision({
                    companyId, userId: access.ctx.userId, agent: { id: agent.id, name: agent.name }, choice: hosted, idempotencyKey: agent.id,
                });
                hostJob = { jobId: job.id, hostId: hosted.host.id, hostName: hosted.host.name };
            } catch (error) {
                console.error("Hosted hire: queueing the setup failed:", error);
                await deleteAgentAndData({ companyId, agentId: agent.id, actorType: "system", actorId: null }).catch(() => null);
                const message = error instanceof Error ? error.message : "Could not queue the setup on the host";
                return NextResponse.json({ error: `Could not set ${agent.name} up on ${hosted.host.name}: ${message}` },
                    { status: error instanceof HostJobError ? error.status : 500 });
            }
        }

        const { llmApiKeyEncrypted: _redactedEncrypted, llmApiKeyVersion: _redactedVersion, ...safeAgent } = agent;
        void _redactedEncrypted;
        void _redactedVersion;

        return NextResponse.json({
            agent: safeAgent,
            ...(accessError ? { accessError } : {}),
            ...(hostJob ? { jobId: hostJob.jobId, runtimeHost: { id: hostJob.hostId, name: hostJob.hostName } } : {}),
        }, { status: 201 });
    } catch (error: unknown) {
        console.error("Agent create error:", error);
        const message = error instanceof Error ? error.message : "Internal Server Error";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
