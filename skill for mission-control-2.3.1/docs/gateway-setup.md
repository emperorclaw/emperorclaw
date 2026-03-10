# Gateway Setup Guide

Mission Control connects to an OpenClaw Gateway to manage cron jobs in real-time. This guide explains how to configure the connection.

## 1. Gateway URL

The Gateway URL is the address where your OpenClaw instance is running.

### Where to find it

| Setup | URL | Notes |
|-------|-----|-------|
| **Local** | `http://localhost:18789` | Default OpenClaw port, auto-detected |
| **Remote (ngrok)** | `https://your-subdomain.ngrok.app` | Via `ngrok http 18789` |
| **Remote (Tailscale)** | `http://your-machine:18789` | Via Tailscale network |
| **Reverse proxy** | `https://gateway.yourdomain.com` | Via nginx, Caddy, etc. |

### How to set it

1. Open Mission Control dashboard
2. Click **⚙️ Settings** (top-right)
3. Enter your Gateway URL in the **OpenClaw Gateway** section
4. Click **Connect** — the status will show ✅ if reachable

**Quick setup via URL parameter:**
```
https://your-dashboard.github.io/mission-control/?gateway=http://localhost:18789
```
The gateway URL is saved to localStorage and the parameter is removed from the URL.

## 2. Gateway Token

The Gateway Token authenticates your dashboard requests to the gateway.

### Where to find it

**Option A:** Check your OpenClaw config file:
```bash
cat ~/.openclaw/config.json | jq '.gateway.auth.token'
```

**Option B:** Use the CLI:
```bash
openclaw gateway config
```

The token is typically a random string generated during OpenClaw setup.

### How to set it

1. Open **⚙️ Settings** in Mission Control
2. Paste your token in the **Gateway Token** field
3. Click **Save**

The token is stored per-gateway-URL in your browser's localStorage (never sent to GitHub).

### When is it required?

- **Always** when the gateway has authentication enabled (default)
- Without a valid token, cron operations will fail with `401 Unauthorized`

## 3. CORS Proxy (Optional)

A CORS proxy is only needed when the dashboard and gateway are on **different origins** (e.g., GitHub Pages accessing a remote gateway).

### When you need it

| Dashboard | Gateway | CORS Proxy? |
|-----------|---------|-------------|
| `localhost:8080` | `localhost:18789` | ❌ No (same origin) |
| `file:///index.html` | `localhost:18789` | ❌ No (file protocol OK) |
| `your-site.github.io` | `localhost:18789` | ❌ No (localhost only) |
| `your-site.github.io` | `https://remote.ngrok.app` | ✅ **Yes** |

### How to set it up

1. Copy the proxy script:
   ```bash
   cp scripts/cors-proxy.js /path/to/your/setup/
   ```

2. Run it alongside your gateway:
   ```bash
   node scripts/cors-proxy.js
   # CORS proxy on :18790 → http://localhost:18789
   ```

3. Point your tunnel at the proxy port (18790) instead of the gateway port (18789):
   ```bash
   ngrok http 18790
   ```

4. Use the tunnel URL as your Gateway URL in Settings.

### How it works

The proxy:
- Listens on port **18790**
- Forwards all requests to `localhost:18789` (the gateway)
- Adds `Access-Control-Allow-Origin: *` headers
- Handles `OPTIONS` preflight requests

## Troubleshooting

### "No gateway URL configured"
- Set the Gateway URL in Settings → OpenClaw Gateway

### "Gateway error 401"
- Set a valid Gateway Token in Settings

### "Gateway error 502" or connection refused
- Ensure the OpenClaw gateway is running: `openclaw gateway status`
- Check the port matches your URL

### CORS errors in browser console
- Use the CORS proxy (see section 3 above)
- Or access the dashboard from localhost
