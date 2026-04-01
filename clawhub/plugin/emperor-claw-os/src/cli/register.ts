import { ensurePluginLayout, resolvePluginPaths } from "../state/paths.js";
import { loadLocalConfig, writeLocalConfig } from "../install/config.js";
import { loadManifests, resolveManifestPath } from "../state/manifests.js";
import { loadThreadOwners, saveThreadOwners } from "../state/thread-owners.js";
import { runDoctor, formatDoctorReport } from "../install/health.js";
import { bootstrapAgent } from "../install/bootstrap.js";
import { repairAllAgents } from "../install/repair.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";

const execFileAsync = promisify(execFile);

function print(text: string): void {
  console.log(text);
}

function removeMatchingThreadOwners(paths: ReturnType<typeof resolvePluginPaths>, emperorAgentId?: string): number {
  if (!emperorAgentId) return 0;
  const owners = loadThreadOwners(paths);
  let removed = 0;
  for (const [threadId, ownerId] of Object.entries(owners)) {
    if (ownerId === emperorAgentId) {
      delete owners[threadId];
      removed += 1;
    }
  }
  saveThreadOwners(paths, owners);
  return removed;
}

async function fetchThreads(token: string, apiUrl: string): Promise<any[]> {
  const { stdout } = await execFileAsync("curl", ["-sS", "-H", `Authorization: Bearer ${token}`, `${apiUrl}/api/mcp/threads?thread_type=direct`]);
  const payload = JSON.parse(stdout);
  return payload.threads || [];
}

async function fetchThreadMessages(token: string, apiUrl: string, threadId: string): Promise<any[]> {
  const { stdout } = await execFileAsync("curl", ["-sS", "-H", `Authorization: Bearer ${token}`, `${apiUrl}/api/mcp/threads/${threadId}/messages?limit=200`]);
  const payload = JSON.parse(stdout);
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
    print(JSON.stringify({
      pluginId: api.id,
      rootDir: api.rootDir || "unknown",
      localConfigPresent: Boolean(localConfig),
      manifestCount: manifests.length,
      threadOwnerCount: Object.keys(owners).length,
      hasBridgeAsset: fs.existsSync(`${paths.pluginRoot}/examples/bridge.js`),
      hasDoctorScript: fs.existsSync(`${paths.pluginRoot}/scripts/doctor-local.sh`)
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
      "- emperor repair",
      "- emperor restart-agent --local-brain-agent-id <id>",
      "- emperor remove-agent --local-brain-agent-id <id> [--remove-companion-dir]",
      "- emperor rebind-threads --token <token>"
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
      print(JSON.stringify(manifest, null, 2));
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
    const repaired = await repairAllAgents(paths, api);
    print(repaired.length === 0 ? "No tracked Emperor agents were repaired." : `Repaired Emperor agents:\n${repaired.map((n) => `- ${n}`).join("\n")}`);
  });

  emperor.command("restart-agent")
    .description("Restart a tracked Emperor bridge service")
    .requiredOption("--local-brain-agent-id <id>")
    .action(async (opts: any) => {
      ensurePluginLayout(paths);
      const manifest = loadManifests(paths).find((row) => row.localBrainAgentId === String(opts.localBrainAgentId || ""));
      if (!manifest) return print(`No tracked Emperor agent found for ${opts.localBrainAgentId}`);
      await execFileAsync("systemctl", ["--user", "restart", manifest.serviceName]);
      print(`Restarted ${manifest.serviceName}`);
    });

  emperor.command("remove-agent")
    .description("Remove a tracked Emperor agent manifest and stop its service")
    .requiredOption("--local-brain-agent-id <id>")
    .option("--remove-companion-dir", "Delete companion directory too")
    .action(async (opts: any) => {
      ensurePluginLayout(paths);
      const localBrainAgentId = String(opts.localBrainAgentId || "");
      const removeCompanionDir = Boolean(opts.removeCompanionDir || false);
      const manifests = loadManifests(paths);
      const manifest = manifests.find((row) => row.localBrainAgentId === localBrainAgentId);
      if (!manifest) return print(`No tracked Emperor agent found for ${localBrainAgentId}`);
      try { await execFileAsync("systemctl", ["--user", "disable", "--now", manifest.serviceName]); } catch {}
      const manifestPath = resolveManifestPath(paths, localBrainAgentId);
      if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);
      let companionRemoved = false;
      if (removeCompanionDir && fs.existsSync(manifest.companionDir)) {
        fs.rmSync(manifest.companionDir, { recursive: true, force: true });
        companionRemoved = true;
      }
      const threadBindingsRemoved = removeMatchingThreadOwners(paths, manifest.agentId);
      print([
        `Removed tracked Emperor agent ${localBrainAgentId}`,
        `Manifest removed: ${manifestPath}`,
        `Thread bindings removed: ${threadBindingsRemoved}`,
        `Companion dir removed: ${companionRemoved ? "yes" : "no"}`
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
