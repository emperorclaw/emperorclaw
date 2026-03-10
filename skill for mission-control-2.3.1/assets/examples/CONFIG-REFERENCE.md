# Mission Control Configuration Reference

Die Konfigurationsdatei wird unter `~/.clawdbot/mission-control.json` erwartet.

## Felder

### `gateway`

| Feld | Typ | Default | Env Variable | Beschreibung |
|------|-----|---------|--------------|--------------|
| `url` | string | `http://127.0.0.1:18789` | `CLAWDBOT_GATEWAY` | Clawdbot Gateway URL |
| `hookToken` | string | `""` | `CLAWDBOT_HOOK_TOKEN` | Hook Token für authentifizierte Webhook-Aufrufe. Finde in `~/.clawdbot/clawdbot.json` unter `hooks.token` |

### `workspace`

| Feld | Typ | Default | Env Variable | Beschreibung |
|------|-----|---------|--------------|--------------|
| `path` | string | `~/clawd` | `MC_WORKSPACE` | Absoluter Pfad zum Workspace-Verzeichnis |
| `tasksFile` | string | `data/tasks.json` | - | Relativer Pfad zur tasks.json (vom workspace aus) |
| `snapshotFile` | string | `data/.tasks-snapshot.json` | - | Relativer Pfad zum Snapshot für Diff-Berechnung |
| `debugLog` | string | `data/.webhook-debug.log` | - | Relativer Pfad zum Debug-Log |

### `slack`

| Feld | Typ | Default | Env Variable | Beschreibung |
|------|-----|---------|--------------|--------------|
| `botToken` | string | `""` | `SLACK_BOT_TOKEN` | Slack Bot Token (beginnt mit `xoxb-`) |
| `channel` | string | `""` | `SLACK_CHANNEL` | Slack Channel ID (Format: `C0123456789`, ohne #) |

### `secrets`

| Feld | Typ | Default | Beschreibung |
|------|-----|---------|--------------|
| `webhookSecretFile` | string | `~/.clawdbot/secrets/github-webhook-secret` | Pfad zur Datei mit dem GitHub Webhook Secret |
| `githubTokenFile` | string | `~/.config/gh/hosts.yml` | Pfad zur gh CLI Token-Datei |

### `agent`

| Feld | Typ | Default | Beschreibung |
|------|-----|---------|--------------|
| `sessionPrefix` | string | `hook:mission-control` | Session-Prefix für Hook-Agents |
| `defaultTimeout` | number | `300` | Default Timeout für einzelne Tasks (Sekunden) |
| `epicTimeoutBase` | number | `600` | Basis-Timeout für EPICs (Sekunden) |
| `epicTimeoutPerChild` | number | `300` | Zusätzlicher Timeout pro Child-Task bei EPICs |

## Hinweise

- **Alle Felder sind optional** — nicht gesetzte Felder nutzen ihre Defaults
- **Environment Variables überschreiben Defaults**, aber die Config-Datei überschreibt Environment Variables
- **Secrets sollten nie in der Config-Datei stehen** — nutze `secrets.webhookSecretFile` um auf eine separate Datei zu verweisen

## Minimale Config

Wenn du nur die Defaults ändern willst, reicht eine minimale Config:

```json
{
  "gateway": {
    "hookToken": "dein-hook-token"
  },
  "workspace": {
    "path": "/path/to/your/workspace"
  },
  "slack": {
    "botToken": "xoxb-...",
    "channel": "C0123456789"
  }
}
```
