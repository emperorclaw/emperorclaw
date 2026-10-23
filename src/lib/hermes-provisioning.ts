import crypto from "crypto";
import fs from "fs";
import { and, eq, isNotNull, isNull, like, ne } from "drizzle-orm";
import pkg from "@/../package.json" assert { type: "json" };
import { db } from "@/db";
import { agents, companyTokens } from "@/db/schema";
import { decryptSecretPayload } from "@/lib/secrets";
import { hermesContainerName, hermesSafeName, hermesVolumeName } from "@/lib/hermes-names";
import { buildAgentInstructions } from "@/lib/agent-instructions";
import { HERMES_CONFIG_DEFAULTS_ENV, hermesConfigDefaultsEnvValue } from "@/lib/hermes-profile-defaults";
import {
    DOCKER_SOCKET,
    isDocker,
    dockerCall,
    dockerPull,
    dockerVolumeCreate,
    getOwnNetworkAndAppHostname,
    imageExists,
    removeContainer,
    startContainer,
    stopContainer,
    type ContainerMount,
} from "@/lib/docker";
import { imageRetryDelayMs, prefetchHermesImage, pullHermesImage, type DockerPullRecord } from "@/lib/hermes-image-prefetch";

export const HERMES_IMAGE_REPOSITORY = "ghcr.io/emperorclaw/emperorclaw-hermes";

/**
 * The managed runtime image is tagged with the Emperor release that ships it
 * (`v0.9.0`), never `:latest`: the bridge and the server speak one protocol
 * version, and a floating tag let Watchtower or a fresh pull mix them.
 */
export function hermesImageForVersion(version: string): string {
    const v = version.trim().replace(/^v/, "");
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(v)) {
        throw new Error(`Not a release version for the Hermes runtime image: "${version}"`);
    }
    return `${HERMES_IMAGE_REPOSITORY}:v${v}`;
}

// Overridable so a self-hoster (or a runtime-image change under test) can pin a
// locally built image instead of the published one. The app pulls whatever this
// names, so a local tag that does not exist in a registry falls back to the
// cached local image automatically.
const HERMES_IMAGE_OVERRIDE = process.env.EMPEROR_CLAW_HERMES_IMAGE?.trim() || null;

/** The runtime image this server provisions: its own release unless overridden. */
export const HERMES_IMAGE = HERMES_IMAGE_OVERRIDE || hermesImageForVersion(pkg.version);

// Published Hermes runtimes currently target amd64. Request that manifest
// explicitly on ARM hosts with Docker emulation enabled.
const HERMES_IMAGE_PLATFORM = "linux/amd64";

/** Pull through the shared single-flight pull, so a hire joins the boot prefetch. */
function pullHermesRuntimeImage(image: string): Promise<string> {
    return pullHermesImage(image, HERMES_IMAGE_PLATFORM, (name, platform, onRecord) =>
        dockerPull(name, platform, (record) => onRecord(record as DockerPullRecord)));
}


// Docker's default stop timeout (10 s) SIGKILLs a gateway mid-drain and leaves
// `unknown` turns behind. The gateway exits ~20 s after its drain
// (agent.restart_drain_timeout 30 → ~50.5 s measured), the in-container
// supervisor SIGKILLs it at 55 s, and 75 s leaves the bridge time to flush.
export const HERMES_STOP_TIMEOUT_SECONDS = 75;
// A warm gateway is ~300 MiB, the bridge ~50 MiB, and a browser tool session
// needs headroom on top.
const HERMES_MEMORY_BYTES = 1024 * 1024 * 1024;
const HERMES_NANO_CPUS = 1_500_000_000;

export type SetupOutput = { command: string; stdout: string; stderr: string; exitCode: number | null };

// Provider -> the env var the runtime looks for its LLM API key under. The
// entrypoint writes it into the profile .env, which wins over the process env.
const PROVIDER_ENV_VAR: Record<string, string> = {
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    google: "GOOGLE_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    grok: "GROK_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
};

type AgentRow = typeof agents.$inferSelect;

// Role doctrine for the bridge (env at start; read live by newer bridges).
export { buildAgentInstructions };

const SETUP_TOKEN_SUFFIX = "-local-setup";

/**
 * Factors out the token-mint-and-store logic previously inlined in
 * setup-local/route.ts: a raw bearer token handed to the agent runtime, only
 * its sha256 hash is ever persisted.
 */
export async function mintAgentSetupToken(companyId: string, safeName: string, agentId?: string | null): Promise<{ rawToken: string; tokenHash: string }> {
    const rawToken = `ec_${crypto.randomBytes(24).toString("hex")}`;
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    await db.insert(companyTokens).values({
        companyId,
        // Bind the runtime token to its agent so it cannot act as a sibling.
        agentId: agentId || null,
        tokenHash,
        name: `${safeName}${SETUP_TOKEN_SUFFIX}`,
        scope: "mcp_full",
    });
    return { rawToken, tokenHash };
}

/**
 * Revoke an agent's managed-runtime setup tokens. With `keepTokenHash`, every
 * one except that token (the one the new container holds): a recreated
 * container must not leave its predecessor's credential live. With
 * `onlyTokenHash`, just that token (a mint whose container never started).
 * Returns how many tokens were revoked.
 */
export async function revokeAgentSetupTokens(
    agentId: string,
    opts: { keepTokenHash?: string; onlyTokenHash?: string } = {},
): Promise<number> {
    const conditions = [
        eq(companyTokens.agentId, agentId),
        like(companyTokens.name, `%${SETUP_TOKEN_SUFFIX}`),
        isNull(companyTokens.revokedAt),
    ];
    if (opts.keepTokenHash) conditions.push(ne(companyTokens.tokenHash, opts.keepTokenHash));
    if (opts.onlyTokenHash) conditions.push(eq(companyTokens.tokenHash, opts.onlyTokenHash));
    const revoked = await db.update(companyTokens)
        .set({ revokedAt: new Date() })
        .where(and(...conditions))
        .returning({ id: companyTokens.id });
    return revoked.length;
}

export type ProvisionHermesContainerInput = {
    agent: AgentRow;
    apiToken: string;
    safeName: string;
    role: string;
    /** Runtime image to run. Defaults to HERMES_IMAGE (this release's pinned tag). */
    image?: string;
};

export type ProvisionHermesContainerResult = {
    success: boolean;
    message: string;
    outputs: SetupOutput[];
    containerId?: string;
    containerName?: string;
};

type CreateHermesContainerOpts = {
    image: string;
    name: string;
    env: string[];
    networkMode: string;
    mounts: ContainerMount[];
    agentId: string;
};

/**
 * Engine API create call for a managed runtime. Unlike the generic
 * createContainer() it sets StopTimeout (the drain chain needs 75 s) and
 * labels the container so Watchtower leaves it alone: managed runtimes are
 * pinned to the app's release and rolled by the app's own update.
 */
async function createHermesContainer(opts: CreateHermesContainerOpts): Promise<string> {
    const body = {
        Image: opts.image,
        Env: opts.env,
        StopSignal: "SIGTERM",
        StopTimeout: HERMES_STOP_TIMEOUT_SECONDS,
        Labels: {
            "org.emperorclaw.managed-runtime": "hermes",
            "org.emperorclaw.agent-id": opts.agentId,
            "com.centurylinklabs.watchtower.enable": "false",
        },
        HostConfig: {
            RestartPolicy: { Name: "unless-stopped" },
            NetworkMode: opts.networkMode,
            Memory: HERMES_MEMORY_BYTES,
            NanoCpus: HERMES_NANO_CPUS,
            Mounts: opts.mounts.map((mount) => ({
                Type: mount.type,
                Source: mount.source,
                Target: mount.target,
                ReadOnly: mount.readOnly ?? false,
            })),
        },
    };
    const { code, data } = await dockerCall("POST", `/containers/create?name=${encodeURIComponent(opts.name)}`, body);
    if (code !== 201) {
        throw new Error(`createContainer HTTP ${code}: ${JSON.stringify(data).slice(0, 200)}`);
    }
    return (data as { Id: string }).Id;
}

/**
 * Make `image` available locally. If the registry pull fails (no network,
 * transient registry hiccup, tag not published) fall back to a matching image
 * already cached locally — e.g. a self-hoster who built their own runtime
 * image, or this exact tag built locally before being pushed.
 */
async function ensureHermesImage(image: string, outputs: SetupOutput[]): Promise<{ ok: true } | { ok: false; message: string }> {
    try {
        const msg = await pullHermesRuntimeImage(image);
        outputs.push({ command: `docker pull ${image}`, stdout: msg, stderr: "", exitCode: 0 });
        return { ok: true };
    } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        const hasLocal = await imageExists(image).catch(() => false);
        if (hasLocal) {
            outputs.push({ command: `docker pull ${image}`, stdout: "", stderr: `Warning: pull failed (${msg}) — using image already cached locally`, exitCode: 0 });
            return { ok: true };
        }
        outputs.push({ command: `docker pull ${image}`, stdout: "", stderr: msg, exitCode: 1 });
        const hint = HERMES_IMAGE_OVERRIDE ? "" : " Runtime images are published per release; a development build needs EMPEROR_CLAW_HERMES_IMAGE pointing at a locally built image.";
        return { ok: false, message: `Image pull failed and no local copy of ${image} exists: ${msg}.${hint}` };
    }
}

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
    const image = input.image || HERMES_IMAGE;
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

        // 3. Pull the pinned Hermes runtime image (or use a local copy).
        const pulled = await ensureHermesImage(image, outputs);
        if (!pulled.ok) return { success: false, message: pulled.message, outputs };

        // 4. Build env + create + start the sibling container.
        const containerName = hermesContainerName(safeName, agent.id);
        const env = [
            `EMPEROR_CLAW_API_URL=${emperorUrl}`,
            `EMPEROR_CLAW_API_TOKEN=${apiToken}`,
            `EMPEROR_CLAW_AGENT_NAME=${safeName}`,
            `EMPEROR_CLAW_AGENT_ID=${agent.id}`,
            `EMPEROR_CLAW_AGENT_ROLE=${role}`,
            `EMPEROR_CLAW_RUNTIME_ID=hermes-${safeName}-${agent.id.slice(0, 8)}-1`,
            // Bridge 0.9 settings (design 5.7). The entrypoint also exports
            // EMPEROR_CLAW_HERMES_GATEWAY=managed; it is set here so the
            // container's own environment says what it is.
            `EMPEROR_CLAW_HERMES_GATEWAY=managed`,
            `EMPEROR_CLAW_HERMES_TOOLSETS=emperor-claw,web,terminal,code_execution`,
            `EMPEROR_CLAW_HERMES_TURN_TIMEOUT_SECONDS=0`,
            `EMPEROR_CLAW_HERMES_TURN_IDLE_TIMEOUT_SECONDS=900`,
            // Profile config.yaml defaults. entrypoint.sh applies each
            // `key=value` line on every start (then hard-applies the gateway
            // topology keys), so recreates re-apply them idempotently. See
            // hermes-profile-defaults.ts for why each key is set.
            `${HERMES_CONFIG_DEFAULTS_ENV}=${hermesConfigDefaultsEnvValue()}`,
        ];
        const agentInstructions = buildAgentInstructions(agent.doctrineJson);
        if (agentInstructions) {
            env.push(`EMPEROR_CLAW_AGENT_INSTRUCTIONS=${agentInstructions}`);
        }
        // Tells entrypoint.sh which provider/model to configure the profile
        // for — a cloned profile otherwise inherits whatever the base image's
        // default profile has, regardless of the key we inject.
        if (agent.llmProvider) {
            env.push(`EMPEROR_CLAW_LLM_PROVIDER=${agent.llmProvider}`);
        }
        if (agent.llmModel) {
            env.push(`EMPEROR_CLAW_LLM_MODEL=${agent.llmModel}`);
        }
        if (llmApiKeyEnv && llmApiKeyValue) {
            env.push(`${llmApiKeyEnv}=${llmApiKeyValue}`);
        }

        // Persist the agent's Hermes profile (state.db sessions, config, the
        // bridge's <profile>/emperor/ state) across container recreates
        // (recreate-runtime, image updates). A named volume survives
        // `docker rm`, so a recreated container keeps its `seen`/`lastSeenAt`
        // state instead of re-offering and re-running stale turns. If the
        // volume cannot be created we degrade to an ephemeral home with a
        // warning rather than failing provisioning.
        const volumeName = hermesVolumeName(safeName, agent.id);
        let mounts: ContainerMount[] = [];
        try {
            await dockerVolumeCreate(volumeName);
            mounts = [{ type: "volume", source: volumeName, target: "/home/hermes/.hermes/profiles" }];
            // Where bridge 0.3 kept its (v1) state on this volume. Bridge 0.9
            // keeps v2 state per profile and imports this file once.
            env.push(`EMPEROR_CLAW_HERMES_STATE_PATH=/home/hermes/.hermes/profiles/emperor-bridge-state.json`);
            outputs.push({ command: `docker volume ensure ${volumeName}`, stdout: "Ready", stderr: "", exitCode: 0 });
        } catch (err) {
            const msg = err instanceof Error ? err.message : "Unknown error";
            outputs.push({ command: `docker volume ensure ${volumeName}`, stdout: "", stderr: `Warning: ${msg} — Hermes home will not persist across recreates`, exitCode: 0 });
        }

        let containerId: string;
        try {
            containerId = await createHermesContainer({
                image,
                name: containerName,
                env,
                networkMode,
                mounts,
                agentId: agent.id,
            });
            outputs.push({ command: `docker create ${containerName} (${image})`, stdout: containerId.slice(0, 12), stderr: "", exitCode: 0 });
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
 * sibling container (best-effort), re-provision from the current DB row with
 * a fresh setup token, then revoke the previous container's token. Backs the
 * standalone recreate-runtime route AND the Hermes-image-update step in the
 * self-update flow (ops/update/route.ts) — one code path, not duplicated
 * orchestration logic.
 *
 * The stop waits up to HERMES_STOP_TIMEOUT_SECONDS so in-flight turns drain
 * instead of ending `unknown`.
 */
export async function recreateHermesContainer(
    agentId: string,
    opts: { image?: string } = {},
): Promise<ProvisionHermesContainerResult> {
    const [agent] = await db.select().from(agents).where(
        and(eq(agents.id, agentId), isNull(agents.deletedAt))
    ).limit(1);

    if (!agent) {
        return { success: false, message: "Agent not found", outputs: [] };
    }

    const outputs: SetupOutput[] = [];
    const image = opts.image || HERMES_IMAGE;

    // Pull BEFORE touching the running container: if the image is not
    // available, the agent keeps its current runtime instead of losing it.
    const pulled = await ensureHermesImage(image, outputs);
    if (!pulled.ok) {
        return { success: false, message: `${pulled.message} The current runtime was left running.`, outputs };
    }

    // Revoke the old container's token only once that container is known to be
    // gone; otherwise a still-running predecessor would lose its credential
    // while the replacement failed to take over.
    let previousGone = true;

    if (agent.containerId) {
        try {
            await stopContainer(agent.containerId, HERMES_STOP_TIMEOUT_SECONDS);
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
            // removeContainer() already treats 404 as success; a manually removed
            // container must still count as gone so its token gets revoked.
            previousGone = /\b404\b|No such container/i.test(msg);
            outputs.push({ command: `docker rm ${agent.containerId.slice(0, 12)}`, stdout: "", stderr: `Warning: ${msg}`, exitCode: 0 });
        }
    }

    const safeName = hermesSafeName(agent.name);
    const role = agent.role || "operator";
    const { rawToken, tokenHash } = await mintAgentSetupToken(agent.companyId, safeName, agent.id);

    const result = await provisionHermesContainer({ agent, apiToken: rawToken, safeName, role, image });
    result.outputs = [...outputs, ...result.outputs];

    try {
        let revoked = 0;
        if (!result.success) {
            revoked = await revokeAgentSetupTokens(agent.id, { onlyTokenHash: tokenHash });
        } else if (previousGone) {
            revoked = await revokeAgentSetupTokens(agent.id, { keepTokenHash: tokenHash });
        }
        const what = result.success ? "previous runtime token(s)" : "unused new runtime token";
        result.outputs.push({ command: "revoke-runtime-tokens", stdout: `Revoked ${revoked} ${what}`, stderr: "", exitCode: 0 });
    } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        result.outputs.push({ command: "revoke-runtime-tokens", stdout: "", stderr: `Warning: ${msg}`, exitCode: 0 });
    }

    if (result.success && result.containerId) {
        await db.update(agents).set({
            containerId: result.containerId,
            containerName: result.containerName,
            // Container start is not a runtime heartbeat. Keep onboarding and
            // chat readiness honest until Hermes itself checks in.
            status: "offline",
        }).where(eq(agents.id, agentId));
    }

    return result;
}

// ---- Startup reconciler: roll managed runtimes onto this release's image ----

const RECONCILE_DELAY_MS = 30_000;
let reconcileStarted = false;

export type ReconcileResult = { checked: number; recreated: number; failed: number; skipped: string | null };

function reconcileLog(message: string): void {
    console.log(`[hermes-reconcile] ${message}`);
}

/**
 * Recreate every managed Hermes container whose image is not this release's
 * pinned runtime image (HERMES_IMAGE). Idempotent: containers already on the
 * image are left alone, so running it on every boot is a no-op once rolled.
 * Serial (one agent at a time) and fail-open per agent. The image is pulled
 * once up front; if it is unavailable, nothing is touched.
 */
export async function reconcileManagedHermesRuntimes(): Promise<ReconcileResult> {
    const result: ReconcileResult = { checked: 0, recreated: 0, failed: 0, skipped: null };
    if (!isDocker() || !fs.existsSync(DOCKER_SOCKET)) {
        result.skipped = "no Docker socket";
        return result;
    }
    const managed = await db.select({ id: agents.id, name: agents.name, containerId: agents.containerId })
        .from(agents)
        .where(and(
            isNull(agents.deletedAt),
            isNotNull(agents.containerId),
            eq(agents.provider, "hermes"),
            eq(agents.deploymentMode, "local"),
        ));
    const stale: typeof managed = [];
    for (const agent of managed) {
        result.checked += 1;
        try {
            const { code, data } = await dockerCall("GET", `/containers/${agent.containerId}/json`);
            // A missing container is left to Recreate Runtime: the operator may have removed it.
            if (code !== 200) continue;
            const current = (data as { Config?: { Image?: string } }).Config?.Image;
            if (current !== HERMES_IMAGE) stale.push(agent);
        } catch (err) {
            reconcileLog(`inspect ${agent.name} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    if (stale.length === 0) {
        reconcileLog(`${result.checked} managed runtime(s) already on ${HERMES_IMAGE}`);
        return result;
    }
    const pulled = await ensureHermesImage(HERMES_IMAGE, []);
    if (!pulled.ok) {
        result.skipped = pulled.message;
        reconcileLog(`not rolling ${stale.length} runtime(s): ${pulled.message}`);
        return result;
    }
    for (const agent of stale) {
        reconcileLog(`recreating ${agent.name} on ${HERMES_IMAGE}`);
        try {
            const recreated = await recreateHermesContainer(agent.id, { image: HERMES_IMAGE });
            if (recreated.success) result.recreated += 1;
            else result.failed += 1;
            reconcileLog(`${agent.name}: ${recreated.success ? "ok" : "failed"}: ${recreated.message}`);
        } catch (err) {
            result.failed += 1;
            reconcileLog(`${agent.name}: failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    reconcileLog(`done: ${result.recreated} recreated, ${result.failed} failed, ${result.checked} checked`);
    return result;
}

/**
 * Schedule reconcileManagedHermesRuntimes() once per process, in the
 * background, after a short delay so it never competes with startup or blocks
 * a request. Call it from the server's boot path (src/instrumentation.ts).
 * EMPEROR_CLAW_HERMES_RECONCILE=0 turns it off.
 */
export function startManagedHermesReconciler(delayMs = RECONCILE_DELAY_MS): void {
    if (reconcileStarted || process.env.EMPEROR_CLAW_HERMES_RECONCILE === "0") return;
    reconcileStarted = true;
    let attempt = 0;
    const run = async () => {
        let imageMissing = false;
        try {
            const result = await reconcileManagedHermesRuntimes();
            imageMissing = result.skipped !== null && result.skipped !== "no Docker socket";
        } catch (err) {
            reconcileLog(`aborted: ${err instanceof Error ? err.message : String(err)}`);
        }
        // The runtime image may not be published yet when the app updates first.
        const retryIn = imageMissing ? imageRetryDelayMs(++attempt) : null;
        if (retryIn !== null) {
            reconcileLog(`retrying in ${Math.round(retryIn / 60_000)} min`);
            setTimeout(run, retryIn).unref?.();
        }
    };
    setTimeout(run, delayMs).unref?.();
}

/**
 * Start downloading this release's runtime image in the background on boot,
 * so the first hire does not wait on a ~3.8 GB pull. Provisioning joins the
 * same pull. Skipped without a Docker socket or with EMPEROR_HERMES_PREFETCH=0.
 */
export function startHermesImagePrefetch(): void {
    if (process.env.EMPEROR_HERMES_PREFETCH === "0") return;
    if (!isDocker() || !fs.existsSync(DOCKER_SOCKET)) return;
    let attempt = 0;
    const run = async () => {
        const ready = await prefetchHermesImage({
            image: HERMES_IMAGE,
            platform: HERMES_IMAGE_PLATFORM,
            pull: (name, platform, onRecord) => dockerPull(name, platform, (record) => onRecord(record as DockerPullRecord)),
            imageExists,
        });
        // The runtime image may not be published yet when the app updates first.
        const retryIn = ready ? null : imageRetryDelayMs(++attempt);
        if (retryIn !== null) setTimeout(() => void run(), retryIn).unref?.();
    };
    void run();
}
