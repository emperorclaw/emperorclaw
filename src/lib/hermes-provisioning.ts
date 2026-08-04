import crypto from "crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { agents, companyTokens } from "@/db/schema";
import { decryptSecretPayload } from "@/lib/secrets";
import {
    createContainer,
    dockerPull,
    getOwnNetworkAndAppHostname,
    imageExists,
    removeContainer,
    startContainer,
    stopContainer,
} from "@/lib/docker";

export const HERMES_IMAGE = "ghcr.io/emperorclaw/emperorclaw-hermes:latest";

export type SetupOutput = { command: string; stdout: string; stderr: string; exitCode: number | null };

// Mirrors emperor_hermes_bridge.py:105-112 — provider -> the env var the
// bridge/runtime looks for its LLM API key under.
const PROVIDER_ENV_VAR: Record<string, string> = {
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    google: "GOOGLE_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    grok: "GROK_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
};

type AgentRow = typeof agents.$inferSelect;

/**
 * Factors out the token-mint-and-store logic previously inlined in
 * setup-local/route.ts: a raw bearer token handed to the agent runtime, only
 * its sha256 hash is ever persisted.
 */
export async function mintAgentSetupToken(companyId: string, safeName: string): Promise<{ rawToken: string }> {
    const rawToken = `ec_${crypto.randomBytes(24).toString("hex")}`;
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    await db.insert(companyTokens).values({
        companyId,
        tokenHash,
        name: `${safeName}-local-setup`,
        scope: "mcp_full",
    });
    return { rawToken };
}

export type ProvisionHermesContainerInput = {
    agent: AgentRow;
    apiToken: string;
    safeName: string;
    role: string;
};

export type ProvisionHermesContainerResult = {
    success: boolean;
    message: string;
    outputs: SetupOutput[];
    containerId?: string;
    containerName?: string;
};

/**
 * Pure Docker-orchestration function: builds and starts a sibling Hermes
 * container for an agent from the agent's *current* DB row. Does NOT write
 * to the DB itself — callers persist containerId/containerName/status after
 * a successful result.
 *
 * Designed to be fully re-runnable: creation, image updates, key rotation,
 * and crash repair all funnel through this same function (stop+remove the
 * old container, then call this again).
 */
export async function provisionHermesContainer(
    input: ProvisionHermesContainerInput
): Promise<ProvisionHermesContainerResult> {
    const { agent, apiToken, safeName, role } = input;
    const outputs: SetupOutput[] = [];

    try {
        // 1. Resolve LLM API key + provider env var (never throws — degrades
        // to "no key" with a warning line so the agent still gets created).
        let llmApiKeyEnv: string | null = null;
        let llmApiKeyValue: string | null = null;

        if (agent.llmApiKeyEncrypted) {
            try {
                const decrypted = decryptSecretPayload(agent.llmApiKeyEncrypted) as { apiKey?: string };
                if (decrypted?.apiKey) {
                    llmApiKeyValue = decrypted.apiKey;
                } else {
                    outputs.push({ command: "decrypt-llm-key", stdout: "", stderr: "Warning: stored key payload had no apiKey field", exitCode: 0 });
                }
            } catch (err) {
                const msg = err instanceof Error ? err.message : "Unknown error";
                outputs.push({ command: "decrypt-llm-key", stdout: "", stderr: `Warning: failed to decrypt LLM API key: ${msg}`, exitCode: 0 });
            }
        } else {
            outputs.push({ command: "decrypt-llm-key", stdout: "No LLM API key provided — the agent will be created but the bridge cannot call the LLM until a key is set (see key rotation / recreate-runtime).", stderr: "", exitCode: 0 });
        }

        if (llmApiKeyValue) {
            const envVarName = agent.llmProvider ? PROVIDER_ENV_VAR[agent.llmProvider] : undefined;
            if (envVarName) {
                llmApiKeyEnv = envVarName;
            } else {
                outputs.push({ command: "resolve-llm-provider", stdout: "", stderr: `Warning: llmProvider "${agent.llmProvider ?? ""}" is unset or unrecognized — the decrypted key will not be injected`, exitCode: 0 });
            }
        }

        // 2. Reachability probe: prefer container-network hostname, fall back
        // to the public URL with a warning if the probe fails.
        const { networkMode, appHostname, appPort } = await getOwnNetworkAndAppHostname();
        let emperorUrl = `http://${appHostname}:${appPort}`;
        try {
            const res = await fetch(`${emperorUrl}/api/health`, { signal: AbortSignal.timeout(3000) });
            outputs.push({ command: `probe ${emperorUrl}/api/health`, stdout: `HTTP ${res.status}`, stderr: "", exitCode: res.ok ? 0 : 1 });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
        } catch (err) {
            const msg = err instanceof Error ? err.message : "Unknown error";
            const fallback = process.env.NEXTAUTH_URL || "http://localhost:3000";
            outputs.push({ command: `probe ${emperorUrl}/api/health`, stdout: "", stderr: `Warning: reachability probe failed (${msg}) — falling back to ${fallback}`, exitCode: 0 });
            emperorUrl = fallback;
        }

        // 3. Pull the Hermes runtime image. If the registry pull fails (no
        // network, image not yet published, transient registry hiccup) fall
        // back to a matching image already cached locally — e.g. a
        // self-hoster who built their own hermes-runtime image, or this
        // exact tag built locally before ever being pushed to GHCR.
        try {
            const msg = await dockerPull(HERMES_IMAGE);
            outputs.push({ command: `docker pull ${HERMES_IMAGE}`, stdout: msg, stderr: "", exitCode: 0 });
        } catch (err) {
            const msg = err instanceof Error ? err.message : "Unknown error";
            const hasLocal = await imageExists(HERMES_IMAGE).catch(() => false);
            if (hasLocal) {
                outputs.push({ command: `docker pull ${HERMES_IMAGE}`, stdout: "", stderr: `Warning: pull failed (${msg}) — using image already cached locally`, exitCode: 0 });
            } else {
                outputs.push({ command: `docker pull ${HERMES_IMAGE}`, stdout: "", stderr: msg, exitCode: 1 });
                return { success: false, message: `Image pull failed and no local copy of ${HERMES_IMAGE} exists: ${msg}`, outputs };
            }
        }

        // 4. Build env + create + start the sibling container.
        const containerName = `emperor-hermes-${safeName}-${agent.id.slice(0, 8)}`;
        const env = [
            `EMPEROR_CLAW_API_URL=${emperorUrl}`,
            `EMPEROR_CLAW_API_TOKEN=${apiToken}`,
            `EMPEROR_CLAW_AGENT_NAME=${safeName}`,
            `EMPEROR_CLAW_AGENT_ID=${agent.id}`,
            `EMPEROR_CLAW_AGENT_ROLE=${role}`,
            `EMPEROR_CLAW_RUNTIME_ID=hermes-${safeName}-${agent.id.slice(0, 8)}-1`,
            `EMPEROR_CLAW_HERMES_POLL_SECONDS=5`,
            `EMPEROR_CLAW_HERMES_TIMEOUT_SECONDS=300`,
            `HERMES_BIN=hermes`,
            `HERMES_TOOLSETS=emperor-claw,web,terminal,code_execution`,
        ];
        // Tells entrypoint.sh which provider/model to actually configure the
        // cloned profile for (hermes config set model.provider/...) — the
        // profile otherwise inherits whatever the base image's default
        // profile has (observed: OpenRouter), regardless of the key we inject.
        if (agent.llmProvider) {
            env.push(`EMPEROR_CLAW_LLM_PROVIDER=${agent.llmProvider}`);
        }
        if (agent.llmModel) {
            env.push(`EMPEROR_CLAW_LLM_MODEL=${agent.llmModel}`);
        }
        if (llmApiKeyEnv && llmApiKeyValue) {
            env.push(`${llmApiKeyEnv}=${llmApiKeyValue}`);
        }

        let containerId: string;
        try {
            containerId = await createContainer({
                image: HERMES_IMAGE,
                name: containerName,
                env,
                networkMode,
                restartPolicy: { Name: "unless-stopped" },
                memoryBytes: 512 * 1024 * 1024,
                nanoCpus: 1_000_000_000,
            });
            outputs.push({ command: `docker create ${containerName}`, stdout: containerId.slice(0, 12), stderr: "", exitCode: 0 });
        } catch (err) {
            const msg = err instanceof Error ? err.message : "Unknown error";
            outputs.push({ command: `docker create ${containerName}`, stdout: "", stderr: msg, exitCode: 1 });
            return { success: false, message: `Container create failed: ${msg}`, outputs };
        }

        try {
            await startContainer(containerId);
            outputs.push({ command: `docker start ${containerId.slice(0, 12)}`, stdout: "Started", stderr: "", exitCode: 0 });
        } catch (err) {
            const msg = err instanceof Error ? err.message : "Unknown error";
            outputs.push({ command: `docker start ${containerId.slice(0, 12)}`, stdout: "", stderr: msg, exitCode: 1 });
            return { success: false, message: `Container start failed: ${msg}`, outputs };
        }

        return {
            success: true,
            message: `${agent.name} is LIVE! Hermes sibling container running.`,
            outputs,
            containerId,
            containerName,
        };
    } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        outputs.push({ command: "provisionHermesContainer", stdout: "", stderr: msg, exitCode: 1 });
        return { success: false, message: `Provisioning failed: ${msg}`, outputs };
    }
}

/**
 * Shared "recreate this agent's runtime" primitive: stop+remove any existing
 * sibling container (best-effort), then re-provision from the current DB
 * row. Backs the standalone recreate-runtime route AND the Hermes-image-
 * update step in the self-update flow (ops/update/route.ts) — one code
 * path, not duplicated orchestration logic.
 */
export async function recreateHermesContainer(agentId: string): Promise<ProvisionHermesContainerResult> {
    const [agent] = await db.select().from(agents).where(
        and(eq(agents.id, agentId), isNull(agents.deletedAt))
    ).limit(1);

    if (!agent) {
        return { success: false, message: "Agent not found", outputs: [] };
    }

    const outputs: SetupOutput[] = [];

    if (agent.containerId) {
        try {
            await stopContainer(agent.containerId);
            outputs.push({ command: `docker stop ${agent.containerId.slice(0, 12)}`, stdout: "Stopped", stderr: "", exitCode: 0 });
        } catch (err) {
            const msg = err instanceof Error ? err.message : "Unknown error";
            outputs.push({ command: `docker stop ${agent.containerId.slice(0, 12)}`, stdout: "", stderr: `Warning: ${msg}`, exitCode: 0 });
        }
        try {
            await removeContainer(agent.containerId, true);
            outputs.push({ command: `docker rm ${agent.containerId.slice(0, 12)}`, stdout: "Removed", stderr: "", exitCode: 0 });
        } catch (err) {
            const msg = err instanceof Error ? err.message : "Unknown error";
            outputs.push({ command: `docker rm ${agent.containerId.slice(0, 12)}`, stdout: "", stderr: `Warning: ${msg}`, exitCode: 0 });
        }
    }

    const safeName = agent.name.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
    const role = agent.role || "operator";
    const { rawToken } = await mintAgentSetupToken(agent.companyId, safeName);

    const result = await provisionHermesContainer({ agent, apiToken: rawToken, safeName, role });
    result.outputs = [...outputs, ...result.outputs];

    if (result.success && result.containerId) {
        await db.update(agents).set({
            containerId: result.containerId,
            containerName: result.containerName,
            status: "online",
            lastSeenAt: new Date(),
        }).where(eq(agents.id, agentId));
    }

    return result;
}
