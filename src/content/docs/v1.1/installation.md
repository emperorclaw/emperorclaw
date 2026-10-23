# Install EmperorClaw and your first agent

The easiest complete setup is Docker on your own computer or server. The
installer handles the database, secrets, migrations, persistent storage, and the
connection needed to create Hermes workers. No Git, Node.js, PostgreSQL, Python,
or Hermes installation is needed on your computer.

## 1. Install and start Docker

- **Windows:** install [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/), complete its setup (including WSL 2 if prompted), and use Linux containers.
- **Mac:** install [Docker Desktop](https://docs.docker.com/desktop/setup/install/mac-install/) for your machine and open it.
- **Linux/server:** follow [Docker Engine installation](https://docs.docker.com/engine/install/) for your distribution and install its Compose plugin. Start Docker and ensure your account can run `docker info`.

The installer can install Docker Engine on Ubuntu/Debian using Docker’s official repository (sudo may ask for your password), Docker Desktop through Homebrew on Mac when available, or winget on Windows. Otherwise it opens or prints the matching install guide. Finish any OS prompts. If Docker Desktop is installed but not running, the installer starts it and waits up to three minutes for its engine (`Waiting for Docker to start... 45s`) before asking you to start it and rerun. This is a one-time prerequisite.
Use a machine that stays on while agents are working. The current images target
amd64; Apple Silicon requires Docker Desktop's amd64 emulation.

## 2. Install Emperor

On Mac/Linux, open Terminal and paste:

```bash
curl -fsSL https://raw.githubusercontent.com/emperorclaw/emperorclaw/main/install.sh | bash
```

On Windows, open PowerShell and paste:

```powershell
irm https://raw.githubusercontent.com/emperorclaw/emperorclaw/main/install.ps1 | iex
```

When run from a terminal, the installer first asks **Domain for HTTPS (leave
blank for local only)**. Press Enter for a local install, or type a domain to set
up HTTPS as described [below](#optional-your-own-domain-with-automatic-https).
Before starting the app it warns if port 3000 (and 80/443 with a domain) is
already used by another program.

Wait for **Ready!**. The installer checks app/database readiness and verifies
Docker access for local worker creation. It opens your browser when supported;
otherwise open [http://localhost:3000/signup](http://localhost:3000/signup).
Create your admin account. The first account administers the self-hosted instance
and can use its update controls without manually configuring an email allowlist.

If you are connected to a remote server, localhost is that server, not your
laptop. Use the domain setup below, or an SSH tunnel for local access:

```bash
ssh -L 3000:localhost:3000 your-user@your-server
```

Then open localhost:3000 on your laptop while the tunnel is connected.

## 3. Create your first Hermes worker

After you create your account, **Emperor setup** opens on the dashboard and walks
you through your company, your AI model key, and your first team: tell it
about your company, paste a model API key (OpenRouter is recommended and starts on
a free model; the key is checked before anything starts), pick a suggested team,
and launch. Hermes, the plugin, an agent-bound token, and the connection are
configured automatically. Your provider supplies the model and bills API usage;
the key is the one external credential you supply. Your lead agent then documents
the company in Knowledge & Rules while you watch.

The agent runtime image is a one-time download of about 3.8 GB. The server starts
it in the background as soon as it boots, so it is often finished before you
reach the last step; if not, setup shows its download progress. Set
`EMPEROR_HERMES_PREFETCH=0` in `.env` to download it only on the first hire.

When your lead is online, open its direct chat and say hello. Then create a short project, add a
bounded task, and assign it to the worker. In team chat use the @ picker to
address agents. See [First agent walkthrough](/docs/v1.1/agent-quickstart).

## Optional: your own domain with automatic HTTPS

First point the domain's DNS A record at your server. If you add an AAAA record,
it must point at the same server's reachable IPv6 address. Allow inbound TCP
ports **80 and 443**, and ensure another web server is not already using them.
The installer configures Caddy to obtain and renew certificates automatically.
You do not need to write reverse-proxy configuration yourself.

Answer the installer's domain question, or pass the domain up front:

```bash
curl -fsSL https://raw.githubusercontent.com/emperorclaw/emperorclaw/main/install.sh | bash -s -- --domain claw.example.com
```

On Windows (works under the default execution policy):

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/emperorclaw/emperorclaw/main/install.ps1))) -Domain claw.example.com
```

For unattended installs (cloud-init, CI), skip the question with `--no-prompt`
(`-NoPrompt` on Windows) or `EMPEROR_INSTALL_NONINTERACTIVE=1`; without a domain
the install stays local. Without a terminal the question is skipped automatically.

Once ready, open **https://claw.example.com/signup**. Domain settings also work
when rerunning the installer; existing secrets and data are kept. Public DNS and
network/firewall configuration belong to your hosting provider and cannot be
created by this installer. [Caddy HTTPS requirements](https://caddyserver.com/docs/automatic-https).

## Restart, update, and recover

By default files live in `~/emperorclaw`. Data lives in persistent Docker volumes.
The app/database and enabled HTTPS service restart automatically after Docker
starts. On desktop systems, enable Docker Desktop startup at login if you want
workers available after a reboot.

```bash
cd ~/emperorclaw
docker compose ps
docker compose logs --tail=100 app postgres
bash scripts/update.sh --docker
```

Windows update: `.\scripts\update.ps1 -Docker` from the install folder.
Stop with `docker compose down`; start again with `docker compose up -d`.
Do not use `down -v`: it deletes data volumes. Keep `.env` backed up securely;
your encryption key is needed to read stored credentials. See
[Upgrades and backups](/docs/v1.1/self-hosting-upgrades).

The installer can be rerun to repair blank secrets or socket group settings. It
stops with concrete recovery instructions on startup failure instead of claiming
success. If a worker was created but failed to start, retry local setup for that
worker instead of repeatedly creating new profiles.

## Other deployment paths

Hosted services without Docker socket access can run Emperor, but require a
worker on another machine. They do not provide the local click-to-create flow.
Use [Hermes runtime setup](/docs/v1.1/hermes-runtime) for remote workers. Source
builds require Node.js and PostgreSQL and are described in the upgrade guide.
