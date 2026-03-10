# Troubleshooting

Common issues and their solutions.

---

## 1. Dashboard Shows Sample Data

**Symptom:** Dashboard displays example tasks instead of your actual data.

**Cause:** Not authenticated with GitHub.

**Solution:**
1. Click "Connect GitHub" in the dashboard
2. Generate a Personal Access Token (PAT) at [github.com/settings/tokens](https://github.com/settings/tokens)
3. Required scopes: `repo` (full access to private repos)
4. Paste the token and click "Save"

**Verify:** After connecting, you should see your actual tasks or an empty board.

---

## 2. Webhook Not Triggering

**Symptom:** Moving tasks doesn't notify the agent.

### Check 1: Tailscale Funnel

```bash
tailscale funnel status
```

Expected output:
```
https://your-machine.tail1234.ts.net -> http://127.0.0.1:18789
```

If not running:
```bash
tailscale funnel 18789
```

### Check 2: GitHub Webhook Configuration

1. Go to repo → Settings → Webhooks
2. Click on the webhook
3. Check "Recent Deliveries"
4. Look for green checkmarks (success) or red X (failure)

**Common issues:**
- Wrong Payload URL → Update to your Tailscale Funnel URL
- Wrong Content Type → Must be `application/json`
- Missing token → Add `?token=YOUR_TOKEN` to URL

### Check 3: Clawdbot Gateway

```bash
# Check if Clawdbot is running
clawdbot gateway status

# Check logs for webhook errors
tail -50 ~/.clawdbot/logs/gateway.log | grep -i webhook
```

### Check 4: Transform Errors

Check the debug log:
```bash
cat <workspace>/data/.webhook-debug.log | tail -100
```

Look for:
- "HMAC validation failed" → Secret mismatch
- "Fetch failed" → GitHub API issue
- "No changes detected" → Snapshot out of sync

---

## 3. Changes Not Appearing in Dashboard

**Symptom:** You pushed changes but dashboard shows old data.

**Cause:** GitHub Pages caching.

**Solutions:**

1. **Hard refresh:**
   - Mac: `Cmd + Shift + R`
   - Windows/Linux: `Ctrl + Shift + R`

2. **Wait 1-2 minutes** — GitHub Pages deploy takes time

3. **Check Actions tab:**
   - Go to repo → Actions
   - Look for "pages-build-deployment" workflow
   - Check if it's running or failed

4. **Check deploy status:**
   - Go to repo → Settings → Pages
   - Look for "Your site is live at..."

---

## 4. HMAC Validation Fails

**Symptom:** Webhooks arrive but are rejected with "invalid HMAC".

**Cause:** Secret mismatch between GitHub and local config.

**Solution:**

1. Generate new secret:
```bash
openssl rand -hex 32
```

2. Update GitHub webhook:
   - Repo → Settings → Webhooks → Edit
   - Paste new secret

3. Update local secret:
```bash
echo "YOUR_NEW_SECRET" > ~/.clawdbot/secrets/github-webhook-secret
```

4. Test by making a small change and pushing.

---

## 5. Agent Doesn't Start Working

**Symptom:** Webhook arrives, transform runs, but no agent action.

### Check 1: Hook Token

Verify token in config matches `~/.clawdbot/clawdbot.json`:

```bash
# Get token from main config
grep -A2 '"hooks"' ~/.clawdbot/clawdbot.json

# Check mission-control config
cat ~/.clawdbot/mission-control.json | jq '.gateway.hookToken'
```

### Check 2: Agent Wake Call

Check debug log for agent wake results:
```bash
grep "Hook-Agent" <workspace>/data/.webhook-debug.log
```

Look for:
- "SUCCESS" → Agent was woken
- "FAILED" → Check gateway logs

### Check 3: Slack Configuration

If using Slack notifications, verify:
```bash
# Check config
cat ~/.clawdbot/mission-control.json | jq '.slack'

# Verify bot token works
curl -H "Authorization: Bearer xoxb-YOUR-TOKEN" \
     https://slack.com/api/auth.test
```

---

## 6. Git Push Fails from mc-update.sh

**Symptom:** Script updates tasks.json but can't push.

### Cause 1: Uncommitted Changes

```bash
cd <workspace>
git status
```

If there are conflicts:
```bash
git stash
git pull --rebase
git stash pop
# Resolve conflicts manually
```

### Cause 2: Authentication Issue

```bash
gh auth status
```

If not authenticated:
```bash
gh auth login
```

### Cause 3: Remote Out of Sync

```bash
git pull --rebase
git push
```

---

## 7. Snapshot Desync

**Symptom:** Webhook processes same changes repeatedly, or misses changes.

**Cause:** Local snapshot doesn't match actual state.

**Solution:**

Reset snapshot to current state:
```bash
cp <workspace>/data/tasks.json <workspace>/data/.tasks-snapshot.json
```

Or delete it (will be recreated on next webhook):
```bash
rm <workspace>/data/.tasks-snapshot.json
```

---

## 8. Transform Module Not Found

**Symptom:** Gateway logs show "transform not found" or similar.

**Cause:** Transform not installed in hooks-transforms.

**Solution:**

Copy transform to the right location:
```bash
cp <skill>/assets/transforms/github-mission-control.mjs \
   ~/.clawdbot/hooks-transforms/
```

Check hook mapping in `~/.clawdbot/clawdbot.json`:
```json
{
  "hooks": {
    "mappings": {
      "github": "github-mission-control.mjs"
    }
  }
}
```

---

## 9. GitHub API Rate Limiting

**Symptom:** Fetches fail with HTTP 403 or 429.

**Cause:** Too many API requests without authentication.

**Solution:**

Ensure gh CLI is authenticated (provides token for API calls):
```bash
gh auth status
```

The transform reads the token from `~/.config/gh/hosts.yml`.

---

## 10. Dashboard Drag-and-Drop Broken

**Symptom:** Can't drag tasks between columns.

**Causes:**
- JavaScript error → Check browser console (F12)
- Not logged in → Connect GitHub token
- Read-only token → Need `repo` scope for writes

**Debug:**
1. Open browser DevTools (F12)
2. Go to Console tab
3. Try dragging a task
4. Check for errors

---

## Still Stuck?

1. **Check all logs:**
   ```bash
   cat <workspace>/data/.webhook-debug.log
   tail -100 ~/.clawdbot/logs/gateway.log
   ```

2. **Test webhook manually:**
   ```bash
   curl -X POST "https://your-machine.ts.net/hooks/github?token=YOUR_TOKEN" \
        -H "Content-Type: application/json" \
        -d '{"zen": "test ping"}'
   ```

3. **Reset everything:**
   - Delete `~/.clawdbot/mission-control.json`
   - Delete `<workspace>/data/.tasks-snapshot.json`
   - Re-run agent setup

4. **Ask for help:**
   - GitHub Issues: [github.com/rdsthomas/mission-control/issues](https://github.com/rdsthomas/mission-control/issues)
   - Clawdbot Discord: [discord.com/invite/clawd](https://discord.com/invite/clawd)
