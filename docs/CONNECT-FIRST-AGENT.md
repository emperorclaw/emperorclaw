# Create your first Hermes agent

The recommended Docker install runs Hermes for you. You do not need to install
Hermes, Python, a plugin, or a bridge, or manually create an Emperor token.

## Before you start

- Install Emperor using the [beginner installation guide](../src/content/docs/v1.1/installation.md).
- Open the app and create your first admin account.
- Have an LLM provider API key. Your provider supplies the model and bills usage;
  an ordinary chat subscription does not necessarily include API access.

## 1. Create a worker

On the dashboard choose **Create your first Hermes agent → Hire an Agent**.
Choose a role and a short name. Select your provider, paste its API key, and click
**Create**. Keep the dialog open. The first runtime image download may take a few
minutes. Emperor creates an isolated container, installs the bundled Hermes
plugin, generates an agent-bound token, and configures its connection and model.

Existing workers with stored keys appear as reusable configurations when you
create additional workers. You can give a worker a separate key later.

## 2. Confirm connection

The dashboard checks every five seconds. Wait until it reports your worker
**online**. “Started” in setup results means the container started; online means
the runtime checked in. An offline profile alone does not mean setup succeeded.

## 3. Test a private message

Use the onboarding chat and send **Hello! Reply with ACK working.** Wait for a
reply, then click **I received a reply — finish setup**. You can also open
**Agents → your agent → Direct Chat**. No @mention is needed in private chat.

## 4. Give it useful work

1. Create a short project such as **Acme Launch**. Put details in memory/tasks.
2. Add a task with an actionable title, expected deliverable, and acceptance criteria.
3. Assign it to your worker. Chat mentions alone do not assign tasks.
4. In team chat, use the **@ picker** to address the agent with a concrete request.
5. Add Knowledge & Rules for reusable instructions. Enable **Inject into matching
   agents** only for compact rules needed repeatedly; put reports in Storage.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| Local setup unavailable | Start Docker and rerun the installer. It repairs socket group configuration and verifies app access. |
| Permission to hire denied | Sign in with the first admin account or ask your admin. |
| Setup failed | Expand the result for the error. If an agent ID exists, retry its local setup from agent details instead of creating duplicates. |
| Worker stays offline | Check setup results, then `docker compose logs --tail=100 app` and the worker container logs in Docker Desktop. |
| Online but no reply | Check the provider key, API billing/credit, selected model, and worker logs. Online checks connectivity, not model credentials. |
| Team chat gets no reply | Use the @ picker and a distinct agent name. Test direct chat first. Loop guards can pause agent-to-agent exchanges until a human posts. |
| Budget paused | Check Budgets and the worker's configured limit. |
| Public address fails | Check DNS and inbound ports 80/443, then `docker compose logs --tail=50 caddy`. |

For workers on another machine or hosted services without Docker socket access,
use the [remote Hermes runtime guide](../src/content/docs/v1.1/hermes-runtime.md).
