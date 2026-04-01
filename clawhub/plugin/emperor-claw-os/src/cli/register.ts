async function invokeByName(api: any, name: string, argsObj?: any): Promise<any> {
  const registry = api.runtime?.commands;
  if (!registry || typeof registry.invoke !== 'function') throw new Error('OpenClaw runtime command registry is unavailable');
  return await registry.invoke(name, {
    args: argsObj ? JSON.stringify(argsObj) : '',
    channel: 'cli'
  });
}

function printResult(result: any): void {
  console.log(result?.text || JSON.stringify(result, null, 2));
}

export function registerEmperorCli(api: any, program: any): void {
  const emperor = program.command('emperor').description('Emperor Claw OS plugin commands');

  emperor.command('status').description('Show plugin status summary').action(async () => {
    printResult(await invokeByName(api, 'emperor-status'));
  });

  emperor.command('help').description('Show plugin help overview').action(async () => {
    printResult(await invokeByName(api, 'emperor-help'));
  });

  emperor.command('install')
    .description('Initialize Emperor plugin local config')
    .option('--api-url <url>')
    .option('--owner-name <name>')
    .option('--owner-timezone <tz>')
    .action(async (opts: any) => {
      printResult(await invokeByName(api, 'emperor-install', {
        apiUrl: opts.apiUrl,
        defaultOwnerName: opts.ownerName,
        defaultOwnerTimezone: opts.ownerTimezone
      }));
    });

  emperor.command('doctor').description('Run Emperor plugin health diagnostics').action(async () => {
    printResult(await invokeByName(api, 'emperor-doctor'));
  });

  emperor.command('list-agents').description('List tracked Emperor agent manifests').action(async () => {
    printResult(await invokeByName(api, 'emperor-list-agents'));
  });

  emperor.command('show-agent')
    .description('Show one tracked Emperor agent manifest')
    .requiredOption('--local-brain-agent-id <id>')
    .action(async (opts: any) => {
      printResult(await invokeByName(api, 'emperor-show-agent', { localBrainAgentId: opts.localBrainAgentId }));
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
      printResult(await invokeByName(api, 'emperor-add-agent', {
        agentName: opts.agentName,
        localBrainAgentId: opts.localBrainAgentId,
        token: opts.token,
        profile: opts.profile,
        apiUrl: opts.apiUrl,
        ownerName: opts.ownerName,
        ownerTimezone: opts.ownerTimezone,
        thinking: opts.thinking
      }));
    });

  emperor.command('repair').description('Repair and restart tracked Emperor bridge agents').action(async () => {
    printResult(await invokeByName(api, 'emperor-repair'));
  });

  emperor.command('restart-agent')
    .description('Restart a tracked Emperor bridge service')
    .requiredOption('--local-brain-agent-id <id>')
    .action(async (opts: any) => {
      printResult(await invokeByName(api, 'emperor-restart-agent', { localBrainAgentId: opts.localBrainAgentId }));
    });

  emperor.command('remove-agent')
    .description('Remove a tracked Emperor agent manifest and stop its service')
    .requiredOption('--local-brain-agent-id <id>')
    .option('--remove-companion-dir', 'Delete companion directory too')
    .action(async (opts: any) => {
      printResult(await invokeByName(api, 'emperor-remove-agent', {
        localBrainAgentId: opts.localBrainAgentId,
        removeCompanionDir: Boolean(opts.removeCompanionDir)
      }));
    });

  emperor.command('rebind-threads')
    .description('Rebuild direct-thread ownership from Emperor metadata')
    .requiredOption('--token <token>')
    .option('--api-url <url>')
    .action(async (opts: any) => {
      printResult(await invokeByName(api, 'emperor-rebind-threads', {
        token: opts.token,
        apiUrl: opts.apiUrl
      }));
    });
}
