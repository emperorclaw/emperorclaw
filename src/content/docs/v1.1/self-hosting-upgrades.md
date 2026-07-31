# Self-Hosting, Upgrades & Google Drive

This guide covers the EmperorClaw server. The [Installation Guide](/docs/v1.1/installation)
covers the separate OpenClaw agent plugin.

## Upgrade An Existing Docker Installation

The recommended installer creates a Git checkout, so one command updates both
the application image and its versioned Compose configuration:

```bash
cd ~/emperorclaw
./scripts/update.sh --docker
```

On Windows PowerShell:

```powershell
cd ~/emperorclaw
.\scripts\update.ps1 -Docker
```

The updater:

1. fetches the latest `docker-compose.yml` and helper scripts with a
   fast-forward-only Git pull
2. pulls the latest application image
3. recreates the containers while retaining the Postgres and storage volumes
4. runs incremental database migrations before the application starts

The Compose update is important. Pulling only the `app` image updates the
application, but it cannot add the optional Drive service, its configuration
volume, or its helper script.

If the installation is not a Git checkout, download the new release bundle and
replace `docker-compose.yml` plus `scripts/` before running:

```bash
docker compose pull app
docker compose up -d
```

Do not replace `.env`, and do not run `docker compose down -v`; the `-v` option
removes persistent volumes.

## Before And After The Upgrade

Back up Postgres and the `app-storage` volume before upgrading. The bundled
database helper is:

```bash
./scripts/backup-db.sh
```

Then verify startup and migration completion:

```bash
docker compose ps
docker compose logs --tail=100 app
```

The storage migration is deliberately non-breaking:

- it adds mirror bookkeeping tables and does not delete or rewrite artifact rows
- existing files continue to resolve through their recorded storage keys
- new Emperor folders are materialized as real storage directories
- legacy files are moved only when an operator explicitly applies reconciliation
- Google Drive synchronization remains disabled until the operator opts in

## Upgrade A Source Or Bare-Metal Installation

Use the bundled updater:

```bash
cd ~/emperorclaw
./scripts/update.sh
```

It backs up Postgres, performs a fast-forward-only pull, installs dependencies,
builds, runs migrations, and restarts a detected PM2 or Compose process. If no
process manager is detected, restart EmperorClaw manually.

## Enable The Optional Google Drive Mirror

Google Drive mirroring is supported only with the local storage backend. It is
an optional rclone sidecar sharing the same Docker `app-storage` volume as the
application. There is no second local copy and no OAuth implementation inside
EmperorClaw; rclone owns the Google token in a private Docker volume.

### 1. Upgrade First

Run the normal Docker upgrade above. Existing instances do not receive the new
`drive-sync` service from an image pull alone.

### 2. Configure Google Drive

Create a dedicated Google OAuth client ID by following the official
[rclone Drive client-ID guide](https://rclone.org/drive/#making-your-own-client-id).
This is now required for a durable installation: rclone's shared built-in
client ID is being retired during 2026.

Run the interactive helper and create a remote named `gdrive`:

```bash
docker compose --profile drive-setup run --rm drive-config
```

When prompted, enter that client ID and client secret instead of leaving them
blank. Select full Drive access; the narrower rclone-only scope cannot see
files that users upload or edit directly in Drive.

On a headless server, rclone will print a browser URL or ask for a token created
on another machine. The resulting credentials stay in the `rclone-config`
Docker volume rather than `.env`.

### 3. Add The Opt-In Settings

Append these values to `.env`:

```env
DRIVE_SYNC_ENABLED=true
STORAGE_DISCOVERY_ENABLED=true
DRIVE_RCLONE_REMOTE=gdrive
DRIVE_ROOT=Emperor-Claw
DRIVE_POLL_INTERVAL_SECONDS=5
```

Five seconds is the default near-real-time polling interval. Operators can
increase it to reduce Drive API activity.

### 4. Preview The Folder Migration

The preview is read-only:

```bash
docker compose exec app npm run storage:reconcile
```

Review the proposed directory creation and legacy-file moves. Then apply them:

```bash
docker compose exec app npm run storage:reconcile -- --apply
```

The command is repeatable. It never moves an unknown file and never overwrites
an occupied destination.

### 5. Start Synchronization

```bash
docker compose --profile drive up -d
docker compose --profile drive logs --tail=100 drive-sync
```

The sidecar copies changes in both directions every few seconds without
propagating deletions. With both defaults enabled, the Drive poll takes up to
five seconds and the visible Storage page takes up to another five seconds to
discover the change. A changed DOCX, XLSX, PPTX, PDF, or other ordinary file
therefore normally appears within a few seconds and can take about ten seconds
in the worst timing case.

Files created directly in Drive are visible in Storage with a question-mark
state. They are not exposed through artifact APIs or agent context until a user
supplies customer or project metadata in Emperor. Google-native Docs, Sheets,
and Slides are not ordinary files and are not synchronized in the first
release; use uploaded Office-format files when round-trip editing is required.

## Disable Or Roll Back Drive

Stop the optional service and turn off discovery:

```bash
docker compose --profile drive stop drive-sync
```

```env
DRIVE_SYNC_ENABLED=false
STORAGE_DISCOVERY_ENABLED=false
```

Then recreate the app so it reads the updated environment:

```bash
docker compose up -d app
```

This does not delete local files, Drive files, artifact metadata, or rclone
credentials. Existing Emperor storage continues to work normally.

## Built-In Lightweight Editing

No extra container or configuration is required to create XLSX, DOCX, CSV,
Markdown, plain-text, and JSON files. In Storage, select **New File**, choose a
format, and use **Create and edit**. Emperor creates the file in the current
physical folder through the normal artifact pipeline, so its metadata and any
Drive mirror remain synchronized. XLSX and DOCX open directly in their native
editor; CSV has grid and raw editors; JSON is validated before save.
The folder context menu also offers **New File Here**. File context menus offer
**Rename** while keeping the extension fixed, which prevents an Office or
lightweight file from becoming associated with the wrong editor.

## Built-In DOCX And XLSX Editing

Emperor also includes an optional browser editor for `.docx` and `.xlsx`
artifacts. It needs no extra container, account, OAuth flow, or environment
variable. Create a blank Office file with **New File**, or open an existing
supported file's menu and choose **Edit in Emperor**. The editor is loaded only
when that page opens, so installations that do not use it do not pay its
browser download or memory cost.

Saving replaces the existing artifact through Emperor's authenticated Storage
API. The artifact ID, metadata, permissions, physical folder, and Drive mirror
remain attached to the file. Use **Save** or `Ctrl+S` / `Cmd+S`; the header
shows whether changes are unsaved or persisted.

The editors are marked **Beta** because their upstream Extend components are
experimental. Current native editing is intentionally limited to modern
`.docx` and `.xlsx` files. Legacy `.doc` and `.xls` files remain downloadable
but are not offered in the editor. XLSX files larger than 25 MB are rejected
in the browser editor to protect self-hosted clients from excessive memory
use. Keep backups for complex Office documents and verify advanced layouts,
macros, or uncommon embedded objects after editing.

The editor libraries are MIT licensed and pinned to exact versions. Their
license text is included in `THIRD_PARTY_NOTICES.md`.

## Updating From The Dashboard

The **Settings → Updates** action can replace the running application container
and automatically run database migrations. It intentionally preserves the old
container configuration. For releases that add Compose services or volumes,
such as the Google Drive mirror, run the shell upgrade once so the host also
receives the new `docker-compose.yml` and scripts.
