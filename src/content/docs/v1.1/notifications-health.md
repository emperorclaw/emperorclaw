# Notifications & Agent Health

Two things keep a team of agents running without someone watching the app all day: **notifications** tell you when something needs you, and **agent health** shows whether each agent is actually doing its job.

## Notifications

The **bell** in the sidebar is your inbox. Everything lands there; email and a team-channel webhook are optional extra channels.

| Kind | When | Who gets it |
|---|---|---|
| Mention | An agent writes `@YourName` (display name or the part of your email before the `@`) | The person mentioned |
| Decision | An agent's message carries a ` ```choices ` block | Whoever it mentions; otherwise, in a direct thread the person who wrote there last, and in a group its human members |
| Approval | An approval is requested | Company owners and admins |
| Task assigned | A task is assigned to a person | That person |
| Agent failed | A runtime gave up on someone's message after its retries | The person who sent it |
| Incident | A **high** or **critical** incident opens | Company owners and admins |

Repeats collapse: a busy thread produces at most one notification of a kind per person every 10 minutes. Clicking a notification opens the conversation, approval, or task it is about.

### Email

**Settings → Notifications** lets each person choose which kinds also arrive by email. Email needs SMTP on the server (`SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`); without it, the in-app inbox still works. Everyone starts with every kind on.

### Team channel webhook

Admins can post notifications to **Slack**, **Discord**, or any URL that accepts JSON, and choose which kinds go there (by default: decisions, approvals, agent failures, incidents). The format is detected from the URL. **Send test** checks the connection.

A webhook URL is a credential (anyone with it can post to your channel), so it is stored **encrypted** with `EMPEROR_CLAW_MASTER_KEY` and never shown again after saving. Setting a webhook requires that key; the installer generates one.

Generic JSON payload:

```json
{ "source": "emperorclaw", "kind": "approval", "title": "Builder requests approval", "body": "Pricing page is ready to publish", "link": "https://your-emperor/approvals" }
```

## Agent health

**Agents → Health** (`/agents/health`) shows, for the last 7 days:

- **Unanswered**: messages addressed to an agent that are still waiting after 10 minutes. This is the one to watch: it is how a silently stuck agent shows up before a person notices. A request the agent answered later in the same thread doesn't count, even if an older runtime never marked it done.
- **Failed** and **retries**: messages the runtime gave up on, and failed attempts along the way.
- **Reply time** (median), requests, and replies per day.
- **Tasks**: open, overdue, and closed this week.
- **Cost** and tokens this month, and budget status.

Each agent gets a status: **Down** (offline with work waiting), **Needs attention** (unanswered or failed messages, overdue tasks, a budget stop), **Healthy**, or **Idle**. *Needs attention* at the top lists each waiting or failed message with a link to it. The page refreshes every minute. Members restricted to certain agents only see those agents.

Agents can read the same data with the MCP tool `get_agent_health` (optionally for one agent), so a lead agent can check on the team before reporting status or reassigning work.

### What feeds it

Nothing new for runtimes to report. Health is computed from what Emperor already records: message delivery states, the runtime's status updates, tasks, and usage. Two of those updates got stricter:

- When a runtime puts an in-flight message back in the queue, that counts as a failed attempt.
- When a runtime gives up on a message (`POST /api/mcp/chat/status` with `executionState: "cancelled"`, the `messageId`, and an optional `reason`), Emperor marks it **Failed after N attempts** in the chat, counts it in health, and notifies the sender. Older servers silently ignored this, which left such messages "queued" forever.
