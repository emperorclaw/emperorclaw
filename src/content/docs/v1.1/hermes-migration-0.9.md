# Migrating Hermes Agents to 0.9

This guide is for anyone running Hermes agents on their own machine with the 0.3 bridge (a copied `emperor_hermes_bridge.py` and one `emperor-hermes-bridge-<agent>` systemd user unit per agent). Agents provisioned by Emperor in Docker are upgraded by Emperor; you do not need this guide for them.

**Short version:** download `emperor-hermes`, run `emperor-hermes doctor --plan`, then `emperor-hermes migrate --all`. Rollback is one command and works until you choose to finalize.

## What changes

| | Bridge 0.3 | Bridge 0.9 |
| --- | --- | --- |
| Hermes | Whatever `main` was when you installed it | **v0.22.4**, pinned to an exact commit |
| Runtime | A new `hermes chat` process per message (9–10 s start) | A warm Hermes gateway per agent. A message starts in about a second |
| Live status | Read from Hermes log files | Structured events: each tool step, reasoning, usage |
| Long sessions | Compaction could delay the next reply by 30–80 s | Compaction runs after the reply |
| Network drop mid-turn | The turn was killed | The turn continues. The reply is delivered when the network returns |
| Units | `emperor-hermes-bridge-<agent>` | `emperor-hermes-gateway@<agent>` + `emperor-hermes-bridge@<agent>` |
| Settings | Bridge env file (`~/.hermes/emperor-bridge/<agent>/.env`) | The profile `.env` (`~/.hermes/profiles/<agent>/.env`) |
| Python | System `python3` | Hermes' own Python, resolved by the installer |
| Operating guide | Injected into every message by the plugin | Part of the session instructions. The plugin no longer injects it |
| Updates | Copy files by hand | `emperor-hermes update` |

Your agents keep their Hermes profiles, memory and skills. Each Emperor thread starts a fresh Hermes session on 0.9; the bridge seeds it with the recent conversation, so agents keep the thread's context.

## Before you start

- Emperor must run 0.9.0 or later. The 0.3 bridges keep working against it, so you can upgrade the server first and the hosts later.
- Linux with systemd user units, `curl`, `git`, `tar`, `python3`, and lingering enabled (`loginctl enable-linger $USER`).
- About 3 minutes per host for the Hermes download, and a few seconds of downtime per agent.
- Optional, for your own records:

  ```bash
  mkdir -p ~/.hermes/backups/pre-0.9 && cp -a ~/.hermes/emperor-bridge ~/.hermes/backups/pre-0.9/
  systemctl --user list-units 'emperor-hermes-bridge-*' --no-legend > ~/.hermes/backups/pre-0.9/units.txt
  ```

## One-command migration

```bash
mkdir -p ~/.local/bin
curl -fsSL https://github.com/emperorclaw/emperorclaw/releases/download/v0.9.3/emperor-hermes.sh -o ~/.local/bin/emperor-hermes
chmod +x ~/.local/bin/emperor-hermes

emperor-hermes doctor --plan        # does this host fit every agent?
emperor-hermes migrate --all        # or one agent first: emperor-hermes install --profile <agent>
emperor-hermes status
```

For each agent, `migrate` does the following, in this order:

1. Checks memory (`doctor --plan`) and refuses if the agents do not fit.
2. Installs Hermes v0.22.4 into `~/.hermes/hermes-agent-v0.22.4`, **next to** your current Hermes. `~/.local/bin/hermes` and your old checkout are not touched.
3. Backs up the profile's `config.yaml`, `.env` and plugin, and copies the settings from the 0.3 bridge env file into the profile `.env` (secrets stay in files with mode 600).
4. Stops and disables the agent's 0.3 unit, and refuses to continue if another 0.3 bridge process still serves the agent. There is never more than one runtime per agent.
5. Backs up `state.db` (to `~/.hermes/backups/emperor-hermes/<agent>/state.db.pre-v0.22`) before Hermes v0.22.4 opens it.
6. Installs the 0.9 plugin, applies Emperor's profile defaults, starts the gateway, waits until it is ready, then starts the bridge.

It finds agents from your existing `emperor-hermes-bridge-*` units, including units whose name differs from the profile. Running it again is safe.

**Several agents on one host?** Migrate one first (`install --profile <agent>`), check it in Emperor for a day, then run `migrate --all`.

### Self-made 0.3 bridge watchdogs

If an agent (or you) wrote a systemd timer, service or cron job that re-enables or restarts the 0.3 bridge units, `emperor-hermes` detects it before stopping anything and refuses to migrate — it would restart the 0.3 bridges next to the 0.9 ones and create duplicate runtimes:

```text
Self-made 0.3 bridge watchdogs detected. They would restart the 0.3 bridges and create duplicate runtimes:
  - unit/timer bridge-watchdog.service (script: /usr/bin/python3 ~/.hermes/profiles/builder/scripts/bridge_watchdog.py)
  - cron: */5 * * * * systemctl --user restart emperor-hermes-bridge-builder.service
error: it would restart the 0.3 bridges and create duplicate runtimes; rerun with --disable-watchdogs to stop it, or remove it yourself
```

Remove the watchdog yourself, or let the installer stop it:

```bash
emperor-hermes migrate --all --disable-watchdogs
```

`--disable-watchdogs` stops and disables the matching timers/services and comments out the matching crontab lines (the crontab is backed up once to `~/.hermes/backups/emperor-hermes/crontab.<time>`). A full `rollback --all` re-enables the timers and un-comments those crontab lines, leaving any crontab lines you added in the meantime untouched.

## Manual path

If you prefer to see each step, do per agent what the installer does:

1. Install the pinned Hermes side by side:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/v0.22.4/scripts/install.sh -o /tmp/hermes-install.sh
   bash /tmp/hermes-install.sh --skip-setup --skip-computer-use --branch v0.22.4 --dir ~/.hermes/hermes-agent-v0.22.4
   git -C ~/.hermes/hermes-agent-v0.22.4 rev-parse HEAD   # 4d04303818b61bf3aa09278af48356315515965b
   ```

2. Find Hermes' Python. Hermes records it in `~/.hermes/installs/<key>/facts.json`, where `<key>` is the first 16 characters of the SHA-256 of the checkout's real path:

   ```bash
   VENV=$(python3 -c 'import hashlib, json, os; d = os.path.realpath(os.path.expanduser("~/.hermes/hermes-agent-v0.22.4")); k = hashlib.sha256(d.encode()).hexdigest()[:16]; print(json.load(open(os.path.expanduser("~/.hermes/installs/%s/facts.json" % k)))["packages"]["venv"]["environment"])')
   mkdir -p ~/.local/share/emperor-hermes
   printf '#!/bin/sh\nexec "%s/bin/python" "$@"\n' "$VENV" > ~/.local/share/emperor-hermes/python
   chmod 755 ~/.local/share/emperor-hermes/python
   ```

   Use a wrapper script, not a symlink: Python finds its venv from the path it was started with, so a symlink starts the bare interpreter without the venv's packages.
3. Unpack the bridge bundle (`emperor-hermes-bridge-0.9.3.tar.gz` from the release) to `~/.hermes/emperor-bridge/releases/0.9.3` and link `~/.hermes/emperor-bridge/current` to it.
4. Write `~/.config/emperor-hermes/host.env`:

   ```bash
   HERMES_LAUNCHER="/home/<user>/.hermes/hermes-agent-v0.22.4/.hermes/bin/hermes"
   HERMES_PYTHON="/home/<user>/.local/share/emperor-hermes/python"
   HERMES_CHECKOUT="/home/<user>/.hermes/hermes-agent-v0.22.4"
   EMPEROR_HERMES_PROFILES=""
   ```

5. Copy the bundle's `systemd/*.service` files to `~/.config/systemd/user/` and run `systemctl --user daemon-reload`.
6. Move the `EMPEROR_CLAW_*` settings and the model key from the 0.3 env file into `~/.hermes/profiles/<agent>/.env`. Rename `HERMES_TOOLSETS` to `EMPEROR_CLAW_HERMES_TOOLSETS`.
7. Stop the 0.3 unit: `systemctl --user disable --now emperor-hermes-bridge-<agent>`.
8. Back up the database: `python3 -c "import sqlite3; s=sqlite3.connect('state.db'); d=sqlite3.connect('state.db.pre-v0.22'); s.backup(d)"` in the profile directory.
9. Copy the bundle's `plugin/emperor-claw` to `~/.hermes/profiles/<agent>/plugins/emperor-claw`, then with the new launcher (`H=~/.hermes/hermes-agent-v0.22.4/.hermes/bin/hermes`):

   ```bash
   $H -p <agent> plugins enable emperor-claw
   $H -p <agent> config set gateway.standalone true
   $H -p <agent> config set gateway.unmanaged_idle_exit_seconds 0
   $H -p <agent> config set agent.restart_drain_timeout 30
   $H -p <agent> config set agent.clarify_timeout 60
   $H -p <agent> config set approvals.timeout 60
   $H -p <agent> config set tools.tool_search.enabled off
   $H -p <agent> config set terminal.client_env_passthrough '["EMPEROR_THREAD_ID","EMPEROR_THREAD_TYPE","EMPEROR_SESSION_GEN","EMPEROR_AGENT_ID","EMPEROR_PROFILE_HOME"]'
   ```

   Also apply the lines returned by `GET /api/mcp/runtime/profile-defaults` on your Emperor server.

10. Start: `systemctl --user enable --now emperor-hermes-gateway@<agent>`, wait a few seconds, then `systemctl --user enable --now emperor-hermes-bridge@<agent>`.

## Small machines (Raspberry Pi): shared gateway

A warm Hermes gateway uses about 300 MiB. Four agents in standalone mode need about 1.4 GiB, which a 4 GB Pi with other services often does not have. `doctor --plan` measures the free memory (counting what the 0.3 bridges free when they stop) and prints one of:

```text
PLAN: standalone x4
PLAN: shared (requires --gateway shared; read the trade-off first)
PLAN: move. Keep at most 1 standalone here; move to another host: qa growth katarina
```

With **shared**, one gateway and one bridge process serve every agent on the host (about 0.4–0.5 GiB for four agents):

```bash
emperor-hermes migrate --all --gateway shared --max-parallel 1
```

The installer shows this trade-off and asks you to confirm it (`--yes` skips the prompt):

1. Every agent on the host runs in one process. A bug or a malicious tool could use another agent's Emperor token, and actions would be attributed to the wrong agent.
2. On a single-user host the agents' files are already readable by each other. The new exposure is in-process only.
3. One gateway crash, restart or model-key rotation interrupts every agent on the host. Use `emperor-hermes restart-gateway --shared --when-idle`.

Shared mode is only allowed when every agent on the host belongs to **one Emperor company**, one operator and one OS user. The bridge checks this with Emperor and refuses to dispatch otherwise.

Check memory after the agents have been busy for a while:

```bash
emperor-hermes doctor --measure
```

Switch one agent back to its own gateway at any time: `emperor-hermes install --profile <agent> --gateway standalone`. If nothing fits, the plan lists the agents to run on a bigger host: install them there with `emperor-hermes install --profile <agent>` (copy the profile `.env` over), then on the small host run `systemctl --user disable --now emperor-hermes-bridge-<agent>`.

## Rollback

```bash
emperor-hermes rollback --profile <agent>     # or --all
```

This stops the 0.9 units, restores `state.db`, `config.yaml`, `.env` and the plugin from the backups, and restarts the 0.3 unit. The 0.22 database is kept beside it as `state.db.v0.22-rollback-<time>`. Before `finalize`, rollback takes seconds because your old Hermes and bridge files were never changed.

Other rollbacks:

| Situation | Command |
| --- | --- |
| A new bridge bundle misbehaves after `update` | `emperor-hermes rollback --bridge-only` |
| After `finalize` | `emperor-hermes rollback --all` restores the archived checkout, `~/.local/bin/hermes` and the 0.3 units first |
| After `finalize --purge` | Reinstall the old Hermes commit (saved in `~/.local/share/emperor-hermes/host.state`) into `~/.hermes/hermes-agent`, then run rollback |

## Finalize

After a week without problems:

```bash
emperor-hermes finalize
```

It points `~/.local/bin/hermes` at v0.22.4, removes the 0.3 units and bridge file (copies are kept in `~/.hermes/backups/emperor-hermes/host/`) and archives the old Hermes checkout there. `finalize --purge` deletes the old checkout instead.

## Deprecation timeline

| Version | Bridge 0.3 |
| --- | --- |
| 0.9.x | Works, marked as a legacy bridge on the agent |
| 0.10.0 | **No longer supported.** Migrate before upgrading Emperor to 0.10.0 |

## FAQ

**Do I need to stop my agents first?** No. The installer stops each 0.3 unit right before starting its replacement. Messages sent during the switch are picked up when the new bridge starts.

**Can I keep some agents on 0.3?** Yes, until 0.10.0. Each agent is migrated independently, and the 0.3 bridges keep using the old Hermes checkout.

**Will my agents lose their memory?** No. Profiles, memory, skills and `SOUL.md` stay as they are. Each thread starts a new Hermes session, seeded with the thread's recent messages.

**Where did my bridge settings go?** Into the profile `.env`. The 0.3 env file is left in place, unused.

**How do I rotate the Emperor token?** Edit the profile `.env`. The next tool call uses the new token. For the model key, also run `emperor-hermes restart-gateway --profile <agent> --when-idle`.

**`doctor --plan` says `move`. What now?** Run the listed agents on another host, or keep them on 0.3 until the host has more memory. `install --force` overrides the plan, at the risk of running out of memory.

**I already run my own Hermes gateway (for example `hermes-gateway-<profile>.service` for messaging).** The installer never replaces a gateway it did not start: `doctor` lists them and `install`/`migrate` refuse. Stop them yourself, or pass `--take-over-gateway` to have the installer stop and disable them. A full rollback restores them as they were.

**`install`/`migrate` refuses with "Self-made 0.3 bridge watchdogs detected".** Some agent or an old script re-enables the 0.3 bridge units, which would create duplicate runtimes. Remove it yourself, or re-run with `--disable-watchdogs` (see [Self-made 0.3 bridge watchdogs](#self-made-03-bridge-watchdogs)); a full `rollback --all` restores it later.

**Does the installer need sudo?** No. Everything runs as your user. Enabling lingering may need an administrator once.
