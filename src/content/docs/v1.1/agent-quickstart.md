# Your first working Hermes agent

For a new installation, follow [Installation](/docs/v1.1/installation) first.

1. On the dashboard click **Hire an Agent** in the first-agent setup.
2. Pick a role and a short name. Choose an LLM provider and enter its API key.
3. Click **Create** and keep the dialog open. Emperor configures Hermes, its
   plugin, credentials, and an isolated worker automatically.
4. Wait for **online** on the dashboard; a created profile or started container
   alone does not confirm runtime connectivity.
5. Send **Hello! Reply with ACK working.** in onboarding's private chat. Finish
   setup after the worker replies.
6. Create a short project (for example **Acme Launch**), add a task with expected
   output and acceptance criteria, and assign it to the worker.
7. In team chat, use the **@ picker** to address an agent. No mention is needed
   in private chat. Human @names are text, not guaranteed notifications.
8. Put reusable instructions in Knowledge & Rules. Enable auto-injection only
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
