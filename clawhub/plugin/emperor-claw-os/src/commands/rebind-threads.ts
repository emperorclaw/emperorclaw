import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { EmperorPluginPaths } from "../state/paths.js";
import { ensurePluginLayout } from "../state/paths.js";
import { loadThreadOwners, saveThreadOwners } from "../state/thread-owners.js";
import { loadManifests } from "../state/manifests.js";

const execFileAsync = promisify(execFile);

async function fetchThreads(token: string, apiUrl: string): Promise<any[]> {
  const { stdout } = await execFileAsync("curl", ["-sS", "-H", `Authorization: Bearer ${token}`, `${apiUrl}/api/mcp/threads?type=direct`]);
  const payload = JSON.parse(stdout);
  return payload.threads || [];
}

async function fetchThreadMessages(token: string, apiUrl: string, threadId: string): Promise<any[]> {
  const { stdout } = await execFileAsync("curl", ["-sS", "-H", `Authorization: Bearer ${token}`, `${apiUrl}/api/mcp/threads/${threadId}/messages?limit=200`]);
  const payload = JSON.parse(stdout);
  return payload.messages || [];
}

export function registerRebindThreadsCommand(api: any, paths: EmperorPluginPaths): void {
  api.registerCommand({
    name: "emperor-rebind-threads",
    description: "Rebuild direct-thread ownership from Emperor message target metadata",
    acceptsArgs: true,
    handler: async (ctx: any) => {
      ensurePluginLayout(paths);
      const params = ctx?.args ? JSON.parse(ctx.args) : {};
      const manifests = loadManifests(paths);
      const token = String(params.token || "");
      const apiUrl = String(params.apiUrl || api.pluginConfig?.apiUrl || "http://localhost:3000");
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
      return { text: `Rebound ${rebound} direct thread owner mappings into ${paths.threadOwnerPath}` };
    }
  });
}
