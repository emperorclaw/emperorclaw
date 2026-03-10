# How Mission Control Works

A technical overview for those who want to understand the architecture.

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                           GitHub                                     │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐  │
│  │   Repository    │───▶│  GitHub Pages   │    │    Webhooks     │  │
│  │ (data/tasks.json)    │   (Dashboard)   │    │ (push events)   │  │
│  └────────┬────────┘    └─────────────────┘    └────────┬────────┘  │
└───────────┼────────────────────────────────────────────┼────────────┘
            │                                             │
            │ git push                                    │ HTTPS POST
            │                                             ▼
┌───────────┼─────────────────────────────────────────────────────────┐
│           │              Local Machine                              │
│           │                                                          │
│  ┌────────┴────────┐    ┌─────────────────┐    ┌─────────────────┐  │
│  │   Workspace     │    │ Tailscale Funnel│◀───│ GitHub Webhook  │  │
│  │ (local clone)   │    │ (HTTPS tunnel)  │    │                 │  │
│  └────────┬────────┘    └────────┬────────┘    └─────────────────┘  │
│           │                      │                                   │
│           │                      ▼                                   │
│           │             ┌─────────────────┐                          │
│           │             │    Clawdbot     │                          │
│           │             │    Gateway      │                          │
│           │             │  (port 18789)   │                          │
│           │             └────────┬────────┘                          │
│           │                      │                                   │
│           │                      ▼                                   │
│           │             ┌─────────────────┐                          │
│           │             │   Transform     │                          │
│  ┌────────┴────────┐    │  (diff logic)   │                          │
│  │   mc-update.sh  │◀───│                 │                          │
│  │   (CLI tool)    │    └────────┬────────┘                          │
│  └─────────────────┘             │                                   │
│                                  ▼                                   │
│                         ┌─────────────────┐                          │
│                         │      Agent      │                          │
│                         │ (executes task) │                          │
│                         └─────────────────┘                          │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Component Details

### 1. Dashboard (GitHub Pages)

A single-page HTML app that:
- Loads tasks.json via GitHub API
- Displays Kanban board with drag-and-drop
- Commits changes back to the repository

**Authentication:** Uses GitHub Personal Access Token stored in browser localStorage.

**Deployment:** Automatic via GitHub Actions on every push.

### 2. Webhook Transform

Located at `~/.clawdbot/hooks-transforms/github-mission-control.mjs`.

When GitHub sends a push webhook:

1. **Validates HMAC** — Ensures request is from GitHub (using shared secret)
2. **Checks branch** — Only processes main/master
3. **Checks files** — Only processes if tasks.json was modified
4. **Loads snapshot** — Reads previous tasks.json state from `.tasks-snapshot.json`
5. **Fetches new state** — Uses GitHub Git Blob API to get exact file at commit SHA
6. **Calculates diff** — Compares old vs new to detect:
   - New tasks
   - Deleted tasks
   - Status changes
   - New comments
7. **Triggers agent** — If any task moved to `in_progress`, wakes the agent with a work order

### 3. Git Blob API (Cache-Busting)

Why not just `git pull`? Because:
- GitHub's content API caches responses
- Even with `?ref=<sha>`, caching can return stale data

The solution uses **Git Blob API**:
```
GET /repos/{owner}/{repo}/git/commits/{sha}    → Get commit's tree SHA
GET /repos/{owner}/{repo}/git/trees/{tree_sha} → Find blob SHA for tasks.json
GET /repos/{owner}/{repo}/git/blobs/{blob_sha} → Get raw file content (base64)
```

This guarantees we get the exact file at the exact commit — no caching issues.

### 4. Snapshot System

File: `<workspace>/data/.tasks-snapshot.json`

Purpose: Remember the previous state to calculate diffs.

Flow:
1. **Before processing:** Load snapshot as "old state"
2. **Fetch from GitHub:** Get "new state" via Blob API
3. **Calculate diff:** Compare old vs new
4. **After processing:** Save new state as snapshot

The snapshot file is gitignored to avoid conflicts.

### 5. HMAC Validation

GitHub signs webhooks with HMAC-SHA256.

Verification:
```javascript
const hmac = createHmac('sha256', secret);
hmac.update(rawBody);
const expected = 'sha256=' + hmac.digest('hex');

// Timing-safe comparison to prevent timing attacks
timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
```

The secret is stored in `~/.clawdbot/secrets/github-webhook-secret`.

---

## Data Flow: Task Execution

1. **Human** moves task to "In Progress" in dashboard
2. **Dashboard** commits + pushes to GitHub
3. **GitHub** sends webhook to Tailscale Funnel URL
4. **Clawdbot Gateway** receives POST at `/hooks/github`
5. **Transform** validates HMAC, fetches new tasks.json, calculates diff
6. **Transform** detects status change → generates work order message
7. **Transform** calls `/hooks/agent` to wake agent with work order
8. **Agent** receives message, reads task details
9. **Agent** executes task (coding, searching, API calls, etc.)
10. **Agent** uses `mc-update.sh` to update task status and add comments
11. **mc-update.sh** commits and pushes changes
12. **GitHub Pages** updates dashboard
13. **Human** sees result, reviews, moves to Done

---

## Configuration

All settings in `~/.clawdbot/mission-control.json`:

```json
{
  "gateway": {
    "url": "http://127.0.0.1:18789",
    "hookToken": "from hooks.token in clawdbot.json"
  },
  "workspace": {
    "path": "/absolute/path/to/workspace",
    "tasksFile": "data/tasks.json",
    "snapshotFile": "data/.tasks-snapshot.json"
  },
  "slack": {
    "botToken": "xoxb-...",
    "channel": "C0123456789"
  },
  "agent": {
    "defaultTimeout": 300,
    "epicTimeoutBase": 600,
    "epicTimeoutPerChild": 300
  }
}
```

Environment variables can override any setting (useful for CI/testing):
- `CLAWDBOT_GATEWAY`
- `CLAWDBOT_HOOK_TOKEN`
- `MC_WORKSPACE`
- `SLACK_BOT_TOKEN`
- `SLACK_CHANNEL`

---

## Security Considerations

1. **Webhook Secret** — Random 32+ byte secret, shared between GitHub and Clawdbot
2. **HMAC Validation** — Every webhook is verified before processing
3. **Tailscale Funnel** — Traffic goes through Tailscale's infrastructure, not open internet
4. **GitHub Token** — Stored in gh CLI config, used for API authentication
5. **No Credentials in Code** — All secrets loaded from config files

---

## EPIC Handling

EPICs are parent tasks containing multiple child tickets.

Detection:
- Tag contains `epic`, or
- Title contains `EPIC:` or `🎯`

Child Task Discovery:
1. EPIC subtasks have format `MC-XXX-001: Title`
2. Transform extracts prefix, converts to ID (`mc_xxx_001`)
3. Finds matching task in tasks.json

Processing:
- All children are included in work order
- Agent works through them sequentially
- Timeout is extended: `base + (children × perChild)`
