function parseJsonArg(input?: string): any {
  if (!input) return {};
  return JSON.parse(input);
}

async function invokeByName(api: any, name: string, argsObj?: any): Promise<any> {
  const registry = api.runtime?.commands;
  if (!registry || typeof registry.invoke !== 'function') {
    throw new Error('OpenClaw runtime command registry is unavailable');
  }
  return await registry.invoke(name, {
    args: argsObj ? JSON.stringify(argsObj) : '',
    channel: 'cli'
  });
}

export function registerEmperorCli(api: any, program: any): void {
  const emperor = program.command('emperor').description('Emperor Claw OS plugin commands');

  emperor.command('status')
    .description('Show plugin status summary')
    .action(async () => {
      const result = await invokeByName(api, 'emperor-status');
      console.log(result?.text || JSON.stringify(result, null, 2));
    });

  emperor.command('install')
    .description('Initialize Emperor plugin local config')
    .option('--api-url <url>')
    .option('--owner-name <name>')
    .option('--owner-timezone <tz>')
    .action(async (opts: any) => {
      const result = await invokeByName(api, 'emperor-install', {
        apiUrl: opts.apiUrl,
        defaultOwnerName: opts.ownerName,
        defaultOwnerTimezone: opts.ownerTimezone
      });
      console.log(result?.text || JSON.stringify(result, null, 2));
    });

  emperor.command('doctor')
    .description('Run Emperor plugin health diagnostics')
    .action(async () => {
      const result = await invokeByName(api, 'emperor-doctor');
      console.log(result?.text || JSON.stringify(result, null, 2));
    });

  emperor.command('list-agents')
    .description('List tracked Emperor agent manifests')
    .action(async () => {
      const result = await invokeByName(api, 'emperor-list-agents');
      console.log(result?.text || JSON.stringify(result, null, 2));
    });

  emperor.command('show-agent')
    .description('Show one tracked Emperor agent manifest')
    .requiredOption('--local-brain-agent-id <id>')
    .action(async (opts: any) => {
      const result = await invokeByName(api, 'emperor-show-agent', {
        localBrainAgentId: opts.localBrainAgentId
      });
      console.log(result?.text || JSON.stringify(result, null, 2));
    });

  emperor.command('help')
    .description('Show plugin help overview')
    .action(async () => {
      const result = await invokeByName(api, 'emperor-help');
      console.log(result?.text || JSON.stringify(result, null, 2));
    });
}
