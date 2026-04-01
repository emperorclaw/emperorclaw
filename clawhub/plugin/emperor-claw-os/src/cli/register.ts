import { ensurePluginLayout, resolvePluginPaths } from "../state/paths.js";
import { loadLocalConfig, writeLocalConfig } from "../install/config.js";
import { loadManifests } from "../state/manifests.js";
import { loadThreadOwners, saveThreadOwners } from "../state/thread-owners.js";
import { runDoctor, formatDoctorReport } from "../install/health.js";
import { bootstrapAgent } from "../install/bootstrap.js";
import { repairAllAgents } from "../install/repair.js";
import { BRIDGE_CONTRACT_VERSION, REQUIRED_BRIDGE_CAPABILITIES } from "../bridge/contract.js";
import { backfillTrackedManifests, inspectTrackedManifestUpgrades } from "../state/normalize.js";
import fs from "node:fs";
import { removeTrackedAgent } from "../install/remove.js";
import { reloadAndRestartService, startFallbackBridge } from "../runtime/services.js";

function print(text: string): void {
  console.log(text);
}

async function fetchThreads(token: string, apiUrl: string): Promise<any[]> {
  const response = await fetch(`${apiUrl.replace(/\/+$/, "")}/api/mcp/threads?thread_type=direct`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) throw new Error(`thread fetch failed with ${response.status}`);
  const payload = await response.json();
  return payload.threads || [];
}

async function fetchThreadMessages(token: string, apiUrl: string, threadId: string): Promise<any[]> {
  const response = await fetch(`${apiUrl.replace(/\/+$/, "")}/api/mcp/threads/${threadId}/messages?limit=200`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) throw new Error(`thread message fetch failed with ${response.status}`);
  const payload = await response.json();
  return payload.messages || [];
}

export function registerEmperorCli(api: any, program: any): void {
  const emperor = program.command("emperor").description("Emperor Claw OS plugin commands");
  const paths = resolvePluginPaths(api);

  emperor.command("status").description("Show plugin status summary").action(async () => {
    ensurePluginLayout(paths);
    const localConfig = loadLocalConfig(paths);
    const manifests = loadManifests(paths);
    const owners = loadThreadOwners(paths);
    const upgradePreview = inspectTrackedManifestUpgrades(paths);
    print(JSON.stringify({
      pluginId: api.id,
      rootDir: api.rootDir || "unknown",
      localConfigPresent: Boolean(localConfig),
      configuredApiUrl: localConfig?.apiUrl || "https://emperorclaw.malecu.eu",
      emperorTokenPresent: Boolean(process.env.EMPEROR_API_TOKEN || process.env.EMPEROR_CLAW_API_TOKEN),
      bridgeContractVersion: BRIDGE_CONTRACT_VERSION,
      requiredBridgeCapabilities: REQUIRED_BRIDGE_CAPABILITIES,
      manifestCount: manifests.length,
      manifestsWithBridgeContract: manifests.filter((manifest) => Boolean(manifest.bridgeContract)).length,
      manifestsNeedingUpgrade: upgradePreview.needingUpgrade,
      threadOwnerCount: Object.keys(owners).length,
      hasBridgeAsset: fs.existsSync(`${paths.pluginRoot}/examples/bridge.js`),
      hasDoctorScript: fs.existsSync(`${paths.pluginRoot}/scripts/doctor-local.sh`),
      declaresChannelInManifest: fs.readFileSync(`${paths.pluginRoot}/openclaw.plugin.json`, "utf8").includes("\"channels\""),
      hasSessionKeyApi: fs.existsSync(`${paths.pluginRoot}/session-key-api.ts`),
      hasChannelConfigReference: fs.existsSync(`${paths.pluginRoot}/references/CHANNEL-CONFIG.md`)
    }, null, 2));
  });

  emperor.command("help").description("Show plugin help overview").action(async () => {
    print([
      "Emperor Claw OS plugin commands:",
      "- emperor status",
      "- emperor install",
      "- emperor doctor",
      "- emperor list-agents",
      "- emperor show-agent --local-brain-agent-id <id>",
      "- emperor add-agent --agent-name <name> --local-brain-agent-id <id> --token <token>",
      "- emperor upgrade-manifests",
      "- emperor repair",
      "- emperor restart-agent --local-brain-agent-id <id>",
      "- emperor remove-agent --local-brain-agent-id <id> [--remove-companion-dir] [--remove-workspace] [--remove-local-brain-agent]",
      "- emperor rebind-threads --token <token>",
      "- emperor channel capability is registered through index.ts",
      "- emperor doctor also probes Emperor host reachability and auth when an EMPEROR_API_TOKEN is available"
    ].join("\n"));
  });

  emperor.command("install")
    .description("Initialize Emperor plugin local config")
    .option("--api-url <url>")
    .option("--owner-name <name>")
    .option("--owner-timezone <tz>")
    .action(async (opts: any) => {
      ensurePluginLayout(paths);
      const configPath = writeLocalConfig(paths, {
        apiUrl: String(opts.apiUrl || api.pluginConfig?.apiUrl || "https://emperorclaw.malecu.eu"),
        defaultOwnerName: String(opts.ownerName || api.pluginConfig?.defaultOwnerName || "Jose"),
        defaultOwnerTimezone: String(opts.ownerTimezone || api.pluginConfig?.defaultOwnerTimezone || "UTC"),
        installedAt: new Date().toISOString()
      });
      print(`Emperor plugin install initialized.\nConfig: ${configPath}`);
    });

  emperor.command("doctor").description("Run Emperor plugin health diagnostics").action(async () => {
    ensurePluginLayout(paths);
    const localConfig = loadLocalConfig(paths);
    const report = await runDoctor(paths);
    const prefix = localConfig ? `Local config: ${JSON.stringify(localConfig)}\n\n` : "Local config: missing\n\n";
    print(prefix + formatDoctorReport(report));
  });

  emperor.command("upgrade-manifests").description("Backfill tracked manifests with bridge contract metadata").action(async () => {
    ensurePluginLayout(paths);
    const result = backfillTrackedManifests(paths);
    print(
      result.changed === 0
        ? `Scanned ${result.scanned} manifests. No manifest upgrades were needed.`
        : [
            `Scanned ${result.scanned} manifests.`,
            `Upgraded ${result.changed} manifest(s) with bridge contract metadata:`,
            ...result.agents.map((agentName) => `- ${agentName}`)
          ].join("\n")
    );
  });

  emperor.command("list-agents").description("List tracked Emperor agent manifests").action(async () => {
    ensurePluginLayout(paths);
    const manifests = loadManifests(paths);
    print(manifests.length === 0 ? "No Emperor agent manifests are currently tracked." : manifests.map((m) => `- ${m.agentName} → ${m.localBrainAgentId} (${m.serviceName})`).join("\n"));
  });

  emperor.command("show-agent")
    .description("Show one tracked Emperor agent manifest")
    .requiredOption("--local-brain-agent-id <id>")
    .action(async (opts: any) => {
      ensurePluginLayout(paths);
      const manifest = loadManifests(paths).find((row) => row.localBrainAgentId === String(opts.localBrainAgentId || ""));
      if (!manifest) return print(`No tracked Emperor agent found for ${opts.localBrainAgentId}`);
      print([
        `Agent: ${manifest.agentName}`,
        `Local brain: ${manifest.localBrainAgentId}`,
        `Emperor agent id: ${manifest.agentId || "unknown"}`,
        `Service: ${manifest.serviceName}`,
        `Companion dir: ${manifest.companionDir}`,
        `Runtime id: ${manifest.runtimeId}`,
        `Profile: ${manifest.profile}`,
        `Bridge contract version: ${manifest.bridgeContract?.version || "missing"}`,
        `Thread policy: direct=${manifest.threadPolicy?.direct || "missing"}, team=${manifest.threadPolicy?.team || "missing"}, delegation=${manifest.threadPolicy?.delegation || "missing"}`,
        "",
        JSON.stringify(manifest, null, 2)
      ].join("\n"));
    });

  emperor.command("add-agent")
    .description("Bootstrap a real Emperor-connected local agent")
    .requiredOption("--agent-name <name>")
    .requiredOption("--local-brain-agent-id <id>")
    .requiredOption("--token <token>")
    .option("--profile <profile>")
    .option("--api-url <url>")
    .option("--owner-name <name>")
    .option("--owner-timezone <tz>")
    .option("--thinking <level>")
    .action(async (opts: any) => {
      ensurePluginLayout(paths);
      const localConfig = loadLocalConfig(paths);
      const result = await bootstrapAgent(paths, {
        apiUrl: String(opts.apiUrl || localConfig?.apiUrl || api.pluginConfig?.apiUrl || "https://emperorclaw.malecu.eu"),
        token: String(opts.token || ""),
        agentName: String(opts.agentName || ""),
        localBrainAgentId: String(opts.localBrainAgentId || ""),
        profile: String(opts.profile || "operator") as "operator" | "manager",
        ownerName: String(opts.ownerName || localConfig?.defaultOwnerName || api.pluginConfig?.defaultOwnerName || "Jose"),
        ownerTimezone: String(opts.ownerTimezone || localConfig?.defaultOwnerTimezone || api.pluginConfig?.defaultOwnerTimezone || "UTC"),
        thinking: String(opts.thinking || "medium")
      });
      print(`Bootstrapped Emperor agent ${result.manifest.agentName}.\nManifest: ${result.manifestPath}\nCompanion dir: ${result.companionDir}\nService: ${result.manifest.serviceName}`);
    });

  emperor.command("repair").description("Repair and restart tracked Emperor bridge agents").action(async () => {
    ensurePluginLayout(paths);
    const upgraded = backfillTrackedManifests(paths);
    const repaired = await repairAllAgents(paths, api);
    print(
      repaired.length === 0 && upgraded.changed === 0
        ? "No tracked Emperor agents were repaired."
        : [
            upgraded.changed > 0
              ? `Backfilled bridge contract metadata for ${upgraded.changed} manifest(s).`
              : "No manifest backfill was needed.",
            repaired.length === 0
              ? "No tracked Emperor agents were repaired."
              : `Repaired Emperor agents:\n${repaired.map((n) => `- ${n}`).join("\n")}`
          ].join("\n")
    );
  });

  emperor.command("restart-agent")
    .description("Restart a tracked Emperor bridge service")
    .requiredOption("--local-brain-agent-id <id>")
    .action(async (opts: any) => {
      ensurePluginLayout(paths);
      const manifest = loadManifests(paths).find((row) => row.localBrainAgentId === String(opts.localBrainAgentId || ""));
      if (!manifest) return print(`No tracked Emperor agent found for ${opts.localBrainAgentId}`);
      const restarted = await reloadAndRestartService(manifest.serviceName.replace(/\.service$/, ""));
      if (restarted.mode === "fallback") {
        const logPath = await startFallbackBridge(manifest.companionDir);
        return print(`Restarted ${manifest.serviceName} via fallback launcher (${logPath})`);
      }
      print(restarted.detail);
    });

  emperor.command("remove-agent")
    .description("Remove a tracked Emperor agent manifest and stop its service")
    .requiredOption("--local-brain-agent-id <id>")
    .option("--remove-companion-dir", "Delete companion directory too")
    .option("--remove-workspace", "Delete the local OpenClaw workspace too")
    .option("--remove-local-brain-agent", "Attempt to delete the local OpenClaw brain agent too")
    .action(async (opts: any) => {
      ensurePluginLayout(paths);
      const localBrainAgentId = String(opts.localBrainAgentId || "");
      const removeCompanionDir = Boolean(opts.removeCompanionDir || false);
      const removeWorkspace = Boolean(opts.removeWorkspace || false);
      const removeLocalBrain = Boolean(opts.removeLocalBrainAgent || false);
      const result = await removeTrackedAgent(paths, {
        localBrainAgentId,
        removeCompanionDir,
        removeWorkspace,
        removeLocalBrainAgent: removeLocalBrain
      });
      if (!result) return print(`No tracked Emperor agent found for ${localBrainAgentId}`);
      print([
        `Removed tracked Emperor agent ${result.localBrainAgentId}`,
        `Manifest removed: ${result.manifestPath}`,
        `Thread bindings removed: ${result.threadBindingsRemoved}`,
        `Systemd unit removed: ${result.systemdUnitRemoved ? "yes" : "no"}`,
        `Companion dir removed: ${result.companionRemoved ? "yes" : "no"}`,
        `Workspace removed: ${result.workspaceRemoved ? "yes" : "no"}`,
        `Local brain agent removed: ${result.localBrainAgentRemovalAttempted ? (result.localBrainAgentRemoved ? "yes" : "no") : "skipped"}`
      ].join("\n"));
    });

  emperor.command("rebind-threads")
    .description("Rebuild direct-thread ownership from Emperor metadata")
    .requiredOption("--token <token>")
    .option("--api-url <url>")
    .action(async (opts: any) => {
      ensurePluginLayout(paths);
      const manifests = loadManifests(paths);
      const token = String(opts.token || "");
      const apiUrl = String(opts.apiUrl || api.pluginConfig?.apiUrl || "https://emperorclaw.malecu.eu");
      const owners = loadThreadOwners(paths);
      const threads = await fetchThreads(token, apiUrl);
      const knownAgentIds = new Set(manifests.map((manifest) => manifest.agentId).filter(Boolean));
      let rebound = 0;
      for (const thread of threads) {
        const messages = await fetchThreadMessages(token, apiUrl, thread.id);
        const targetedHuman = messages.find((message: any) => message?.senderType === "human" && message?.targetAgentId);
        if (targetedHuman?.targetAgentId) {
          owners[thread.id] = targetedHuman.targetAgentId;
          rebound += 1;
          continue;
        }
        const firstAgent = messages.find((message: any) => message?.senderType === "agent" && (!knownAgentIds.size || knownAgentIds.has(message.senderId)));
        if (firstAgent?.senderId) {
          owners[thread.id] = firstAgent.senderId;
          rebound += 1;
        }
      }
      saveThreadOwners(paths, owners);
      print(`Rebound ${rebound} direct thread owner mappings into ${paths.threadOwnerPath}`);
    });
}
