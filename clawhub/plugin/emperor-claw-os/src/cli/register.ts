import { ensurePluginLayout, resolvePluginPaths } from "../state/paths.js";
import { loadLocalConfig, writeLocalConfig } from "../install/config.js";
import { loadManifests } from "../state/manifests.js";
import { loadThreadOwners } from "../state/thread-owners.js";
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

export function registerEmperorCli(api: any, program: any): void {
  const emperor = program.command('emperor').description('Emperor Claw OS plugin commands');
  const paths = resolvePluginPaths(api);

  emperor.command('status').description('Show plugin status summary').action(async () => {
    ensurePluginLayout(paths);
    const localConfig = loadLocalConfig(paths);
    const manifests = loadManifests(paths);
    const owners = loadThreadOwners(paths);
    print(JSON.stringify({
      pluginId: api.id,
      pluginRoot: paths.pluginRoot,
      localConfigPresent: Boolean(localConfig),
      manifestCount: manifests.length,
      threadOwnerCount: Object.keys(owners).length,
      hasBridgeAsset: fs.existsSync(`${paths.pluginRoot}/examples/bridge.js`),
      hasDoctorScript: fs.existsSync(`${paths.pluginRoot}/scripts/doctor-local.sh`)
    }, null, 2));
  });

  emperor.command('help').description('Show plugin help overview').action(async () => {
    print([
      'Emperor Claw OS plugin commands:',
      '- emperor status',
      '- emperor install',
      '- emperor doctor',
      '- emperor list-agents',
      '- emperor show-agent --local-brain-agent-id <id>',
      '- emperor add-agent --agent-name <name> --local-brain-agent-id <id> --token <token>',
      '- emperor repair',
      '- emperor restart-agent --local-brain-agent-id <id>',
      '- emperor remove-agent --local-brain-agent-id <id> [--remove-companion-dir]',
      '- emperor rebind-threads --token <token>'
    ].join('\n'));
  });

  emperor.command('install')
    .description('Initialize Emperor plugin local config')
    .option('--api-url <url>')
    .option('--owner-name <name>')
    .option('--owner-timezone <tz>')
    .action(async (opts: any) => {
      ensurePluginLayout(paths);
      const configPath = writeLocalConfig(paths, {
        apiUrl: String(opts.apiUrl || api.pluginConfig?.apiUrl || 'https://emperorclaw.malecu.eu'),
        defaultOwnerName: String(opts.ownerName || api.pluginConfig?.defaultOwnerName || 'Jose'),
        defaultOwnerTimezone: String(opts.ownerTimezone || api.pluginConfig?.defaultOwnerTimezone || 'UTC'),
        installedAt: new Date().toISOString()
      });
      print(`Emperor plugin install initialized.\nConfig: ${configPath}`);
    });

  emperor.command('doctor').description('Run Emperor plugin health diagnostics').action(async () => {
    ensurePluginLayout(paths);
    const localConfig = loadLocalConfig(paths);
    const report = await runDoctor(paths);
    const prefix = localConfig ? `Local config: ${JSON.stringify(localConfig)}\n\n` : 'Local config: missing\n\n';
    print(prefix + formatDoctorReport(report));
  });

  emperor.command('list-agents').description('List tracked Emperor agent manifests').action(async () => {
    ensurePluginLayout(paths);
    const manifests = loadManifests(paths);
    print(manifests.length === 0 ? 'No Emperor agent manifests are currently tracked.' : manifests.map((m) => `- ${m.agentName} → ${m.localBrainAgentId} (${m.serviceName})`).join('\n'));
  });

  emperor.command('show-agent')
    .description('Show one tracked Emperor agent manifest')
    .requiredOption('--local-brain-agent-id <id>')
    .action(async (opts: any) => {
      ensurePluginLayout(paths);
      const manifest = loadManifests(paths).find((row) => row.localBrainAgentId === String(opts.localBrainAgentId || ''));
      if (!manifest) return print(`No tracked Emperor agent found for ${opts.localBrainAgentId}`);
      print(JSON.stringify(manifest, null, 2));
    });

  emperor.command('add-agent')
    .description('Bootstrap a real Emperor-connected local agent')
    .requiredOption('--agent-name <name>')
    .requiredOption('--local-brain-agent-id <id>')
    .requiredOption('--token <token>')
    .option('--profile <profile>')
    .option('--api-url <url>')
    .option('--owner-name <name>')
    .option('--owner-timezone <tz>')
    .option('--thinking <level>')
    .action(async (opts: any) => {
      ensurePluginLayout(paths);
      const localConfig = loadLocalConfig(paths);
      const result = await bootstrapAgent(paths, {
        apiUrl: String(opts.apiUrl || localConfig?.apiUrl || api.pluginConfig?.apiUrl || 'https://emperorclaw.malecu.eu'),
        token: String(opts.token || ''),
        agentName: String(opts.agentName || ''),
        localBrainAgentId: String(opts.localBrainAgentId || ''),
        profile: String(opts.profile || 'operator') as 'operator' | 'manager',
        ownerName: String(opts.ownerName || localConfig?.defaultOwnerName || api.pluginConfig?.defaultOwnerName || 'Jose'),
        ownerTimezone: String(opts.ownerTimezone || localConfig?.defaultOwnerTimezone || api.pluginConfig?.defaultOwnerTimezone || 'UTC'),
        thinking: String(opts.thinking || 'medium')
      });
      print(`Bootstrapped Emperor agent ${result.manifest.agentName}.\nManifest: ${result.manifestPath}\nCompanion dir: ${result.companionDir}\nService: ${result.manifest.serviceName}`);
    });

  emperor.command('repair').description('Repair and restart tracked Emperor bridge agents').action(async () => {
    ensurePluginLayout(paths);
    const repaired = await repairAllAgents(paths, api);
    print(repaired.length === 0 ? 'No tracked Emperor agents were repaired.' : `Repaired Emperor agents:\n${repaired.map((n) => `- ${n}`).join('\n')}`);
  });

  emperor.command('restart-agent')
    .description('Restart a tracked Emperor bridge service')
    .requiredOption('--local-brain-agent-id <id>')
    .action(async (opts: any) => {
      ensurePluginLayout(paths);
      const manifest = loadManifests(paths).find((row) => row.localBrainAgentId === String(opts.localBrainAgentId || ''));
      if (!manifest) return print(`No tracked Emperor agent found for ${opts.localBrainAgentId}`);
      await execFileAsync('systemctl', ['--user', 'restart', manifest.serviceName]);
      print(`Restarted ${manifest.serviceName}`);
    });

  emperor.command('remove-agent')
    .description('Remove a tracked Emperor agent manifest and stop its service')
    .requiredOption('--local-brain-agent-id <id>')
    .option('--remove-companion-dir', 'Delete companion directory too')
    .action(async (opts: any) => {
      ensurePluginLayout(paths);
      print('Use plugin command surface for remove-agent cleanup for now; CLI wrapper expansion still in progress.');
    });

  emperor.command('rebind-threads')
    .description('Rebuild direct-thread ownership from Emperor metadata')
    .requiredOption('--token <token>')
    .option('--api-url <url>')
    .action(async () => {
      ensurePluginLayout(paths);
      print('Use plugin command surface for rebind-threads for now; CLI wrapper expansion still in progress.');
    });
}
