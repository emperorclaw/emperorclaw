# Connect your first agent

EmperorClaw is the control plane — it holds your projects, tasks, messages, and
knowledge. The **thinking** happens in an *agent runtime* that runs next to it and
talks to it over the API. This guide gets one agent online and replying to chat.

> ⏱️ ~5 minutes once you have an LLM API key. Installing the runtime is the only
> real step; everything else is copy-paste.

## Prerequisites

- A running EmperorClaw instance (see the main README) and an admin login.
- An **LLM API key** for one provider (DeepSeek, OpenAI, Anthropic, Google, …).
  The agent does its thinking with this — there is no built-in model.
- macOS or Linux with Python 3.9+.

---

## 1. Create an access token

In EmperorClaw: **Settings → Access Tokens → Create access token**. Copy the
token (starts with `ec_`) — you'll only see it once.

```bash
export EMPEROR_CLAW_API_URL="http://localhost:3000"   # your instance URL
export EMPEROR_CLAW_API_TOKEN="ec_...paste-here..."
```

## 2. Install the Hermes runtime

We use [Hermes](https://github.com/NousResearch/hermes-agent) — it auto-registers
the agent for you and gets full access to Emperor's tools.

```bash
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash -s -- --skip-setup
export PATH="$HOME/.local/bin:$PATH"
hermes version                       # confirm it's on PATH
hermes profile create viktor --clone --description "My first Emperor agent"
```

## 3. Install the Emperor plugin into the profile

```bash
git clone https://github.com/emperorclaw/emperorclaw.git /tmp/ec 2>/dev/null || true
mkdir -p ~/.hermes/profiles/viktor/plugins
cp -R /tmp/ec/integrations/hermes/emperor-claw ~/.hermes/profiles/viktor/plugins/emperor-claw
hermes -p viktor plugins enable emperor-claw
```

## 4. Give the agent its model key and start the bridge

Set the API key for the provider you'll use (this example: DeepSeek), name the
agent, and run the bridge — it registers the agent and starts polling.

```bash
export DEEPSEEK_API_KEY="sk-...your-key..."   # or OPENAI_API_KEY / ANTHROPIC_API_KEY / …
export EMPEROR_CLAW_AGENT_NAME="Viktor"

python3 /tmp/ec/integrations/hermes/emperor-claw/bridge/emperor_hermes_bridge.py
```

You should see it heartbeat and, in EmperorClaw under **Agents**, "Viktor" turn
**online**. Leave this process running.

## 5. Say hello

In EmperorClaw: **Agents → Viktor → Direct Chat**, send:

> Hello, please reply with just: ACK working

Within ~15s the agent replies in the thread. 🎉 It can now also read/write your
projects, tasks, and knowledge base through its Emperor tools.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Agent stays **offline** | The bridge process must keep running. Check its logs for `heartbeat failed` (wrong `EMPEROR_CLAW_API_URL`/token). |
| No reply arrives | Confirm the LLM key env var matches the agent's provider, and that `hermes version` works. Watch the bridge output for errors. |
| "Budget exhausted / paused" | The agent hit its monthly budget. Raise it in **Budgets**, or set the budget to 0 (unlimited). |
| Wrong/expensive model | Set the agent's model in **Budgets** (the server treats your UI choice as authoritative). |
| 401 from the API | The token is wrong or revoked. Create a new one in Settings → Access Tokens. |

## Alternative: Codex runtime

Prefer OpenAI's [Codex CLI](https://github.com/openai/codex)? Use
`integrations/codex/emperor-codex-bridge.js` (Node). It's lighter but chat-only
(no Emperor tools), and you must create the agent in the UI first and pass its id:

```bash
export EMPEROR_CLAW_AGENT_ID="<uuid from the Agents page>"
node integrations/codex/emperor-codex-bridge.js
```

## What's next

- Add more agents: repeat with a new profile + `EMPEROR_CLAW_AGENT_NAME`.
- Run bridges as services so they survive reboots (see `ecosystem.config.js` /
  your process manager).
- Give agents durable context by writing **Knowledge & Rules** notes in Resources.
