# Your first working Hermes agent

For a new installation, follow [Installation](/docs/v1.1/installation) first.

The first time an owner or admin opens the dashboard, **Emperor setup** opens: a full-screen assistant that takes about three minutes.

1. **Your company.** Name, what it does and for whom, the kind of company, your website, and any house rules (one per line). Every agent reads this.
2. **AI model.** Pick OpenRouter (recommended; starts on a free model) or DeepSeek and paste your API key. Emperor checks the key with the provider before going on, because agents can't answer without one. The key is stored encrypted.
3. **Your team.** A team is suggested for your kind of company: the Boss (team lead) plus specialists. Keep it small (up to four here); rename anyone. You can hire more later in Agents.
4. **Launch.** Emperor starts each agent and shows them coming online. If you kept **Have my lead agent document the company** on, your lead gets its first job as soon as it's online: turn the profile and website into Knowledge & Rules notes (overview, products and services, customers, brand voice) and ask you what it couldn't find. You watch it happen, with links to its chat and the task.
5. Click **Open direct chat** to talk to your lead. **Set up later** closes the assistant; hire agents any time from **Agents**.

If this installation can't start agents itself (no Docker socket), the assistant saves your company and points you to [connecting a Hermes agent](/docs/v1.1/hermes-runtime) instead.

## Then

1. Create a short project (for example **Acme Launch**), add a task with expected
   output and acceptance criteria, and assign it to the worker.
2. In team chat, use the **@ picker** to address an agent. No mention is needed
   in private chat. When an agent @mentions a person by name, that person gets a
   notification (see [Notifications & Agent Health](/docs/v1.1/notifications-health)).
3. Put reusable instructions in Knowledge & Rules. Enable auto-injection only
   for short rules needed repeatedly in that scope. Put deliverables in Storage.

## If something fails

- **Local setup unavailable:** start Docker, then rerun the installer to repair
  and verify socket access. Hosted services without a socket need remote workers.
- **Setup failed:** expand the result and read its error. If it created a profile,
  open that profile and retry local setup instead of creating duplicates.
- **Offline:** open the agent details and inspect setup results. Check the worker
  logs in Docker Desktop and `docker compose logs --tail=100 app`.
- **Online, no reply:** confirm the provider key, billing credit, and model; check
  Budgets and the worker's logs. A heartbeat does not validate the LLM key.
- **Group chat gets no reply:** select the agent with the @ picker and try a
  direct message. The loop guard pauses repeated agent exchanges until a human
  posts; do not work around it.

Additional workers can reuse an existing Hermes configuration. Each has a
separate container, volume, and token. Agents can hire workers with
`emperor_create_agent`; check its returned success and agent ID before assigning
work. Remote workers use the [Hermes runtime guide](/docs/v1.1/hermes-runtime).
