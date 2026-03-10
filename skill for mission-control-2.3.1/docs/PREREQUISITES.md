# Prerequisites

Before setting up Mission Control, ensure these tools are installed and configured.

## 1. Tailscale

Tailscale creates a secure mesh network that allows GitHub webhooks to reach your local Clawdbot instance.

### Install

**macOS:**
```bash
brew install tailscale
```

**Linux:**
```bash
curl -fsSL https://tailscale.com/install.sh | sh
```

**Windows:**
Download from [tailscale.com/download](https://tailscale.com/download)

### Setup

```bash
# Start Tailscale and authenticate
tailscale up

# Check status
tailscale status
```

You'll be prompted to authenticate via browser. Once connected, your machine gets a stable hostname like `your-machine.tail1234.ts.net`.

---

## 2. Tailscale Funnel

Funnel exposes your local Clawdbot port to the internet via Tailscale's infrastructure.

### Enable (one-time)

```bash
# Expose Clawdbot's default port
tailscale funnel 18789
```

### Verify

```bash
tailscale funnel status
# Output: https://your-machine.tail1234.ts.net -> http://127.0.0.1:18789
```

**Note:** Funnel must remain enabled for webhooks to work. It survives reboots if Tailscale is running.

### Troubleshooting

If funnel fails:
```bash
# Check if Funnel is enabled for your tailnet
tailscale status

# Re-enable if needed
tailscale funnel 18789
```

---

## 3. GitHub CLI (gh)

The GitHub CLI is used for authentication and API operations.

### Install

**macOS:**
```bash
brew install gh
```

**Linux:**
```bash
# Debian/Ubuntu
sudo apt install gh

# Or via official repo
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
sudo apt update && sudo apt install gh
```

### Authenticate

```bash
gh auth login
```

Choose:
- **GitHub.com** (or your enterprise instance)
- **HTTPS**
- **Login with a web browser**

### Verify

```bash
gh auth status
# ✓ Logged in to github.com as your-username
```

---

## Quick Check

Run these commands to verify everything is ready:

```bash
# 1. Tailscale connected
tailscale status | head -3

# 2. Funnel active
tailscale funnel status

# 3. GitHub CLI authenticated
gh auth status
```

If any fail, follow the setup steps above before proceeding with Mission Control setup.

---

## Optional: Create GitHub Repository

If you don't have a workspace repo yet:

```bash
# Create new private repo
gh repo create my-workspace --private --clone

# Or use existing local folder
cd /path/to/workspace
git init
gh repo create my-workspace --private --source=. --push
```

The agent can also help you create this during setup.
