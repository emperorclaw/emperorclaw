import { DocVersion, DocPage } from "./types";
export type { DocVersion, DocPage };

export const versions: DocVersion[] = [
  {
    id: 'v1.1',
    label: 'v1.1 (Stable)',
    description: 'Includes isShared injection, agent-to-agent replies, and durable checkpoints.',
    pages: [
      { slug: 'overview', title: 'Architecture Overview', file: 'overview.md' },
      { slug: 'installation', title: 'Installation Guide', file: 'installation.md' },
      { slug: 'activation', title: 'Activation Protocol', file: 'activation.md' },
      { slug: 'concepts', title: 'Core Concepts', file: 'concepts.md' },
      { slug: 'lifecycle', title: 'Work Lifecycle', file: 'lifecycle.md' },
      { slug: 'messaging', title: 'Messaging & Inbox Rules', file: 'messaging.md' },
      { slug: 'incidents', title: 'Incidents & Watchdogs', file: 'incidents.md' },
      { slug: 'retention', title: 'Archiving & Retention', file: 'retention.md' },
      { slug: 'limits', title: 'Current Platform Limits', file: 'limits.md' },
      { slug: 'configuration', title: 'Configuration Reference', file: 'configuration.md' },
      { slug: 'usage', title: 'Usage Examples', file: 'usage.md' },
      { slug: 'skill-development', title: 'Skill & Agent Development', file: 'skill-development.md' },
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
