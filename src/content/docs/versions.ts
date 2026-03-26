export interface DocVersion {
  id: string;
  label: string;
  default?: boolean;
  description: string;
  pages: DocPage[];
}

export interface DocPage {
  slug: string;
  title: string;
  file: string;
}

export const versions: DocVersion[] = [
  {
    id: 'v1.1',
    label: 'v1.1 (Latest)',
    default: true,
    description: 'Includes isShared injection, agent‑to‑agent replies, sync‑loop disabled',
    pages: [
      { slug: 'overview', title: 'Overview', file: 'overview.md' },
      { slug: 'mcp', title: 'MCP Endpoints', file: 'mcp.md' },
      { slug: 'configuration', title: 'Configuration', file: 'configuration.md' },
      { slug: 'usage', title: 'Usage Examples', file: 'usage.md' },
    ],
  },
  {
    id: 'v1.0',
    label: 'v1.0',
    default: false,
    description: 'Initial release',
    pages: [
      { slug: 'overview', title: 'Overview', file: 'overview.md' },
      { slug: 'mcp', title: 'MCP Endpoints', file: 'mcp.md' },
    ],
  },
];