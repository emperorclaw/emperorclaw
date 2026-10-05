import { DocVersion, DocPage, DOC_SECTIONS, type DocSection } from "./types";
export type { DocVersion, DocPage, DocSection };
export { DOC_SECTIONS };

// Every page lives in src/content/docs/<version>/<file>; tests check that each
// listed file exists and each file is listed, so the sidebar can't link to a
// missing page or hide a real one.
export const versions: DocVersion[] = [
  {
    id: 'v1.1',
    label: 'v1.1 (Current)',
    description: 'Current documentation for Emperor Claw 0.8.x.',
    pages: [
      { slug: 'overview', title: 'Overview', file: 'overview.md', section: 'Getting Started' },
      { slug: 'installation', title: 'Installation Guide', file: 'installation.md', section: 'Getting Started' },
      { slug: 'agent-quickstart', title: 'Your First Agent', file: 'agent-quickstart.md', section: 'Getting Started' },
      { slug: 'activation', title: 'Activation Protocol', file: 'activation.md', section: 'Getting Started' },
      { slug: 'self-hosting-upgrades', title: 'Self-Hosting, Upgrades & Google Drive', file: 'self-hosting-upgrades.md', section: 'Getting Started' },
      { slug: 'emperor-operating-pipeline', title: 'Emperor Operating Pipeline', file: 'emperor-operating-pipeline.md', section: 'Getting Started' },

      { slug: 'concepts', title: 'Core Concepts', file: 'concepts.md', section: 'Using Emperor' },
      { slug: 'lifecycle', title: 'Work Lifecycle & Approvals', file: 'lifecycle.md', section: 'Using Emperor' },
      { slug: 'messaging', title: 'Messaging, Groups & Routing', file: 'messaging.md', section: 'Using Emperor' },
      { slug: 'rich-replies', title: 'Rich Replies: Charts, Tabs & Widgets', file: 'rich-replies.md', section: 'Using Emperor' },
      { slug: 'notifications-health', title: 'Notifications, Health & Daily Review', file: 'notifications-health.md', section: 'Using Emperor' },
      { slug: 'company-brain', title: 'Company Brain', file: 'company-brain.md', section: 'Using Emperor' },
      { slug: 'resources-as-wiki-memory', title: 'Resources As Wiki Memory', file: 'resources-as-wiki-memory.md', section: 'Using Emperor' },
      { slug: 'pipelines', title: 'Pipelines Registry', file: 'pipelines.md', section: 'Using Emperor' },
      { slug: 'incidents', title: 'Incidents & Watchdogs', file: 'incidents.md', section: 'Using Emperor' },
      { slug: 'retention', title: 'Archiving & Retention', file: 'retention.md', section: 'Using Emperor' },
      { slug: 'limits', title: 'Current Platform Limits', file: 'limits.md', section: 'Using Emperor' },
      { slug: 'best-practices', title: 'Best Practices', file: 'best-practices.md', section: 'Using Emperor' },
      { slug: 'usage', title: 'Usage Examples', file: 'usage.md', section: 'Using Emperor' },

      { slug: 'hermes-runtime', title: 'Hermes Agent Runtime', file: 'hermes-runtime.md', section: 'Agent Runtimes' },
      { slug: 'openclaw-agents', title: 'OpenClaw Agent Runtime', file: 'openclaw-agents.md', section: 'Agent Runtimes' },
      { slug: 'agent-operating-manual', title: 'Agent Operating Manual', file: 'agent-operating-manual.md', section: 'Agent Runtimes' },
      { slug: 'skill-development', title: 'Plugin & Runtime Development', file: 'skill-development.md', section: 'Agent Runtimes' },

      { slug: 'external-requests', title: 'Send Work From Your Platform', file: 'external-requests.md', section: 'Integrations & Reference' },
      { slug: 'desk-display', title: 'Desk Display', file: 'desk-display.md', section: 'Integrations & Reference' },
      { slug: 'mcp', title: 'MCP Server & Payloads', file: 'mcp.md', section: 'Integrations & Reference' },
      { slug: 'api-reference', title: 'API Reference', file: 'api-reference.md', section: 'Integrations & Reference' },
      { slug: 'configuration', title: 'Configuration Reference', file: 'configuration.md', section: 'Integrations & Reference' },
      { slug: 'troubleshooting', title: 'Troubleshooting', file: 'troubleshooting.md', section: 'Integrations & Reference' },
    ]
  },
];
