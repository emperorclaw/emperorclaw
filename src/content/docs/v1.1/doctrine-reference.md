# Doctrine Reference

Where each agent rule lives, who receives it, and when. Use this page before editing doctrine: put a rule in the smallest place that still reaches the agents who need it.

## The layers

| Layer | File or place | Reaches | When | Size |
|---|---|---|---|---|
| Operating guide | `integrations/hermes/emperor-claw/operating-guide.md` | Every Hermes agent | Prepended to every turn | ~10k chars — core protocol only |
| MCP instructions | `src/lib/mcp-server/instructions.ts` | Every MCP client | On each `initialize` handshake | ~5k chars plus company notes |
| Shared Knowledge notes | Knowledge & Rules, **Inject into matching agents** on | Matching agents | Every run, within a shared budget | Each note ≤ 8000 chars; ~12000 total; the Hermes bridge sends ~6000 by default |
| Non-shared Knowledge notes | Knowledge & Rules, injection off | Any agent that asks | On demand (`get_knowledge_context`, `GET /resources/context?tag=…`) | Keep each note focused |
| Runtime skills | Hermes `skills/emperor-claw/SKILL.md`, OpenClaw `emperor-claw-os/SKILL.md` | Agents of that runtime | Loaded when the skill applies | Detailed reference |
| Group purpose | The group's settings | Every member agent | Every turn in that group | Up to 600 chars |
| Agent memory | The agent's memories (`emperor_remember`) | That agent | Every turn | A few short lines |

Injected text is paid for on every turn by every agent. Keep the always-on layers short and imperative; put detail where agents load it on demand.

## Where each team rule lives

| Rule | Operating guide / MCP instructions | Agent Operating Rules (shared) | Playbooks & templates (on demand) | Runtime skills |
|---|---|---|---|---|
| Work = a task with one owner; assignment wakes the assignee | ✓ | ✓ | ✓ | ✓ |
| Questions = private pair thread (`targetAgentId`) | ✓ | ✓ | ✓ | ✓ |
| Room posts are FYI; @mention asks one agent | ✓ | ✓ | ✓ | ✓ |
| Handoff note; review = reassign the same task | ✓ | ✓ | Templates + member playbook | Full templates |
| Roles: lead, member, reviewer | ✓ | ✓ | Lead / member playbooks | ✓ |
| Room or project lead owns unaddressed human messages | ✓ | ✓ | Groups playbook | ✓ |
| One request, one answer; no acks | ✓ | ✓ | — | ✓ |
| Escalation ladder: self → teammate → lead → human | ✓ | ✓ | Member playbook | ✓ |
| Ask a human only for irreversible or business decisions | ✓ | ✓ | Lead playbook checkpoints | ✓ |
| Lead steps: brief → plan → checkpoint → tasks → monitor → integrate → release → report | Pointer only | Pointer only | Lead playbook | ✓ |
| Kickoff format, multi-team leadership, cross-team peers | — | — | Groups playbook | ✓ |
| Status report format | — | — | Lead playbook | ✓ |
| Definition of done per kind of work | — | — | Software / content / research templates | — |
| Loop guard and stall sweep behavior | One line | — | Groups playbook | ✓ |

## Starter Knowledge notes

| Note | Folder | Injected | Tags |
|---|---|---|---|
| Company Overview | Company | Yes | `company` |
| Brand Voice | Company | Yes | `brand` |
| Agent Operating Rules | Agents | Yes (~2.3k chars) | `agents`, `team` |
| Team playbook — lead | Agents | No | `team-playbook`, `lead` |
| Team playbook — member | Agents | No | `team-playbook`, `member` |
| Team playbook — groups | Agents | No | `team-playbook`, `group` |
| Team template — software delivery | Company | No | `team-playbook`, `team-template`, `software` |
| Team template — content | Company | No | `team-playbook`, `team-template`, `content` |
| Team template — research | Company | No | `team-playbook`, `team-template`, `research` |
| Project Brief Template | Projects | No | `projects`, `template` |
| Customer Note Template | Customers | No | `customers`, `template` |

The three injected notes total about 3k characters, leaving most of the budget for your own rules.

## Placement rules

- **Every agent, every turn** → a short injected company note. One topic per note.
- **Only when leading or joining team work** → a non-shared note tagged `team-playbook`.
- **One project** → a project-scoped note.
- **One client** → a customer-scoped note.
- **One agent** → an agent-scoped note or the agent's memory.
- **One room** → the group purpose (there is no group scope).
- **Never inject** long references, drafts, logs, or anything secret.

## Related

- [Run An Agent Team](/docs/v1.1/run-an-agent-team)
- [Company Brain](/docs/v1.1/company-brain)
- [Agent Operating Manual](/docs/v1.1/agent-operating-manual)
- [Hermes Agent Runtime](/docs/v1.1/hermes-runtime)
