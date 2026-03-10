# Clawdbot Hooks Configuration

This documents the hook-related settings in `~/.clawdbot/clawdbot.json`.

## Example Snippet

Add this to your main Clawdbot config:

```json
{
  "hooks": {
    "enabled": true,
    "token": "your-secure-token",
    "mappings": {
      "github": "github-mission-control.mjs"
    }
  }
}
```

## Fields

### `hooks.enabled`
- **Type:** boolean
- **Default:** `true`
- **Description:** Enable/disable webhook processing globally

### `hooks.token`
- **Type:** string
- **Required:** Yes
- **Description:** Token for authenticating incoming webhooks
- **Usage:** Append `?token=YOUR_TOKEN` to webhook URLs

### `hooks.mappings`
- **Type:** object (key → filename)
- **Description:** Maps webhook paths to transform modules

The key becomes the URL path. Example:
- Key: `"github"`
- URL: `https://your-machine.ts.net/hooks/github?token=...`
- Transform: `~/.clawdbot/hooks-transforms/github-mission-control.mjs`

## Multiple Hooks

You can have multiple webhook endpoints:

```json
{
  "hooks": {
    "mappings": {
      "github": "github-mission-control.mjs",
      "stripe": "stripe-payments.mjs",
      "custom": "my-custom-transform.mjs"
    }
  }
}
```

Each mapping creates:
- URL: `/hooks/{key}?token=...`
- Transform: `~/.clawdbot/hooks-transforms/{filename}`

## Security

1. **Token Required** — All webhook requests must include `?token=` 
2. **HMAC Optional** — Transforms can implement their own signature validation
3. **HTTPS via Funnel** — Tailscale Funnel provides TLS encryption

## Transform Location

Transforms must be placed in:
```
~/.clawdbot/hooks-transforms/
```

The Mission Control transform should be copied here during setup:
```bash
cp <skill>/assets/transforms/github-mission-control.mjs \
   ~/.clawdbot/hooks-transforms/
```
