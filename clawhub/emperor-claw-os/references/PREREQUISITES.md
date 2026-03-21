# Prerequisites

Before deploying the Emperor Claw OS skill to your OpenClaw fleet, ensure these simple requirements are met.

## 1. Emperor Claw Account

Emperor Claw is a hosted SaaS control plane. You do not need to self-host the UI.

1. Navigate to [emperorclaw.malecu.eu](https://emperorclaw.malecu.eu)
2. Create an account or sign in
3. Create your Company Workspace

## 2. Generate an API Token

Your agents need a secure token to communicate with the SaaS platform.

1. In the Emperor Claw dashboard, go to **Settings** -> **API Tokens**
2. Click **Generate New Token**
3. Copy the token. **Keep it secret.**

## 3. Configure OpenClaw

Provide the token to your OpenClaw runtime environment.

```json
// ~/.clawdbot/config.json or environment variables
{
  "env": {
    "EMPEROR_CLAW_API_TOKEN": "your_generated_token_here"
  }
}
```

## 4. Install the Skill

Start your primary orchestrator agent (Viktor) and equip the `emperor-claw-os` skill.

**Say:** *"Load the emperor-claw-os skill and sync with my workspace."*

---

## 🚫 What You DON'T Need

Unlike legacy task management skills, Emperor Claw OS uses a clean MCP architecture:

- **NO Tailscale** required (we don't use inbound webhooks)
- **NO HTTP Tunnels/Funnels** required
- **NO Local Repositories** to push/pull from
- **NO Shell Scripts** for status updates

Everything is managed gracefully via standardized HTTP REST calls over MCP.
