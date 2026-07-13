import { DocVersion, DocPage } from "./types";
export type { DocVersion, DocPage };

export const versions: DocVersion[] = [
  {
    id: 'v1.1',
    label: 'v1.1 (Stable)',
    description: 'Includes the agent-first pipelines registry, isShared injection, agent-to-agent replies, and durable checkpoints.',
    pages: [
      { slug: 'overview', title: 'Overview', file: 'overview.md' },
      { slug: 'agent-quickstart', title: 'Agent Quick-Start', file: 'agent-quickstart.md' },
      { slug: 'emperor-operating-pipeline', title: 'Emperor Operating Pipeline', file: 'emperor-operating-pipeline.md' },
      { slug: 'why-emperor-vs-openclaw', title: 'Why Emperor Around Local Agents', file: 'why-emperor-vs-openclaw.md' },
      { slug: 'emperor-vs-agent-frameworks', title: 'Emperor vs. Agent Frameworks', file: 'emperor-vs-agent-frameworks.md' },
      { slug: 'resources-as-wiki-memory', title: 'Resources As Wiki Memory', file: 'resources-as-wiki-memory.md' },
      { slug: 'company-brain', title: 'Company Brain', file: 'company-brain.md' },
      { slug: 'project-architecture', title: 'Project & Runtime Architecture', file: 'project-architecture.md' },
      { slug: 'installation', title: 'Installation Guide', file: 'installation.md' },
      { slug: 'activation', title: 'Activation Protocol', file: 'activation.md' },
      { slug: 'openclaw-agents', title: 'OpenClaw Agent Runtime', file: 'openclaw-agents.md' },
      { slug: 'hermes-runtime', title: 'Hermes Agent Runtime', file: 'hermes-runtime.md' },
      { slug: 'concepts', title: 'Core Concepts', file: 'concepts.md' },
      { slug: 'lifecycle', title: 'Work Lifecycle', file: 'lifecycle.md' },
      { slug: 'pipelines', title: 'Pipelines Registry', file: 'pipelines.md' },
      { slug: 'messaging', title: 'Messaging & Inbox Rules', file: 'messaging.md' },
      { slug: 'incidents', title: 'Incidents & Watchdogs', file: 'incidents.md' },
      { slug: 'retention', title: 'Archiving & Retention', file: 'retention.md' },
      { slug: 'limits', title: 'Current Platform Limits', file: 'limits.md' },
      { slug: 'configuration', title: 'Configuration Reference', file: 'configuration.md' },
      { slug: 'usage', title: 'Usage Examples', file: 'usage.md' },
      { slug: 'skill-development', title: 'Plugin & Runtime Development', file: 'skill-development.md' },
      { slug: 'troubleshooting', title: 'Troubleshooting', file: 'troubleshooting.md' },
      { slug: 'mcp', title: 'MCP Payloads', file: 'mcp.md' },
      { slug: 'api-reference', title: 'API Reference', file: 'api-reference.md' },
      { slug: 'best-practices', title: 'Best Practices', file: 'best-practices.md' },
    ]
  },
  {
    id: 'v1.0',
    label: 'v1.0 (Legacy)',
    description: 'Initial release with basic task management.',
    pages: [
      { slug: 'overview', title: 'Overview', file: 'overview.md' },
      { slug: 'mcp', title: 'MCP Endpoints', file: 'mcp.md' },
    ]
  }
];
