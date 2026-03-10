/**
 * GitHub Webhook Transform - Mission Control (Dynamic Config)
 * 
 * Vergleicht tasks.json vor/nach Push und generiert detaillierte Events.
 * Bei Tasks die nach "in_progress" verschoben werden: Arbeitsanweisung generieren.
 * 
 * DYNAMISCH: Lädt Config aus ~/.clawdbot/mission-control.json
 * Extrahiert Repo-Info aus Webhook-Payload statt hardcoded.
 * 
 * v2.0.0 - Config-driven, kein Hardcoding mehr
 */

import { readFileSync, existsSync, writeFileSync, appendFileSync, mkdirSync } from 'fs';
import { createHmac, timingSafeEqual } from 'crypto';
import { homedir } from 'os';
import { join, dirname } from 'path';

// ============================================================================
// CONFIG LOADING
// ============================================================================

const CONFIG_FILE = join(homedir(), '.clawdbot', 'mission-control.json');
const DEFAULT_CONFIG = {
  // Clawdbot Gateway
  gateway: {
    url: process.env.CLAWDBOT_GATEWAY || 'http://127.0.0.1:18789',
    hookToken: process.env.CLAWDBOT_HOOK_TOKEN || ''
  },
  // Workspace (wo tasks.json liegt)
  workspace: {
    path: process.env.MC_WORKSPACE || join(homedir(), 'clawd'),
    tasksFile: 'data/tasks.json',
    snapshotFile: 'data/.tasks-snapshot.json',
    debugLog: 'data/.webhook-debug.log'
  },
  // Slack (optional)
  slack: {
    botToken: process.env.SLACK_BOT_TOKEN || '',
    channel: process.env.SLACK_CHANNEL || ''
  },
  // Secrets
  secrets: {
    webhookSecretFile: join(homedir(), '.clawdbot', 'secrets', 'github-webhook-secret'),
    githubTokenFile: join(homedir(), '.config', 'gh', 'hosts.yml')
  },
  // Hook-Agent Settings
  agent: {
    sessionPrefix: 'hook:mission-control',
    defaultTimeout: 300,
    epicTimeoutBase: 600,
    epicTimeoutPerChild: 300
  }
};

let _config = null;

/**
 * Lädt Config aus ~/.clawdbot/mission-control.json
 * Fallback auf Environment Variables und Defaults
 */
function loadConfig() {
  if (_config) return _config;
  
  let fileConfig = {};
  
  if (existsSync(CONFIG_FILE)) {
    try {
      const raw = readFileSync(CONFIG_FILE, 'utf8');
      fileConfig = JSON.parse(raw);
    } catch (e) {
      console.error(`Failed to parse ${CONFIG_FILE}:`, e.message);
    }
  }
  
  // Deep merge: fileConfig > env > defaults
  _config = {
    gateway: {
      ...DEFAULT_CONFIG.gateway,
      ...fileConfig.gateway
    },
    workspace: {
      ...DEFAULT_CONFIG.workspace,
      ...fileConfig.workspace
    },
    slack: {
      ...DEFAULT_CONFIG.slack,
      ...fileConfig.slack
    },
    secrets: {
      ...DEFAULT_CONFIG.secrets,
      ...fileConfig.secrets
    },
    agent: {
      ...DEFAULT_CONFIG.agent,
      ...fileConfig.agent
    }
  };
  
  return _config;
}

/**
 * Berechnet absolute Pfade basierend auf Config
 */
function getPaths(config) {
  const wsPath = config.workspace.path;
  return {
    tasksFile: join(wsPath, config.workspace.tasksFile),
    snapshotFile: join(wsPath, config.workspace.snapshotFile),
    debugLog: join(wsPath, config.workspace.debugLog)
  };
}

// ============================================================================
// LOGGING
// ============================================================================

function log(msg, config) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${msg}\n`;
  try {
    const paths = getPaths(config);
    // Stelle sicher, dass das Verzeichnis existiert
    const logDir = dirname(paths.debugLog);
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }
    appendFileSync(paths.debugLog, line);
  } catch (e) {
    console.error(line);
  }
}

// ============================================================================
// REPO INFO FROM WEBHOOK
// ============================================================================

/**
 * Extrahiert Repository-Info aus dem Webhook-Payload
 */
function extractRepoInfo(payload) {
  const repo = payload.repository || {};
  return {
    owner: repo.owner?.login || repo.owner?.name || '',
    name: repo.name || '',
    fullName: repo.full_name || '',
    isPrivate: repo.private || false,
    defaultBranch: repo.default_branch || 'main',
    // Konstruiert API-URLs
    apiBase: `https://api.github.com/repos/${repo.full_name || ''}`
  };
}

// ============================================================================
// GITHUB API
// ============================================================================

/**
 * Liest GitHub Token aus gh CLI Config
 */
function getGitHubToken(config) {
  try {
    const tokenFile = config.secrets.githubTokenFile;
    if (!existsSync(tokenFile)) return '';
    
    const ghConfig = readFileSync(tokenFile, 'utf8');
    const match = ghConfig.match(/oauth_token:\s*(\S+)/);
    return match ? match[1] : '';
  } catch (e) {
    return '';
  }
}

/**
 * Fetcht tasks.json über GitHub Git Blob API (cache-busting)
 */
async function fetchTasksFromGitHub(repoInfo, commitSha, config) {
  const token = getGitHubToken(config);
  const headers = {
    'Accept': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  
  // 1. Commit holen
  const commitResp = await fetch(`${repoInfo.apiBase}/git/commits/${commitSha}`, { headers });
  if (!commitResp.ok) throw new Error(`Commit fetch failed: ${commitResp.status}`);
  const commitData = await commitResp.json();
  
  // 2. Tree holen
  const treeResp = await fetch(`${repoInfo.apiBase}/git/trees/${commitData.tree.sha}?recursive=1`, { headers });
  if (!treeResp.ok) throw new Error(`Tree fetch failed: ${treeResp.status}`);
  const treeData = await treeResp.json();
  
  // 3. tasks.json Blob finden
  const tasksPath = config.workspace.tasksFile;
  const tasksBlob = treeData.tree.find(f => f.path === tasksPath);
  if (!tasksBlob) throw new Error(`${tasksPath} not found in tree`);
  
  // 4. Blob Content holen
  const blobResp = await fetch(`${repoInfo.apiBase}/git/blobs/${tasksBlob.sha}`, { headers });
  if (!blobResp.ok) throw new Error(`Blob fetch failed: ${blobResp.status}`);
  const blobData = await blobResp.json();
  
  // 5. Base64 dekodieren
  const content = Buffer.from(blobData.content, 'base64').toString('utf8');
  return JSON.parse(content);
}

// ============================================================================
// HMAC VERIFICATION
// ============================================================================

function verifyHmac(rawBody, signature, config) {
  try {
    const secretFile = config.secrets.webhookSecretFile;
    if (!existsSync(secretFile)) return true; // Kein Secret = skip validation
    
    const secret = readFileSync(secretFile, 'utf8').trim();
    const hmac = createHmac('sha256', secret);
    hmac.update(rawBody);
    const expectedSignature = 'sha256=' + hmac.digest('hex');
    
    const sigBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSignature);
    
    if (sigBuffer.length !== expectedBuffer.length) return false;
    return timingSafeEqual(sigBuffer, expectedBuffer);
  } catch (e) {
    console.error('HMAC verification error:', e);
    return false;
  }
}

// ============================================================================
// AGENT WAKE
// ============================================================================

async function wakeAgent(message, taskId, config, timeoutSeconds) {
  const timeout = timeoutSeconds || config.agent.defaultTimeout;
  
  try {
    const response = await fetch(`${config.gateway.url}/hooks/agent`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.gateway.hookToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: message,
        name: 'MissionControl',
        sessionKey: `${config.agent.sessionPrefix}:${taskId}`,
        wakeMode: 'now',
        deliver: true,
        channel: 'slack',
        to: config.slack.channel ? `channel:${config.slack.channel}` : undefined,
        timeoutSeconds: timeout
      })
    });
    
    const result = await response.json();
    return response.ok;
  } catch (e) {
    return false;
  }
}

// ============================================================================
// SLACK MESSAGING
// ============================================================================

async function sendSlackMessage(text, config) {
  if (!config.slack.botToken || !config.slack.channel) {
    return false;
  }
  
  try {
    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.slack.botToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        channel: config.slack.channel,
        text: text,
        mrkdwn: true
      })
    });
    const result = await response.json();
    return result.ok;
  } catch (e) {
    return false;
  }
}

// ============================================================================
// EPIC HANDLING
// ============================================================================

function isEpic(task) {
  if (task.tags && task.tags.includes('epic')) return true;
  if (task.title && (task.title.includes('EPIC:') || task.title.includes('🎯'))) return true;
  return false;
}

function findChildTasks(epicTask, allTasks) {
  const childTasks = [];
  const subtasks = epicTask.subtasks || [];
  
  for (const subtask of subtasks) {
    const match = subtask.title.match(/^([A-Z0-9-]+):/);
    if (match) {
      const prefix = match[1].toLowerCase().replace(/-/g, '_');
      const childTask = allTasks.find(t => t.id === prefix || t.id.startsWith(prefix));
      if (childTask) childTasks.push(childTask);
    }
  }
  
  return childTasks;
}

// ============================================================================
// DIFF CALCULATION
// ============================================================================

function calculateDiff(oldTasks, newTasks) {
  const events = [];
  const oldMap = new Map(oldTasks.map(t => [t.id, t]));
  const newMap = new Map(newTasks.map(t => [t.id, t]));
  
  // Neue Tasks
  for (const [id, task] of newMap) {
    if (!oldMap.has(id)) {
      events.push({ type: 'created', task: { id: task.id, title: task.title, status: task.status } });
    }
  }
  
  // Gelöschte Tasks
  for (const [id, task] of oldMap) {
    if (!newMap.has(id)) {
      events.push({ type: 'deleted', task: { id: task.id, title: task.title } });
    }
  }
  
  // Geänderte Tasks
  for (const [id, newTask] of newMap) {
    const oldTask = oldMap.get(id);
    if (!oldTask) continue;
    
    if (oldTask.status !== newTask.status) {
      events.push({
        type: 'moved',
        task: { id: newTask.id, title: newTask.title },
        from: oldTask.status,
        to: newTask.status
      });
      continue;
    }
    
    const oldComments = oldTask.comments || [];
    const newComments = newTask.comments || [];
    if (newComments.length > oldComments.length) {
      events.push({
        type: 'commented',
        task: { id: newTask.id, title: newTask.title, status: newTask.status },
        comment: newComments[newComments.length - 1]
      });
    }
  }
  
  return events;
}

// ============================================================================
// MESSAGE FORMATTING
// ============================================================================

function formatWorkOrder(inProgressTasks, newTasks) {
  const lines = [];
  lines.push('🤖 **ARBEITSAUFTRAG - Bitte ausführen:**\n');
  
  for (const task of inProgressTasks) {
    const fullTask = (newTasks.tasks || []).find(t => t.id === task.id) || task;
    
    lines.push(`**Task-ID:** ${fullTask.id}`);
    lines.push(`**Titel:** ${fullTask.title}`);
    
    if (fullTask.description) lines.push(`**Aufgabe:** ${fullTask.description}`);
    if (fullTask.dod) lines.push(`**Definition of Done:** ${fullTask.dod}`);
    
    if (fullTask.subtasks && fullTask.subtasks.length > 0) {
      lines.push(`**Subtasks:**`);
      for (const sub of fullTask.subtasks) {
        const check = sub.done ? '✅' : '⬜';
        lines.push(`${check} ${sub.title}`);
      }
    }
    
    if (fullTask.comments && fullTask.comments.length > 0) {
      const lastComment = fullTask.comments[fullTask.comments.length - 1];
      lines.push(`**Letzter Kommentar** (${lastComment.author}):`);
      lines.push(`> ${lastComment.text}`);
    }
    
    lines.push('');
  }
  
  lines.push('---');
  lines.push('Führe diese Aufgabe jetzt aus. Nach Abschluss: Ticket auf "Review" setzen und Ergebnis als Kommentar dokumentieren.');
  
  return lines.join('\n');
}

function formatEpicWorkOrder(epicTask, childTasks) {
  const lines = [];
  
  lines.push('🎯 **EPIC ARBEITSAUFTRAG**\n');
  lines.push(`**EPIC:** ${epicTask.title}`);
  if (epicTask.description) lines.push(`**Beschreibung:** ${epicTask.description}`);
  lines.push('');
  lines.push(`**Dieses EPIC enthält ${childTasks.length} Tickets die nacheinander abgearbeitet werden sollen:**`);
  lines.push('');
  
  for (let i = 0; i < childTasks.length; i++) {
    const child = childTasks[i];
    lines.push(`---`);
    lines.push(`### ${i + 1}. ${child.title}`);
    lines.push(`**Task-ID:** ${child.id}`);
    
    if (child.description) lines.push(`**Aufgabe:** ${child.description}`);
    if (child.dod) lines.push(`**Definition of Done:** ${child.dod}`);
    
    if (child.subtasks && child.subtasks.length > 0) {
      lines.push(`**Subtasks:**`);
      for (const sub of child.subtasks) {
        const check = sub.done ? '✅' : '⬜';
        lines.push(`${check} ${sub.title}`);
      }
    }
    lines.push('');
  }
  
  lines.push('---');
  lines.push('');
  lines.push('**ANWEISUNGEN:**');
  lines.push('1. Arbeite die Tickets in der Reihenfolge 1 bis ' + childTasks.length + ' ab');
  lines.push('2. Nach jedem Ticket:');
  lines.push('   - Füge einen Kommentar mit dem Ergebnis hinzu');
  lines.push('   - Setze das Ticket auf "review"');
  lines.push('   - Markiere die entsprechende Subtask im EPIC als done');
  lines.push('3. Nach dem letzten Ticket: Setze das EPIC auf "review"');
  lines.push('');
  lines.push('**Starte jetzt mit Ticket 1:** ' + childTasks[0].title);
  
  return lines.join('\n');
}

function formatStartNotification(actor, inProgressTasks, epicInfo) {
  const lines = [];
  lines.push(`📋 **Mission Control Update** (von ${actor})`);
  lines.push('');
  
  for (const task of inProgressTasks) {
    if (epicInfo && epicInfo.epicTask.id === task.id) {
      lines.push(`🎯 **EPIC: ${task.title}** → In Progress`);
      lines.push(`   _${epicInfo.childTasks.length} Child-Tickets werden sequentiell abgearbeitet_`);
    } else {
      lines.push(`🚀 **${task.title}** → In Progress`);
    }
  }
  
  lines.push('');
  lines.push('🤖 _Hintergrund-Agent startet Bearbeitung..._');
  
  return lines.join('\n');
}

function formatNotification(events, actor) {
  const lines = [];
  lines.push(`📋 **Mission Control Update** (von ${actor})`);
  lines.push('');
  
  for (const event of events.slice(0, 5)) {
    switch (event.type) {
      case 'moved':
        const emoji = event.to === 'done' ? '✅' : event.to === 'review' ? '👀' : '📌';
        lines.push(`${emoji} **${event.task.title}**: ${event.from} → ${event.to}`);
        break;
      case 'created':
        lines.push(`✨ **Neu:** ${event.task.title}`);
        break;
      case 'commented':
        lines.push(`💬 **Kommentar** auf "${event.task.title}"`);
        break;
    }
  }
  
  if (events.length > 5) {
    lines.push(`_...und ${events.length - 5} weitere Änderungen_`);
  }
  
  return lines.join('\n');
}

// ============================================================================
// MAIN TRANSFORM
// ============================================================================

export default async function transform(ctx) {
  const config = loadConfig();
  const paths = getPaths(config);
  const payload = ctx?.payload || {};
  const headers = ctx?.headers || {};
  
  log('=== WEBHOOK RECEIVED (Dynamic Config v2.0) ===', config);
  
  // === HMAC VALIDIERUNG ===
  const signature = headers['x-hub-signature-256'] || headers['X-Hub-Signature-256'];
  if (signature && ctx.rawBody) {
    const isValid = verifyHmac(ctx.rawBody, signature, config);
    if (!isValid) {
      log('HMAC validation failed', config);
      return { deliver: false, message: '[skip: invalid HMAC]' };
    }
  }
  
  // === PING EVENT ===
  if (payload.zen) {
    log('Ping event received', config);
    return {
      message: `🏓 **GitHub Webhook verbunden!**\n_"${payload.zen}"_`,
      deliver: true
    };
  }
  
  // === REPO INFO AUS PAYLOAD ===
  const repoInfo = extractRepoInfo(payload);
  log(`Repo: ${repoInfo.fullName}`, config);
  
  // === NUR PUSH AUF MAIN/MASTER ===
  const ref = payload.ref || '';
  if (!ref.includes('main') && !ref.includes('master')) {
    log(`Skip: not main branch (ref=${ref})`, config);
    return { deliver: false, message: '[skip: not main branch]' };
  }
  
  // === NUR WENN TASKS.JSON GEÄNDERT ===
  const commits = payload.commits || [];
  const touchedFiles = commits.flatMap(c => [
    ...(c.added || []), 
    ...(c.modified || []), 
    ...(c.removed || [])
  ]);
  
  const tasksPath = config.workspace.tasksFile;
  if (!touchedFiles.some(f => f.includes('tasks.json'))) {
    log(`Skip: tasks.json not modified (files=${touchedFiles.join(',')})`, config);
    return { deliver: false, message: '[skip: tasks.json not modified]' };
  }
  
  log('tasks.json was modified, processing...', config);
  
  // === SNAPSHOT LADEN (VOR FETCH) ===
  let oldTasks = { tasks: [] };
  
  if (existsSync(paths.snapshotFile)) {
    try {
      oldTasks = JSON.parse(readFileSync(paths.snapshotFile, 'utf8'));
      log(`Loaded snapshot: ${oldTasks.tasks?.length || 0} tasks`, config);
    } catch (e) {
      log(`Snapshot read error: ${e.message}`, config);
    }
  } else if (existsSync(paths.tasksFile)) {
    try {
      oldTasks = JSON.parse(readFileSync(paths.tasksFile, 'utf8'));
      log(`Using current file as baseline: ${oldTasks.tasks?.length || 0} tasks`, config);
    } catch (e) {
      log(`Current file read error: ${e.message}`, config);
    }
  }
  
  // === FETCH VON GITHUB GIT BLOB API ===
  let newTasks = { tasks: [] };
  try {
    const latestCommit = commits[commits.length - 1];
    const commitSha = latestCommit?.id || payload.after || payload.head_commit?.id || '';
    
    if (!commitSha) {
      log('No commit SHA found - skipping (non-push event?)', config);
      return { deliver: false, message: '[skip: no commit SHA]' };
    }
    
    log(`Fetching from GitHub API for commit ${commitSha.substring(0, 7)}`, config);
    
    newTasks = await fetchTasksFromGitHub(repoInfo, commitSha, config);
    log(`Fetched: ${newTasks.tasks?.length || 0} tasks`, config);
    
    // Lokal speichern
    try {
      const tasksDir = dirname(paths.tasksFile);
      if (!existsSync(tasksDir)) mkdirSync(tasksDir, { recursive: true });
      writeFileSync(paths.tasksFile, JSON.stringify(newTasks, null, 2));
    } catch (e) {
      log(`Local file write error: ${e.message}`, config);
    }
  } catch (e) {
    log(`Fetch failed: ${e.message}`, config);
    return {
      message: `⚠️ **GitHub Fetch fehlgeschlagen**\n\`\`\`${e.message}\`\`\``,
      deliver: true
    };
  }
  
  // === DIFF BERECHNEN ===
  const events = calculateDiff(oldTasks.tasks || [], newTasks.tasks || []);
  log(`Diff result: ${events.length} events`, config);
  
  if (events.length === 0) {
    log('No changes detected', config);
    return { deliver: false, message: '[skip: no task changes detected]' };
  }
  
  // === SNAPSHOT AKTUALISIEREN ===
  try {
    const snapshotDir = dirname(paths.snapshotFile);
    if (!existsSync(snapshotDir)) mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(paths.snapshotFile, JSON.stringify(newTasks, null, 2));
    log('Snapshot updated', config);
  } catch (e) {
    log(`Snapshot update error: ${e.message}`, config);
  }
  
  // === IN_PROGRESS TASKS ===
  const inProgressTasks = events
    .filter(e => e.type === 'moved' && e.to === 'in_progress')
    .map(e => (newTasks.tasks || []).find(t => t.id === e.task.id) || e.task);
  
  const actor = payload.pusher?.name || payload.sender?.login || 'Unbekannt';
  
  if (inProgressTasks.length > 0) {
    // === EPIC-ERKENNUNG ===
    let epicInfo = null;
    
    for (const task of inProgressTasks) {
      if (isEpic(task)) {
        const childTasks = findChildTasks(task, newTasks.tasks || []);
        if (childTasks.length > 0) {
          epicInfo = { epicTask: task, childTasks };
          log(`EPIC detected: ${task.id} with ${childTasks.length} child tasks`, config);
          break;
        }
      }
    }
    
    // 1. START-BENACHRICHTIGUNG
    const startMsg = formatStartNotification(actor, inProgressTasks, epicInfo);
    await sendSlackMessage(startMsg, config);
    log('Start notification sent', config);
    
    // 2. AGENT STARTEN
    if (epicInfo) {
      const workOrder = formatEpicWorkOrder(epicInfo.epicTask, epicInfo.childTasks);
      const timeout = config.agent.epicTimeoutBase + (epicInfo.childTasks.length * config.agent.epicTimeoutPerChild);
      log(`Waking agent for EPIC, timeout=${timeout}s`, config);
      await wakeAgent(workOrder, epicInfo.epicTask.id, config, timeout);
    } else {
      const workOrder = formatWorkOrder(inProgressTasks, newTasks);
      log(`Waking agent for ${inProgressTasks.length} tasks`, config);
      await wakeAgent(workOrder, inProgressTasks[0].id, config);
    }
  } else {
    // Nur Benachrichtigung
    const notifyMsg = formatNotification(events, actor);
    await sendSlackMessage(notifyMsg, config);
  }
  
  log('=== WEBHOOK COMPLETE ===\n', config);
  
  return {
    deliver: false,
    metadata: { events, inProgressTasks, processed: true, repo: repoInfo.fullName }
  };
}
