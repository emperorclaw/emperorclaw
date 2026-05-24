import fs from "node:fs";
import path from "node:path";
import { loadManifests } from "../state/manifests.js";
import { loadThreadOwners } from "../state/thread-owners.js";
import { serviceIsActive, fallbackLogExists } from "../runtime/services.js";
import { BRIDGE_CONTRACT_VERSION, getMissingBridgeCapabilities, hasRequiredThreadPolicy } from "../bridge/contract.js";
import { inspectTrackedManifestUpgrades } from "../state/normalize.js";
import { loadLocalConfig } from "./config.js";
import { inspectOpenClawProfileConfig, resolveOpenClawConfigPath } from "./openclaw-profile.js";
const DEFAULT_EMPEROR_API_URL = "https://emperorclaw.malecu.eu";
function readBridgeUpdatedAt(bridgeStatePath) {
    if (!fs.existsSync(bridgeStatePath))
        return null;
    try {
        const payload = JSON.parse(fs.readFileSync(bridgeStatePath, "utf8"));
        const updatedAt = payload?.updatedAt;
        if (!updatedAt)
            return null;
        const updatedMs = new Date(updatedAt).getTime();
        return Number.isFinite(updatedMs) ? updatedMs : null;
    }
    catch {
        return null;
    }
}
async function checkSystemdService(serviceName, bridgeStatePath) {
    if (process.platform === "win32") {
        const updatedMs = readBridgeUpdatedAt(bridgeStatePath);
        if (updatedMs) {
            const ageSec = Math.max(0, Math.round((Date.now() - updatedMs) / 1000));
            return {
                name: "service",
                ok: ageSec < 600,
                detail: ageSec < 600
                    ? `fallback bridge active on win32; bridge state updated ${ageSec}s ago`
                    : `fallback bridge stale on win32; bridge state updated ${ageSec}s ago`
            };
        }
        return {
            name: "service",
            ok: false,
            detail: "win32 bridge fallback has no bridge-state heartbeat yet"
        };
    }
    const active = await serviceIsActive(serviceName);
    return { name: "service", ok: active, detail: active ? `${serviceName} active` : `${serviceName} inactive or unavailable` };
}
function checkManifestConsistency(manifest) {
    const expectedService = `${manifest.serviceName}`;
    const hasRuntimeId = Boolean(manifest.runtimeId && String(manifest.runtimeId || "").trim());
    return {
        name: "manifestConsistency",
        ok: hasRuntimeId && expectedService.endsWith('.service'),
        detail: hasRuntimeId
            ? `service=${expectedService}, runtimeId=${manifest.runtimeId}`
            : `manifest missing runtimeId or invalid service name`
    };
}
function checkThreadPolicy(manifest) {
    const ok = hasRequiredThreadPolicy(manifest.threadPolicy);
    return {
        name: "threadPolicy",
        ok,
        detail: ok
            ? `direct=${manifest.threadPolicy?.direct}, team=${manifest.threadPolicy?.team}, delegation=${manifest.threadPolicy?.delegation}`
            : "manifest is missing the required direct/team/delegation routing policy"
    };
}
function checkDoctrineResource(manifest) {
    const sharedIds = Array.isArray(manifest.sharedDoctrineResourceIds)
        ? manifest.sharedDoctrineResourceIds.map((value) => String(value || "").trim()).filter(Boolean)
        : [];
    const legacyId = String(manifest.doctrineResourceId || "").trim();
    const ids = sharedIds.length > 0 ? sharedIds : legacyId ? [legacyId] : [];
    return {
        name: "doctrineResource",
        ok: ids.length >= 2,
        detail: ids.length >= 2
            ? `shared doctrine resources tracked: ${ids.join(", ")}`
            : ids.length === 1
                ? `only one doctrine resource is tracked (${ids[0]}); expected the shared operating doctrine and shared operator manual`
                : "manifest is missing the seeded shared doctrine resource ids"
    };
}
function checkBridgeContract(manifest) {
    if (!manifest.bridgeContract) {
        return {
            name: "bridgeContract",
            ok: false,
            detail: "manifest is missing plugin-owned bridge contract metadata"
        };
    }
    const missing = getMissingBridgeCapabilities(manifest.bridgeContract);
    const versionOk = manifest.bridgeContract.version === BRIDGE_CONTRACT_VERSION;
    const transportOk = manifest.bridgeContract.messageTransport?.realtime === "websocket"
        && manifest.bridgeContract.messageTransport?.fallback === "sync";
    const truthOk = manifest.bridgeContract.taskTruth === "claim-note-checkpoint-result";
    const ok = versionOk && transportOk && truthOk && missing.length === 0;
    return {
        name: "bridgeContract",
        ok,
        detail: ok
            ? `version=${manifest.bridgeContract.version}, capabilities=${manifest.bridgeContract.capabilities.length}`
            : `version=${manifest.bridgeContract.version || "missing"}, transport=${JSON.stringify(manifest.bridgeContract.messageTransport || null)}, missingCapabilities=${missing.join(", ") || "none"}, taskTruth=${manifest.bridgeContract.taskTruth || "missing"}`
    };
}
function checkBridgeFreshness(bridgeStatePath) {
    if (!fs.existsSync(bridgeStatePath)) {
        return { name: "bridgeFreshness", ok: false, detail: `${bridgeStatePath} missing` };
    }
    try {
        const updatedMs = readBridgeUpdatedAt(bridgeStatePath);
        if (!updatedMs) {
            return { name: "bridgeFreshness", ok: false, detail: "bridge state has no updatedAt" };
        }
        const ageSec = Math.max(0, Math.round((Date.now() - updatedMs) / 1000));
        return {
            name: "bridgeFreshness",
            ok: ageSec < 600,
            detail: `bridge state updated ${ageSec}s ago`
        };
    }
    catch (error) {
        return { name: "bridgeFreshness", ok: false, detail: `bridge state parse failed: ${error?.message || error}` };
    }
}
function checkPath(name, filePath) {
    return {
        name,
        ok: fs.existsSync(filePath),
        detail: fs.existsSync(filePath) ? `${filePath} present` : `${filePath} missing`
    };
}
function resolveRunBridgePath(companionDir) {
    const windowsPath = path.join(companionDir, "run-bridge.ps1");
    if (fs.existsSync(windowsPath))
        return windowsPath;
    return path.join(companionDir, "run-bridge.sh");
}
function resolveDoctorApiUrl(paths) {
    const localConfig = loadLocalConfig(paths);
    const envApiUrl = String(process.env.EMPEROR_API_URL || process.env.EMPEROR_CLAW_API_URL || "").trim();
    const configuredApiUrl = String(localConfig?.apiUrl || "").trim();
    return (envApiUrl || configuredApiUrl || DEFAULT_EMPEROR_API_URL).replace(/\/+$/, "");
}
function resolveDoctorToken() {
    return String(process.env.EMPEROR_API_TOKEN || process.env.EMPEROR_CLAW_API_TOKEN || "").trim();
}
async function probeEmperorEndpoint(url, token) {
    try {
        const response = await fetch(url, {
            method: "GET",
            headers: token ? { Authorization: `Bearer ${token}` } : undefined
        });
        return {
            reachable: true,
            status: response.status,
            detail: `${url} responded ${response.status}`
        };
    }
    catch (error) {
        return {
            reachable: false,
            status: 0,
            detail: `${url} request failed: ${error?.message || error}`
        };
    }
}
async function checkEmperorApiReachability(paths) {
    const apiUrl = resolveDoctorApiUrl(paths);
    const probe = await probeEmperorEndpoint(`${apiUrl}/api/mcp/runtime/health`);
    return {
        name: "emperorApiReachability",
        ok: probe.reachable,
        detail: probe.reachable
            ? `${apiUrl} reachable (${probe.status})`
            : probe.detail
    };
}
async function checkEmperorApiAuth(paths) {
    const apiUrl = resolveDoctorApiUrl(paths);
    const token = resolveDoctorToken();
    if (!token) {
        return {
            name: "emperorApiAuth",
            ok: false,
            detail: "missing EMPEROR_API_TOKEN or EMPEROR_CLAW_API_TOKEN; authenticated Emperor bootstrap cannot be verified"
        };
    }
    const probe = await probeEmperorEndpoint(`${apiUrl}/api/mcp/agents?limit=1`, token);
    return {
        name: "emperorApiAuth",
        ok: probe.status >= 200 && probe.status < 300,
        detail: probe.status >= 200 && probe.status < 300
            ? `authenticated Emperor API check succeeded (${probe.status})`
            : probe.reachable
                ? `authenticated Emperor API check failed (${probe.status})`
                : probe.detail
    };
}
export async function runDoctor(paths) {
    const upgradePreview = inspectTrackedManifestUpgrades(paths);
    const manifests = loadManifests(paths);
    const owners = loadThreadOwners(paths);
    const emperorApiReachability = await checkEmperorApiReachability(paths);
    const emperorApiAuth = await checkEmperorApiAuth(paths);
    const openclawProfileConfig = inspectOpenClawProfileConfig(resolveOpenClawConfigPath(paths.pluginRoot));
    const globalChecks = [
        checkPath("manifestRoot", paths.manifestRoot),
        checkPath("stateRoot", paths.stateRoot),
        checkPath("threadOwners", paths.threadOwnerPath),
        checkPath("bridgeAsset", path.join(paths.pluginRoot, "runtime", "bridge.cjs")),
        checkPath("bridgeContractReference", path.join(paths.pluginRoot, "references", "BRIDGE-CONTRACT.md")),
        checkPath("channelManifest", path.join(paths.pluginRoot, "openclaw.plugin.json")),
        checkPath("sessionKeyApi", path.join(paths.pluginRoot, "session-key-api.ts")),
        checkPath("channelConfigReference", path.join(paths.pluginRoot, "references", "CHANNEL-CONFIG.md")),
        {
            name: "openclawProfileConfig",
            ok: openclawProfileConfig.ok,
            detail: openclawProfileConfig.detail
        },
        emperorApiReachability,
        emperorApiAuth,
        { name: "threadOwnerEntries", ok: true, detail: `${Object.keys(owners).length} tracked direct thread bindings` },
        {
            name: "manifestUpgrades",
            ok: upgradePreview.needingUpgrade === 0,
            detail: upgradePreview.needingUpgrade === 0
                ? "no manifest upgrades are needed"
                : `${upgradePreview.needingUpgrade} manifest(s) should be upgraded with emperor-upgrade-manifests`
        }
    ];
    const agents = [];
    for (const manifest of manifests) {
        const checks = [
            checkManifestConsistency(manifest),
            checkBridgeContract(manifest),
            checkThreadPolicy(manifest),
            checkDoctrineResource(manifest),
            checkPath("companionDir", manifest.companionDir),
            checkPath("envFile", `${manifest.companionDir}/.env`),
            checkPath("runBridge", resolveRunBridgePath(manifest.companionDir)),
            checkPath("bridgeConfig", `${manifest.companionDir}/bridge.config.json`),
            checkPath("runtimeBridge", `${manifest.companionDir}/runtime/bridge.js`),
            checkPath("runtimeControlPlane", `${manifest.companionDir}/runtime/control-plane.js`),
            checkPath("bridgeState", `${manifest.companionDir}/state/bridge-state.json`),
            checkBridgeFreshness(`${manifest.companionDir}/state/bridge-state.json`),
            await checkSystemdService(manifest.serviceName, `${manifest.companionDir}/state/bridge-state.json`),
            { name: "fallbackLog", ok: true, detail: fallbackLogExists(manifest.companionDir) ? `${manifest.companionDir}/bridge-fallback.log present` : `no fallback log present` }
        ];
        agents.push({
            agentName: manifest.agentName,
            serviceName: manifest.serviceName,
            checks
        });
    }
    return { globalChecks, agents };
}
export function formatDoctorReport(report) {
    const lines = ["Emperor doctor report:"];
    for (const check of report.globalChecks) {
        lines.push(`- ${check.name}: ${check.ok ? "ok" : "bad"} — ${check.detail}`);
    }
    if (report.agents.length === 0) {
        lines.push("- no tracked agents");
    }
    for (const agent of report.agents) {
        lines.push(`\n[${agent.agentName}]`);
        for (const check of agent.checks) {
            lines.push(`- ${check.name}: ${check.ok ? "ok" : "bad"} — ${check.detail}`);
        }
    }
    return lines.join("\n");
}
export function findBrokenAgents(report) {
    return report.agents.filter((agent) => agent.checks.some((check) => !check.ok));
}
