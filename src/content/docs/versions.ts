import { DocVersion } from "./types";

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
      { slug: 'mcp', title: 'MCP Endpoints', file: 'mcp.md' },
      { slug: 'api-reference', title: 'API Reference', file: 'api-reference.md' },
      { slug: 'best-practices', title: 'Doctrine & Best Practices', file: 'best-practices.md' },
      { slug: 'usage', title: 'Usage Examples', file: 'usage.md' },
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