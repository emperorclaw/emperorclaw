import { DocVersion, DocPage } from "./types";
export type { DocVersion, DocPage };

export const versions: DocVersion[] = [
  {
    id: 'v1.1',
    label: 'v1.1 (Stable)',
    description: 'Includes isShared injection, agent‑to‑agent replies, and durable checkpoints.',
    pages: [
      { slug: 'overview', title: 'Architecture Overview', file: 'overview.md' },
      { slug: 'installation', title: 'Installation Guide', file: 'installation.md' },
      { slug: 'activation', title: 'Activation Protocol', file: 'activation.md' },
      { slug: 'concepts', title: 'Core Concepts', file: 'concepts.md' },
      { slug: 'configuration', title: 'Configuration Reference', file: 'configuration.md' },
      { slug: 'usage', title: 'Usage Examples', file: 'v1.1/usage.md' },
      { slug: 'skill-development', title: 'Skill & Agent Development', file: 'v1.1/skill-development.md' },
      { slug: 'troubleshooting', title: 'Troubleshooting', file: 'v1.1/troubleshooting.md' },
      { slug: 'mcp', title: 'MCP Payloads', file: 'v1.1/mcp.md' },
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