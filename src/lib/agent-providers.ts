/**
 * Agent Providers — how an agent runs.
 * Decoupled from role (what it does). Extensible for future providers (Claude Code, Codex, etc.).
 *
 * Inspired by Paperclip's adapter system.
 */
import type { AgentRoleTemplate } from "./agent-templates";

export type ExecutionModel = "persistent" | "on-demand";

export type AgentProvider = {
    id: string;
    name: string;
    icon: string;
    description: string;
    executionModel: ExecutionModel;
    status: "available" | "planned";
    prerequisites: string[];
    /** Where doctrine files live on the agent's machine */
    doctrinePath: string | null;
    /** Config files the user needs to create */
    configFiles: {
        name: string;
        path: string;
        description: string;
        template: string;
    }[];
    /** How to install the bridge/plugin/runtime */
    installCommands: string[];
    /** How heartbeats work */
    heartbeatModel: "push" | "poll" | "schedule" | "none";
    /** LLM setup prompt suffix (provider-specific instructions) */
    setupPromptPrefix: string;
    /** Post-install checklist items */
    postInstallChecklist: string[];
    /** Future: how Emperor invokes on-demand agents */
    invokeCommand?: string;
    /** Future: how results come back */
    resultCapture?: "stdout" | "api" | "webhook";
};

export const agentProviders: AgentProvider[] = [
    {
        id: "openclaw",
        name: "OpenClaw",
        icon: "IconRobot",
        description:
            "Native plugin. Creates workspace, bridge, and bootstrap files automatically. Doctor/repair commands included.",
        executionModel: "persistent",
        status: "available",
        prerequisites: ["Node.js 20+", "OpenClaw CLI"],
        doctrinePath: "~/.openclaw/workspace-{brainId}/",
        configFiles: [
            {
                name: "Bridge .env",
                path: "~/.openclaw/emperor-control-plane-{slug}/.env",
                description: "Connection details and model provider key",
                template: `EMPEROR_CLAW_API_URL="{url}"
EMPEROR_CLAW_API_TOKEN="{token}"
EMPEROR_CLAW_AGENT_ID="{agentId}"
EMPEROR_CLAW_RUNTIME_ID="openclaw-{name}-{host}"`,
            },
        ],
        installCommands: [
            "openclaw plugins install clawhub:emperor-claw-os-plugin",
            "openclaw emperor add-agent --agent-name \"{name}\" --profile operator --token \"{token}\"",
        ],
        heartbeatModel: "push",
        setupPromptPrefix: `Use the OpenClaw plugin. It creates the workspace, bridge config, and bootstrap files automatically.

Plugin install:
  openclaw plugins install clawhub:emperor-claw-os-plugin

After installation, the plugin manages:
- Workspace creation under ~/.openclaw/workspace-{brainId}/
- Bootstrap files: AGENTS.md, SOUL.md, BOOTSTRAP.md, IDENTITY.md, TOOLS.md, HEARTBEAT.md
- Bridge config and state
- Doctor/repair commands

The plugin injects recognized bootstrap files into the agent's prompt context automatically.`,
        postInstallChecklist: [
            "Install OpenClaw CLI",
            "Run: openclaw plugins install clawhub:emperor-claw-os-plugin",
            "Run: openclaw emperor add-agent --agent-name \"{name}\" --token \"{token}\"",
            "Verify: openclaw emperor status shows agent online",
            "Check Emperor dashboard — agent should appear as online",
        ],
    },
    {
        id: "hermes",
        name: "Hermes",
        icon: "IconTerminal2",
        description:
            "Bridge service. One Hermes profile per agent. Best for Raspberry Pi, VPS, or dedicated workers.",
        executionModel: "persistent",
        status: "available",
        prerequisites: ["Hermes CLI", "systemd (Linux) or equivalent"],
        doctrinePath: "~/.hermes/profiles/{name}/",
        configFiles: [
            {
                name: "Bridge .env",
                path: "~/.hermes/emperor-bridge/{name}/.env",
                description: "Connection details, model provider key, toolsets",
                template: `EMPEROR_CLAW_API_URL="{url}"
EMPEROR_CLAW_API_TOKEN="{token}"
EMPEROR_CLAW_AGENT_NAME="{name}"
EMPEROR_CLAW_AGENT_ID="{agentId}"
EMPEROR_CLAW_AGENT_ROLE="{role}"
EMPEROR_CLAW_RUNTIME_ID="hermes-{name}-{host}-1"
EMPEROR_CLAW_HERMES_POLL_SECONDS="5"
EMPEROR_CLAW_HERMES_TIMEOUT_SECONDS="300"
HERMES_BIN="/home/{user}/.local/bin/hermes"
HERMES_TOOLSETS="emperor-claw,web,terminal,code_execution"
DEEPSEEK_API_KEY="<your-key>"`,
            },
        ],
        installCommands: [
            "curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash -s -- --skip-setup",
            "# Then create profile: hermes profile create {name} --clone",
            "# Install Emperor plugin: cp -R emperor-claw ~/.hermes/profiles/{name}/plugins/ && hermes -p {name} plugins enable emperor-claw",
        ],
        heartbeatModel: "push",
        setupPromptPrefix: `Use the Hermes bridge service. Each agent needs one Hermes profile and one bridge service.

Install Hermes:
  curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash -s -- --skip-setup

Create a profile per agent:
  hermes profile create {name} --clone --description "{role}"

Install the Emperor Hermes plugin into the profile:
  mkdir -p ~/.hermes/profiles/{name}/plugins
  cp -R emperor-claw ~/.hermes/profiles/{name}/plugins/emperor-claw
  hermes -p {name} plugins enable emperor-claw

Create a systemd service at ~/.config/systemd/user/emperor-hermes-bridge-{name}.service`,
        postInstallChecklist: [
            "Install Hermes CLI",
            "Create profile: hermes profile create {name} --clone",
            "Install Emperor plugin into the profile",
            "Create bridge .env at ~/.hermes/emperor-bridge/{name}/.env",
            "Create systemd service for the bridge",
            "Start: systemctl --user start emperor-hermes-bridge-{name}",
            "Check Emperor dashboard — agent should appear as online",
        ],
    },
    {
        id: "mcp",
        name: "Generic MCP",
        icon: "IconPlugConnected",
        description:
            "Any MCP-compatible runtime. You handle the agent logic; Emperor provides the API, tasks, and context.",
        executionModel: "persistent",
        status: "available",
        prerequisites: ["MCP client", "Bearer token from Emperor"],
        doctrinePath: null,
        configFiles: [],
        installCommands: [],
        heartbeatModel: "push",
        setupPromptPrefix: `This agent connects via the standard MCP API. No bridge or plugin is needed — just the API token.

The MCP API is at {url}/api/mcp. All endpoints require a Bearer token.
Key endpoints:
- POST /api/mcp/agents/heartbeat — report agent status
- GET /api/mcp/tasks — list available tasks
- POST /api/mcp/tasks/claim — claim a task
- POST /api/mcp/tasks/{id}/result — submit task results
- GET /api/mcp/messages/sync — check for messages

You manage your own runtime. Emperor provides the durable state, task leasing, and context.`,
        postInstallChecklist: [
            "Get a Bearer token from Emperor Settings → Access Tokens",
            "Configure your MCP client to point to {url}/api/mcp",
            "Register your agent via POST /api/mcp/runtime/register",
            "Start sending heartbeats to POST /api/mcp/agents/heartbeat",
            "Check Emperor dashboard — agent should appear as online",
        ],
    },
    {
        id: "claude",
        name: "Claude Code",
        icon: "IconBrain",
        description:
            "Claude Code CLI as an on-demand agent. Emperor spawns claude with workspace context per task. Coming soon.",
        executionModel: "on-demand",
        status: "planned",
        prerequisites: ["Claude Code CLI", "Anthropic API key"],
        doctrinePath: null,
        configFiles: [],
        installCommands: [],
        heartbeatModel: "none",
        setupPromptPrefix: "",
        postInstallChecklist: [],
        invokeCommand: "claude --project-dir {workspace} --prompt \"{prompt}\"",
        resultCapture: "stdout",
    },
    {
        id: "codex",
        name: "OpenAI Codex",
        icon: "IconCode",
        description:
            "Codex CLI agent. API-driven with workspace resolution and tool integration. Coming soon.",
        executionModel: "on-demand",
        status: "planned",
        prerequisites: ["Codex CLI", "OpenAI API key"],
        doctrinePath: null,
        configFiles: [],
        installCommands: [],
        heartbeatModel: "none",
        setupPromptPrefix: "",
        postInstallChecklist: [],
        invokeCommand: "codex run --workspace {workspace} --task \"{task}\"",
        resultCapture: "api",
    },
    {
        id: "bash",
        name: "Bash / CLI",
        icon: "IconCommand",
        description:
            "Any shell script or CLI tool as an agent. Cron-compatible. Coming soon.",
        executionModel: "on-demand",
        status: "planned",
        prerequisites: ["Any Unix shell"],
        doctrinePath: null,
        configFiles: [],
        installCommands: [],
        heartbeatModel: "none",
        setupPromptPrefix: "",
        postInstallChecklist: [],
        invokeCommand: "bash {script}",
        resultCapture: "stdout",
    },
];

export function getProvider(id: string): AgentProvider | undefined {
    return agentProviders.find((p) => p.id === id);
}

export function getAvailableProviders(): AgentProvider[] {
    return agentProviders.filter((p) => p.status === "available");
}

/**
 * Build the full LLM setup prompt: role doctrine + provider-specific instructions.
 */
export function buildAgentSetupPrompt(
    role: AgentRoleTemplate,
    provider: AgentProvider,
    emperorUrl: string
): string {
    const lines: string[] = [];

    lines.push(`I need to set up an AI agent connected to EmperorClaw, an open-source operations platform for companies run with AI agents.`);
    lines.push(``);
    lines.push(`Repository & docs: https://github.com/emperorclaw/emperorclaw`);
    lines.push(`EmperorClaw URL: ${emperorUrl}`);
    lines.push(``);
    lines.push(`## Agent Role: ${role.emoji} ${role.title}`);
    lines.push(`${role.description}`);
    lines.push(``);
    lines.push(`## Provider: ${provider.name}`);
    lines.push(`${provider.description}`);
    lines.push(``);

    if (provider.installCommands.length > 0) {
        lines.push(`### Installation`);
        provider.installCommands.forEach((c) => lines.push(c));
        lines.push(``);
    }

    if (provider.configFiles.length > 0) {
        lines.push(`### Configuration Files`);
        provider.configFiles.forEach((f) => {
            lines.push(`**${f.name}** → \`${f.path}\``);
            lines.push(`${f.description}`);
            lines.push(`\`\`\`bash`);
            lines.push(f.template);
            lines.push(`\`\`\``);
            lines.push(``);
        });
    }

    lines.push(`### Provider-Specific Instructions`);
    lines.push(provider.setupPromptPrefix.replace(/\{url\}/g, emperorUrl));
    lines.push(``);

    lines.push(`### Doctrine Files (pre-written for ${role.title})`);
    lines.push(`Place these in: \`${provider.doctrinePath || "your agent workspace"}\``);
    lines.push(``);

    const doctrineFiles = [
        { name: "SOUL.md", content: role.soul },
        { name: "AGENTS.md", content: role.agents },
        { name: "BOOTSTRAP.md", content: role.bootstrap },
        { name: "IDENTITY.md", content: role.identity },
    ];

    doctrineFiles.forEach((f) => {
        lines.push(`#### ${f.name}`);
        lines.push(`\`\`\`markdown`);
        lines.push(f.content);
        lines.push(`\`\`\``);
        lines.push(``);
    });

    lines.push(`### Recommended Toolsets`);
    lines.push(`${role.toolsets.join(", ")}`);
    lines.push(``);

    lines.push(`### Post-Install Checklist`);
    provider.postInstallChecklist.forEach((step, i) => {
        lines.push(`${i + 1}. ${step}`);
    });
    lines.push(``);

    lines.push(`Please guide me step by step through the setup. Ask me for any information you need along the way.`);

    return lines.join("\n");
}
