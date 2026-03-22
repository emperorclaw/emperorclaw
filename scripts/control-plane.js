#!/usr/bin/env node

/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");

const SCRIPT_ENTRY = __filename;
const SCRIPT_DIR = __dirname;
const REPO_ROOT = path.resolve(__dirname, "..");
const STANDALONE_BRIDGE_ENTRY = path.join(SCRIPT_DIR, "bridge.js");
const DEFAULT_OPENCLAW_HOME = path.join(os.homedir(), ".openclaw");
const DEFAULT_COMPANION_DIR = path.join(
  DEFAULT_OPENCLAW_HOME,
  "emperor-control-plane",
);
const DEFAULT_CONFIG_PATH = path.join(
  DEFAULT_COMPANION_DIR,
  "bridge.config.json",
);
const DEFAULT_BRIDGE_ENTRY = process.env.EMPEROR_CLAW_BRIDGE_ENTRY
  || (fs.existsSync(STANDALONE_BRIDGE_ENTRY)
    ? STANDALONE_BRIDGE_ENTRY
    : path.join(
      REPO_ROOT,
      "clawhub",
      "emperor-claw-os",
      "examples",
      "bridge.js",
    ));
const DEFAULT_API_BASE_URL =
  process.env.EMPEROR_CLAW_API_URL || "http://localhost:3000";

function printUsage() {
  console.log(`Usage:
  node scripts/control-plane.js bootstrap [options]
  node scripts/control-plane.js doctor [options]
  node scripts/control-plane.js sync [options]
  node scripts/control-plane.js repair [options]
  node scripts/control-plane.js session-inspect [options]

Commands:
  bootstrap   Create a local OpenClaw companion directory, launch wrappers, and
              a safe config file around the shipped Emperor bridge.
  doctor      Verify MCP/runtime connectivity end to end against a live Emperor
              server: token, websocket, runtime register, session, heartbeat,
              thread send, checkpoint, and session end.
  sync        Pull a live control-plane snapshot and persist it to the local
              companion state directory without mutating Emperor data.
  repair      Rewrite local companion files from the saved config, then run a
              fresh sync so the operator can see what is still broken.
  session-inspect
              Inspect the current runtime/session context using local state,
              configured agent identity, and live health checks where available.

Options:
  --api-base-url <url>   Emperor base URL. Default: ${DEFAULT_API_BASE_URL}
  --token <token>        Company token. Default: EMPEROR_CLAW_API_TOKEN
  --config <path>        Companion config path. Default: ${DEFAULT_CONFIG_PATH}
  --openclaw-home <dir>  OpenClaw home directory. Default: ${DEFAULT_OPENCLAW_HOME}
  --workspace <dir>      OpenClaw workspace path. Default: <openclaw-home>/workspace
  --bridge-state-path <path>
                         Explicit bridge state file path. Default: <openclaw-home>/emperor-control-plane/state/bridge-state.json
  --agent-name <name>    Diagnostic/bridge agent name. Default: emperor-doctor
  --agent-id <id>        Optional agent UUID for session-inspect and doctor flows.
  --runtime-id <id>      Runtime id. Default: emperor-doctor-<hostname>
  --session-id <id>      Optional session id for session-inspect reporting.
  --json                 Print the command snapshot as JSON where supported.
  --skip-validate        Bootstrap only: write files without validating API access
  -h, --help            Show this help
`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "-h" || token === "--help") {
      args.help = true;
      continue;
    }
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeTextFile(filePath, content, mode) {
  fs.writeFileSync(filePath, content, "utf8");
  if (mode) {
    fs.chmodSync(filePath, mode);
  }
}

function inferWsUrl(apiBaseUrl) {
  if (apiBaseUrl.startsWith("https://")) {
    return `${apiBaseUrl.replace(/^https:/, "wss:")}/api/mcp/ws`;
  }
  return `${apiBaseUrl.replace(/^http:/, "ws:")}/api/mcp/ws`;
}

function headers(token, extra = {}) {
  const base = {
    Accept: "application/json",
    ...extra,
  };
  if (token) {
    base.Authorization = `Bearer ${token}`;
  }
  return base;
}

async function httpJson(method, url, token, body, extraHeaders = {}) {
  const response = await fetch(url, {
    method,
    headers: headers(token, {
      "Content-Type": "application/json",
      ...extraHeaders,
    }),
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }

  if (!response.ok) {
    const message =
      parsed && typeof parsed.error === "string"
        ? parsed.error
        : `${response.status} ${response.statusText}`;
    throw new Error(`${method} ${url} failed: ${message}`);
  }

  return parsed;
}

async function validateApiAccess(apiBaseUrl, token) {
  if (!token) {
    throw new Error(
      "Token is required for validation. Pass --token or export EMPEROR_CLAW_API_TOKEN.",
    );
  }
  await httpJson("GET", `${apiBaseUrl}/api/mcp/agents?limit=1`, token);
}

function bootstrapPayload(args) {
  const openclawHome = path.resolve(
    args["openclaw-home"] || DEFAULT_OPENCLAW_HOME,
  );
  const companionDir = path.join(openclawHome, "emperor-control-plane");
  const stateDir = path.join(companionDir, "state");
  const configPath = path.resolve(
    args.config || path.join(companionDir, "bridge.config.json"),
  );
  const bridgeStatePath = path.resolve(
    args["bridge-state-path"] || path.join(stateDir, "bridge-state.json"),
  );
  const workspace = path.resolve(
    args.workspace || path.join(openclawHome, "workspace"),
  );
  const apiBaseUrl = (args["api-base-url"] || DEFAULT_API_BASE_URL).replace(
    /\/$/,
    "",
  );
  const wsUrl = inferWsUrl(apiBaseUrl);
  const bridgeEntry = DEFAULT_BRIDGE_ENTRY;
  const doctorAgentName = args["agent-name"] || "emperor-doctor";
  const runtimeId =
    args["runtime-id"] || `emperor-doctor-${os.hostname().toLowerCase()}`;

  return {
    openclawHome,
    companionDir,
    configPath,
    workspace,
    apiBaseUrl,
    wsUrl,
    bridgeEntry,
    stateDir,
    bridgeStatePath,
    doctorAgentName,
    runtimeId,
  };
}

function renderPosixCommandLauncher(config, command) {
  return `#!/usr/bin/env bash
set -euo pipefail

export EMPEROR_CLAW_API_URL="\${EMPEROR_CLAW_API_URL:-${config.apiBaseUrl}}"
export EMPEROR_CLAW_API_TOKEN="\${EMPEROR_CLAW_API_TOKEN:-}"
export EMPEROR_AGENT_NAME="\${EMPEROR_AGENT_NAME:-${config.doctorAgentName}}"
export EMPEROR_RUNTIME_ID="\${EMPEROR_RUNTIME_ID:-${config.runtimeId}}"
export EMPEROR_CLAW_COMPANION_DIR="${config.companionDir}"
export EMPEROR_CLAW_STATE_DIR="${config.stateDir}"
export EMPEROR_CLAW_BRIDGE_STATE_PATH="${config.bridgeStatePath}"
export EMPEROR_CLAW_CONFIG_PATH="${config.configPath}"
export EMPEROR_CLAW_RECONNECT_BASE_MS="\${EMPEROR_CLAW_RECONNECT_BASE_MS:-2000}"
export EMPEROR_CLAW_RECONNECT_MAX_MS="\${EMPEROR_CLAW_RECONNECT_MAX_MS:-60000}"

if [[ -z "\${EMPEROR_CLAW_API_TOKEN}" ]]; then
  echo "EMPEROR_CLAW_API_TOKEN is required." >&2
  exit 1
fi

node "${SCRIPT_ENTRY}" ${command} --config "${config.configPath}" "$@"
`;
}

function renderWindowsCommandLauncher(config, command) {
  return `@echo off
set "EMPEROR_CLAW_API_URL=${config.apiBaseUrl}"
if defined EMPEROR_CLAW_API_URL_OVERRIDE set "EMPEROR_CLAW_API_URL=%EMPEROR_CLAW_API_URL_OVERRIDE%"
if not defined EMPEROR_AGENT_NAME set "EMPEROR_AGENT_NAME=${config.doctorAgentName}"
if not defined EMPEROR_RUNTIME_ID set "EMPEROR_RUNTIME_ID=${config.runtimeId}"
set "EMPEROR_CLAW_COMPANION_DIR=${config.companionDir}"
set "EMPEROR_CLAW_STATE_DIR=${config.stateDir}"
set "EMPEROR_CLAW_BRIDGE_STATE_PATH=${config.bridgeStatePath}"
set "EMPEROR_CLAW_CONFIG_PATH=${config.configPath}"
if not defined EMPEROR_CLAW_RECONNECT_BASE_MS set "EMPEROR_CLAW_RECONNECT_BASE_MS=2000"
if not defined EMPEROR_CLAW_RECONNECT_MAX_MS set "EMPEROR_CLAW_RECONNECT_MAX_MS=60000"
if not defined EMPEROR_CLAW_API_TOKEN (
  echo EMPEROR_CLAW_API_TOKEN is required.
  exit /b 1
)
node "${SCRIPT_ENTRY}" ${command} --config "${config.configPath}" %*
`;
}

function renderPosixBridgeLauncher(config) {
  return `#!/usr/bin/env bash
set -euo pipefail

export EMPEROR_CLAW_API_URL="\${EMPEROR_CLAW_API_URL:-${config.apiBaseUrl}}"
export EMPEROR_CLAW_API_TOKEN="\${EMPEROR_CLAW_API_TOKEN:-}"
export EMPEROR_CLAW_AGENT_NAME="\${EMPEROR_CLAW_AGENT_NAME:-${config.doctorAgentName}}"
export EMPEROR_CLAW_RUNTIME_ID="\${EMPEROR_CLAW_RUNTIME_ID:-${config.runtimeId}}"
export EMPEROR_CLAW_COMPANION_DIR="${config.companionDir}"
export EMPEROR_CLAW_STATE_DIR="${config.stateDir}"
export EMPEROR_CLAW_BRIDGE_STATE_PATH="${config.bridgeStatePath}"
export EMPEROR_CLAW_CONFIG_PATH="${config.configPath}"
export EMPEROR_CLAW_RECONNECT_BASE_MS="\${EMPEROR_CLAW_RECONNECT_BASE_MS:-2000}"
export EMPEROR_CLAW_RECONNECT_MAX_MS="\${EMPEROR_CLAW_RECONNECT_MAX_MS:-60000}"

if [[ -z "\${EMPEROR_CLAW_API_TOKEN}" ]]; then
  echo "EMPEROR_CLAW_API_TOKEN is required." >&2
  exit 1
fi

node "${config.bridgeEntry}"
`;
}

function renderWindowsBridgeLauncher(config) {
  return `@echo off
set "EMPEROR_CLAW_API_URL=${config.apiBaseUrl}"
if defined EMPEROR_CLAW_API_URL_OVERRIDE set "EMPEROR_CLAW_API_URL=%EMPEROR_CLAW_API_URL_OVERRIDE%"
if not defined EMPEROR_CLAW_AGENT_NAME set "EMPEROR_CLAW_AGENT_NAME=${config.doctorAgentName}"
if not defined EMPEROR_CLAW_RUNTIME_ID set "EMPEROR_CLAW_RUNTIME_ID=${config.runtimeId}"
set "EMPEROR_CLAW_COMPANION_DIR=${config.companionDir}"
set "EMPEROR_CLAW_STATE_DIR=${config.stateDir}"
set "EMPEROR_CLAW_BRIDGE_STATE_PATH=${config.bridgeStatePath}"
set "EMPEROR_CLAW_CONFIG_PATH=${config.configPath}"
if not defined EMPEROR_CLAW_RECONNECT_BASE_MS set "EMPEROR_CLAW_RECONNECT_BASE_MS=2000"
if not defined EMPEROR_CLAW_RECONNECT_MAX_MS set "EMPEROR_CLAW_RECONNECT_MAX_MS=60000"
if not defined EMPEROR_CLAW_API_TOKEN (
  echo EMPEROR_CLAW_API_TOKEN is required.
  exit /b 1
)
node "${config.bridgeEntry}"
`;
}

function renderCompanionReadme(config) {
  return `Emperor Control Plane Companion

This directory was generated by scripts/control-plane.js bootstrap.

Files:
- bridge.config.json: local Emperor/OpenClaw companion config
- run-bridge.sh / run-bridge.cmd: launch the shipped Emperor bridge
- doctor.sh / doctor.cmd: run MCP/runtime diagnostics
- sync.sh / sync.cmd: capture a live control-plane snapshot
- repair.sh / repair.cmd: rewrite companion files from the saved config
- session-inspect.sh / session-inspect.cmd: inspect the current runtime/session context
- openclaw.control-plane.json: conservative OpenClaw config overlay to merge manually
- state/bridge-state.json: local journal for cursors, reconnect backoff, and dedupe

Recommended flow:
1. Export EMPEROR_CLAW_API_TOKEN in your shell.
2. Run doctor first:
  ${process.platform === "win32" ? "doctor.cmd" : "./doctor.sh"}
3. Launch the bridge:
  ${process.platform === "win32" ? "run-bridge.cmd" : "./run-bridge.sh"}
4. If something drifts, run sync or repair:
   ${process.platform === "win32" ? "sync.cmd" : "./sync.sh"}
5. If you need a live runtime snapshot without mutating Emperor, run session-inspect:
   ${process.platform === "win32" ? "session-inspect.cmd" : "./session-inspect.sh"}
6. Manage shared mailboxes, identities, templates, and billing data in Emperor Resources.
7. Use agent runtime integrations only for machine-local payloads.

Current values:
- API base URL: ${config.apiBaseUrl}
- WS URL: ${config.wsUrl}
- Workspace: ${config.workspace}
- State directory: ${config.stateDir}
- Bridge state path: ${config.bridgeStatePath}
- Bridge entry: ${config.bridgeEntry}
- Resource scopes: company, customer, project, agent
- Artifact kinds: source_document, working_file, proof, deliverable, template, export_bundle
`;
}

function renderOpenClawOverlay(config) {
  return JSON.stringify(
    {
      agents: {
        defaults: {
          workspace: config.workspace,
          thinkingDefault: "medium",
        },
      },
      commands: {
        native: "auto",
        nativeSkills: "auto",
      },
      channels: {
        defaults: {
          heartbeat: {
            showOk: true,
            showAlerts: true,
            useIndicator: true,
          },
        },
      },
    },
    null,
    2,
  );
}

async function runBootstrap(args) {
  const config = bootstrapPayload(args);
  const token = args.token || process.env.EMPEROR_CLAW_API_TOKEN || "";

  ensureDir(config.openclawHome);
  ensureDir(config.companionDir);
  ensureDir(config.stateDir);
  ensureDir(config.workspace);
  ensureDir(path.dirname(config.configPath));

  if (!args["skip-validate"]) {
    await validateApiAccess(config.apiBaseUrl, token);
    console.log(`[ok] API token validated against ${config.apiBaseUrl}`);
  } else {
    console.log("[warn] Skipping API validation by request.");
  }

  const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    repoRoot: REPO_ROOT,
    apiBaseUrl: config.apiBaseUrl,
    wsUrl: config.wsUrl,
    bridgeEntry: config.bridgeEntry,
    stateDir: config.stateDir,
    bridgeStatePath: config.bridgeStatePath,
    workspace: config.workspace,
    doctorAgentName: config.doctorAgentName,
    runtimeId: config.runtimeId,
    openclawHome: config.openclawHome,
    companionDir: config.companionDir,
    resourceScopes: ["company", "customer", "project", "agent"],
    artifactKinds: [
      "source_document",
      "working_file",
      "proof",
      "deliverable",
      "template",
      "export_bundle",
    ],
    reconnectPolicy: {
      baseDelayMs: 2000,
      maxDelayMs: 60000,
    },
  };

  writeTextFile(config.configPath, `${JSON.stringify(payload, null, 2)}\n`);
  writeTextFile(path.join(config.companionDir, "run-bridge.sh"), renderPosixBridgeLauncher(config), 0o755);
  writeTextFile(path.join(config.companionDir, "run-bridge.cmd"), renderWindowsBridgeLauncher(config));
  writeTextFile(path.join(config.companionDir, "doctor.sh"), renderPosixCommandLauncher(config, "doctor"), 0o755);
  writeTextFile(path.join(config.companionDir, "doctor.cmd"), renderWindowsCommandLauncher(config, "doctor"));
  writeTextFile(path.join(config.companionDir, "sync.sh"), renderPosixCommandLauncher(config, "sync"), 0o755);
  writeTextFile(path.join(config.companionDir, "sync.cmd"), renderWindowsCommandLauncher(config, "sync"));
  writeTextFile(path.join(config.companionDir, "repair.sh"), renderPosixCommandLauncher(config, "repair"), 0o755);
  writeTextFile(path.join(config.companionDir, "repair.cmd"), renderWindowsCommandLauncher(config, "repair"));
  writeTextFile(path.join(config.companionDir, "session-inspect.sh"), renderPosixCommandLauncher(config, "session-inspect"), 0o755);
  writeTextFile(path.join(config.companionDir, "session-inspect.cmd"), renderWindowsCommandLauncher(config, "session-inspect"));
  writeTextFile(path.join(config.companionDir, ".env.example"), `EMPEROR_CLAW_API_URL=${config.apiBaseUrl}
EMPEROR_CLAW_API_TOKEN=replace_me
EMPEROR_AGENT_NAME=${config.doctorAgentName}
EMPEROR_RUNTIME_ID=${config.runtimeId}
EMPEROR_CLAW_COMPANION_DIR=${config.companionDir}
EMPEROR_CLAW_STATE_DIR=${config.stateDir}
EMPEROR_CLAW_BRIDGE_STATE_PATH=${config.bridgeStatePath}
`);
  writeTextFile(path.join(config.companionDir, "openclaw.control-plane.json"), `${renderOpenClawOverlay(config)}\n`);
  writeTextFile(path.join(config.companionDir, "README.txt"), renderCompanionReadme(config));
  if (!fs.existsSync(config.bridgeStatePath)) {
    writeTextFile(config.bridgeStatePath, `${JSON.stringify({
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      backoffMs: 2000,
      reconnectAttempt: 0,
      recentMessageIds: [],
      recentTaskFingerprints: [],
      pendingOperationIds: [],
    }, null, 2)}\n`);
  }

  console.log(`[ok] Companion config written to ${config.configPath}`);
  console.log(`[ok] Launch wrappers written to ${config.companionDir}`);
  console.log(
    `[next] Export EMPEROR_CLAW_API_TOKEN, then run ${
      process.platform === "win32"
        ? path.join(config.companionDir, "doctor.cmd")
        : path.join(config.companionDir, "doctor.sh")
    } or ${process.platform === "win32" ? "sync.cmd" : "./sync.sh"}`,
  );
}

function loadConfig(args) {
  const configPath = path.resolve(args.config || DEFAULT_CONFIG_PATH);
  if (!fs.existsSync(configPath)) {
    return null;
  }
  const raw = fs.readFileSync(configPath, "utf8");
  return {
    ...JSON.parse(raw),
    configPath,
    companionDir: path.dirname(configPath),
  };
}

function snapshotDirFromConfig(config) {
  return path.join(config.companionDir || path.dirname(config.configPath), "state");
}

function snapshotPathFromConfig(config, name) {
  return path.join(snapshotDirFromConfig(config), `${name}.json`);
}

function ensureParentDir(filePath) {
  ensureDir(path.dirname(filePath));
}

function writeJsonFile(filePath, value) {
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function safeRequest(label, fn) {
  try {
    return { label, ok: true, value: await fn() };
  } catch (error) {
    return { label, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function asList(value, key) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value[key])) return value[key];
  return [];
}

async function collectControlPlaneSnapshot(apiBaseUrl, token, agentName, runtimeId) {
  const [health, agentsRes, projectsRes, tasksRes, threadsRes] = await Promise.all([
    safeRequest("health", () => httpJson("GET", `${apiBaseUrl}/api/mcp/runtime/health`, token)),
    safeRequest("agents", () => httpJson("GET", `${apiBaseUrl}/api/mcp/agents?limit=200`, token)),
    safeRequest("projects", () => httpJson("GET", `${apiBaseUrl}/api/mcp/projects`, token)),
    safeRequest("tasks", () => httpJson("GET", `${apiBaseUrl}/api/mcp/tasks`, token)),
    safeRequest("threads", () => httpJson("GET", `${apiBaseUrl}/api/mcp/threads?type=team`, token)),
  ]);

  const agents = agentsRes.ok ? asList(agentsRes.value, "agents") : [];
  const projects = projectsRes.ok ? asList(projectsRes.value, "projects") : [];
  const tasks = tasksRes.ok ? asList(tasksRes.value, "tasks") : [];
  const threads = threadsRes.ok ? asList(threadsRes.value, "threads") : [];
  const matchedAgent = agents.find((agent) => agent.name === agentName) || null;

  return {
    capturedAt: new Date().toISOString(),
    runtimeId,
    agentName,
    health,
    matchedAgent,
    counts: {
      agents: agents.length,
      projects: projects.length,
      tasks: tasks.length,
      teamThreads: threads.length,
    },
    samples: {
      projects: projects.slice(0, 5),
      tasks: tasks.slice(0, 10),
      teamThreads: threads.slice(0, 5),
    },
    requests: {
      agents: agentsRes,
      projects: projectsRes,
      tasks: tasksRes,
      threads: threadsRes,
    },
  };
}

function printSnapshotSummary(snapshot) {
  const healthOk = snapshot.health?.ok === true || snapshot.health?.value?.ok === true;
  console.log(`[sync] capturedAt=${snapshot.capturedAt}`);
  console.log(`[sync] runtimeId=${snapshot.runtimeId}`);
  console.log(`[sync] health=${healthOk ? "ok" : "partial"}`);
  console.log(
    `[sync] counts agents=${snapshot.counts.agents} projects=${snapshot.counts.projects} tasks=${snapshot.counts.tasks} threads=${snapshot.counts.teamThreads}`,
  );
  if (snapshot.matchedAgent) {
    console.log(`[sync] matchedAgent=${snapshot.matchedAgent.name} (${snapshot.matchedAgent.id})`);
  }
}

function rewriteCompanionFiles(config) {
  ensureDir(config.openclawHome || DEFAULT_OPENCLAW_HOME);
  ensureDir(config.companionDir || path.dirname(config.configPath));
  ensureDir(config.stateDir || path.join(config.companionDir || path.dirname(config.configPath), "state"));
  ensureDir(config.workspace || path.join(config.openclawHome || DEFAULT_OPENCLAW_HOME, "workspace"));
  ensureDir(path.dirname(config.configPath));

  const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    repoRoot: REPO_ROOT,
    apiBaseUrl: config.apiBaseUrl,
    wsUrl: config.wsUrl,
    bridgeEntry: config.bridgeEntry || DEFAULT_BRIDGE_ENTRY,
    stateDir: config.stateDir || path.join(config.companionDir || path.dirname(config.configPath), "state"),
    bridgeStatePath:
      config.bridgeStatePath ||
      path.join(
        config.stateDir || path.join(config.companionDir || path.dirname(config.configPath), "state"),
        "bridge-state.json",
      ),
    workspace: config.workspace,
    doctorAgentName: config.doctorAgentName,
    runtimeId: config.runtimeId,
    openclawHome: config.openclawHome,
    companionDir: config.companionDir,
    resourceScopes: config.resourceScopes || ["company", "customer", "project", "agent"],
    artifactKinds: config.artifactKinds || [
      "source_document",
      "working_file",
      "proof",
      "deliverable",
      "template",
      "export_bundle",
    ],
  };

  writeTextFile(config.configPath, `${JSON.stringify(payload, null, 2)}\n`);
  writeTextFile(
    path.join(config.companionDir, "run-bridge.sh"),
    renderPosixBridgeLauncher(config),
    0o755,
  );
  writeTextFile(
    path.join(config.companionDir, "run-bridge.cmd"),
    renderWindowsBridgeLauncher(config),
  );
  writeTextFile(
    path.join(config.companionDir, "doctor.sh"),
    renderPosixCommandLauncher(config, "doctor"),
    0o755,
  );
  writeTextFile(
    path.join(config.companionDir, "doctor.cmd"),
    renderWindowsCommandLauncher(config, "doctor"),
  );
  writeTextFile(
    path.join(config.companionDir, "sync.sh"),
    renderPosixCommandLauncher(config, "sync"),
    0o755,
  );
  writeTextFile(
    path.join(config.companionDir, "sync.cmd"),
    renderWindowsCommandLauncher(config, "sync"),
  );
  writeTextFile(
    path.join(config.companionDir, "repair.sh"),
    renderPosixCommandLauncher(config, "repair"),
    0o755,
  );
  writeTextFile(
    path.join(config.companionDir, "repair.cmd"),
    renderWindowsCommandLauncher(config, "repair"),
  );
  writeTextFile(
    path.join(config.companionDir, "session-inspect.sh"),
    renderPosixCommandLauncher(config, "session-inspect"),
    0o755,
  );
  writeTextFile(
    path.join(config.companionDir, "session-inspect.cmd"),
    renderWindowsCommandLauncher(config, "session-inspect"),
  );
  writeTextFile(
    path.join(config.companionDir, ".env.example"),
    `EMPEROR_CLAW_API_URL=${config.apiBaseUrl}
EMPEROR_CLAW_API_TOKEN=replace_me
EMPEROR_AGENT_NAME=${config.doctorAgentName}
EMPEROR_RUNTIME_ID=${config.runtimeId}
EMPEROR_CLAW_COMPANION_DIR=${config.companionDir}
EMPEROR_CLAW_STATE_DIR=${config.stateDir}
EMPEROR_CLAW_BRIDGE_STATE_PATH=${config.bridgeStatePath}
`,
  );
  writeTextFile(
    path.join(config.companionDir, "openclaw.control-plane.json"),
    `${renderOpenClawOverlay(config)}\n`,
  );
  writeTextFile(
    path.join(config.companionDir, "README.txt"),
    renderCompanionReadme(config),
  );
  if (!fs.existsSync(config.bridgeStatePath)) {
    writeTextFile(
      config.bridgeStatePath,
      `${JSON.stringify(
        {
          version: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          backoffMs: 2000,
          reconnectAttempt: 0,
          recentMessageIds: [],
          recentTaskFingerprints: [],
          pendingOperationIds: [],
        },
        null,
        2,
      )}\n`,
    );
  }

  return payload;
}

function waitForWsEvent(ws, matcher, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error(`Timed out waiting for WebSocket event after ${timeoutMs}ms`));
    }, timeoutMs);

    const onMessage = (data) => {
      try {
        const payload = JSON.parse(data.toString());
        if (!matcher(payload)) {
          return;
        }
        clearTimeout(timer);
        ws.off("message", onMessage);
        resolve(payload);
      } catch {
        // Ignore malformed ws payloads.
      }
    };

    ws.on("message", onMessage);
  });
}

async function openWs(wsUrl, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, {
      headers: headers(token),
    });

    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`Timed out connecting to ${wsUrl}`));
    }, 15000);

    ws.once("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });

    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function ensureDoctorAgent(apiBaseUrl, token, agentName) {
  const existing = await httpJson(
    "GET",
    `${apiBaseUrl}/api/mcp/agents?limit=500`,
    token,
  );
  const match = Array.isArray(existing.agents)
    ? existing.agents.find((agent) => agent.name === agentName)
    : null;

  if (match) {
    return match;
  }

  const created = await httpJson(
    "POST",
    `${apiBaseUrl}/api/mcp/agents`,
    token,
    {
      name: agentName,
      role: "operator",
      skillsJson: ["doctor", "bridge"],
      memory: "Doctor agent used to verify Emperor MCP/runtime flows.",
      concurrencyLimit: 1,
    },
    {
      "Idempotency-Key": crypto.randomUUID(),
    },
  );

  return created.agent;
}

async function runDoctor(args) {
  const config = loadConfig(args) || {};
  const apiBaseUrl = (
    args["api-base-url"] ||
    process.env.EMPEROR_CLAW_API_URL ||
    config.apiBaseUrl ||
    DEFAULT_API_BASE_URL
  ).replace(/\/$/, "");
  const token =
    args.token || process.env.EMPEROR_CLAW_API_TOKEN || config.token || "";
  const wsUrl = config.wsUrl || inferWsUrl(apiBaseUrl);
  const agentName =
    args["agent-name"] || process.env.EMPEROR_AGENT_NAME || config.doctorAgentName || "emperor-doctor";
  const runtimeId =
    args["runtime-id"] ||
    process.env.EMPEROR_RUNTIME_ID ||
    config.runtimeId ||
    `emperor-doctor-${os.hostname().toLowerCase()}`;

  if (!token) {
    throw new Error(
      "Token is required. Pass --token or export EMPEROR_CLAW_API_TOKEN.",
    );
  }

  console.log(`[step] validating token against ${apiBaseUrl}`);
  await validateApiAccess(apiBaseUrl, token);
  console.log("[ok] MCP token is valid");

  console.log(`[step] opening websocket ${wsUrl}`);
  const ws = await openWs(wsUrl, token);
  const connectedPayload = await waitForWsEvent(
    ws,
    (payload) => payload && payload.type === "connected",
    15000,
  );
  console.log(`[ok] websocket connected: ${connectedPayload.message}`);

  try {
    console.log("[step] registering runtime node");
    const runtimeResponse = await httpJson(
      "POST",
      `${apiBaseUrl}/api/mcp/runtime/register`,
      token,
      {
        runtimeId,
        name: `Emperor Doctor (${os.hostname()})`,
        hostname: os.hostname(),
        gatewayVersion: "doctor-1.0",
        capabilitiesJson: ["doctor", "ws", "heartbeat", "threads", "checkpoint"],
        startedAt: new Date().toISOString(),
      },
    );
    console.log(`[ok] runtime registered: ${runtimeResponse.runtimeNode.runtimeId}`);

    console.log("[step] ensuring diagnostic agent");
    const agent = await ensureDoctorAgent(apiBaseUrl, token, agentName);
    console.log(`[ok] using agent: ${agent.name} (${agent.id})`);

    console.log("[step] starting session");
    const openclawSessionId = `doctor-${crypto.randomUUID()}`;
    const sessionResponse = await httpJson(
      "POST",
      `${apiBaseUrl}/api/mcp/agents/${agent.id}/sessions/start`,
      token,
      {
        runtimeId,
        openclawSessionId,
        sessionType: "doctor",
        channel: "doctor",
      },
    );
    const session = sessionResponse.session;
    console.log(`[ok] session active: ${session.id}`);

    console.log("[step] sending heartbeat");
    await httpJson("POST", `${apiBaseUrl}/api/mcp/agents/heartbeat`, token, {
      agentId: agent.name,
      currentLoad: 0,
    });
    console.log("[ok] heartbeat acknowledged");

    console.log("[step] sending thread message and waiting for websocket fanout");
    const marker = `doctor-${Date.now()}`;
    const sendResponse = await httpJson(
      "POST",
      `${apiBaseUrl}/api/mcp/messages/send`,
      token,
      {
        chat_id: "doctor",
        text: `Doctor ping ${marker}`,
        agentId: agent.name,
        thread_type: "team",
      },
    );
    await waitForWsEvent(
      ws,
      (payload) =>
        payload &&
        payload.type === "thread_message" &&
        payload.message &&
        payload.message.id === sendResponse.message_id,
      15000,
    );
    console.log("[ok] websocket fanout received thread_message");

    console.log("[step] checkpointing session");
    await httpJson(
      "POST",
      `${apiBaseUrl}/api/mcp/agents/${agent.id}/sessions/${session.id}/checkpoint`,
      token,
      {
        checkpointJson: {
          marker,
          runtimeId,
          verifiedAt: new Date().toISOString(),
        },
        status: "active",
        syncStatus: "synced",
        summary: "Doctor checkpoint",
      },
    );
    console.log("[ok] session checkpoint saved");

    console.log("[step] ending session");
    await httpJson(
      "POST",
      `${apiBaseUrl}/api/mcp/agents/${agent.id}/sessions/${session.id}/end`,
      token,
      {
        status: "ended",
        summary: "Doctor completed successfully",
      },
    );
    console.log("[ok] session ended");
    if (config.configPath) {
      writeJsonFile(snapshotPathFromConfig(config, "last-doctor"), {
        inspectedAt: new Date().toISOString(),
        apiBaseUrl,
        wsUrl,
        runtimeId,
        agentName,
        sessionId: session.id,
        status: "passed",
      });
    }
    console.log("[done] Emperor control-plane doctor passed");
  } finally {
    ws.close();
  }
}

async function runSync(args) {
  const config = loadConfig(args);
  if (!config) {
    throw new Error("Companion config not found. Run bootstrap first.");
  }

  const apiBaseUrl = (
    args["api-base-url"] ||
    process.env.EMPEROR_CLAW_API_URL ||
    config.apiBaseUrl ||
    DEFAULT_API_BASE_URL
  ).replace(/\/$/, "");
  const token =
    args.token || process.env.EMPEROR_CLAW_API_TOKEN || config.token || "";
  if (!token) {
    throw new Error("Token is required. Pass --token or export EMPEROR_CLAW_API_TOKEN.");
  }

  console.log(`[step] validating token against ${apiBaseUrl}`);
  await validateApiAccess(apiBaseUrl, token);
  console.log("[ok] MCP token is valid");

  const snapshot = await collectControlPlaneSnapshot(
    apiBaseUrl,
    token,
    args["agent-name"] || process.env.EMPEROR_AGENT_NAME || config.doctorAgentName || "emperor-doctor",
    args["runtime-id"] || process.env.EMPEROR_RUNTIME_ID || config.runtimeId || `emperor-doctor-${os.hostname().toLowerCase()}`,
  );
  writeJsonFile(snapshotPathFromConfig(config, "last-sync"), snapshot);
  printSnapshotSummary(snapshot);

  if (args.json) {
    console.log(JSON.stringify(snapshot, null, 2));
  }
}

async function runRepair(args) {
  const config = loadConfig(args);
  if (!config) {
    throw new Error("Companion config not found. Run bootstrap first.");
  }

  console.log("[step] rewriting companion files");
  const payload = rewriteCompanionFiles(config);
  writeJsonFile(snapshotPathFromConfig(config, "last-repair"), {
    repairedAt: new Date().toISOString(),
    configPath: config.configPath,
    companionDir: config.companionDir,
    apiBaseUrl: config.apiBaseUrl,
    wsUrl: config.wsUrl,
  });
  console.log(`[ok] companion files refreshed in ${config.companionDir}`);

  const token =
    args.token || process.env.EMPEROR_CLAW_API_TOKEN || config.token || "";
  if (token) {
    console.log("[step] running live sync after repair");
    const snapshot = await collectControlPlaneSnapshot(
      config.apiBaseUrl,
      token,
      config.doctorAgentName || "emperor-doctor",
      config.runtimeId || `emperor-doctor-${os.hostname().toLowerCase()}`,
    );
    writeJsonFile(snapshotPathFromConfig(config, "last-sync"), snapshot);
    printSnapshotSummary(snapshot);
  } else {
    console.log("[warn] Skipping live sync because no token was provided.");
  }

  if (args.json) {
    console.log(JSON.stringify({ repaired: true, config: payload }, null, 2));
  }
}

async function runSessionInspect(args) {
  const config = loadConfig(args);
  if (!config) {
    throw new Error("Companion config not found. Run bootstrap first.");
  }

  const apiBaseUrl = (
    args["api-base-url"] ||
    process.env.EMPEROR_CLAW_API_URL ||
    config.apiBaseUrl ||
    DEFAULT_API_BASE_URL
  ).replace(/\/$/, "");
  const runtimeId =
    args["runtime-id"] ||
    process.env.EMPEROR_RUNTIME_ID ||
    config.runtimeId ||
    `emperor-doctor-${os.hostname().toLowerCase()}`;
  const agentName =
    args["agent-name"] ||
    process.env.EMPEROR_AGENT_NAME ||
    config.doctorAgentName ||
    "emperor-doctor";
  const sessionId = args["session-id"] || null;
  const snapshot = readJsonFile(snapshotPathFromConfig(config, "last-sync"));
  const token =
    args.token || process.env.EMPEROR_CLAW_API_TOKEN || config.token || "";

  const report = {
    inspectedAt: new Date().toISOString(),
    configPath: config.configPath,
    apiBaseUrl,
    runtimeId,
    agentName,
    sessionId,
    localSnapshot: snapshot,
  };

  if (token) {
    report.health = await safeRequest(
      "health",
      () => httpJson("GET", `${apiBaseUrl}/api/mcp/runtime/health`, token),
    );
    report.agents = await safeRequest(
      "agents",
      () => httpJson("GET", `${apiBaseUrl}/api/mcp/agents?limit=200`, token),
    );
    const agentList = report.agents.ok ? asList(report.agents.value, "agents") : [];
    report.matchedAgent = agentList.find((agent) => agent.name === agentName || agent.id === args["agent-id"]) || null;
  } else {
    report.warning = "No token provided, live inspection limited to local companion state.";
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`[inspect] config=${config.configPath}`);
  console.log(`[inspect] runtimeId=${runtimeId}`);
  console.log(`[inspect] sessionId=${sessionId || "none"}`);
  if (report.matchedAgent) {
    console.log(`[inspect] agent=${report.matchedAgent.name} (${report.matchedAgent.id})`);
  } else {
    console.log(`[inspect] agent=${agentName} (not found in live agents)`);
  }
  if (report.health) {
    const healthOk = report.health.ok === true || report.health.value?.ok === true;
    console.log(`[inspect] health=${healthOk ? "ok" : "partial"}`);
  }
  if (snapshot) {
    console.log(`[inspect] lastSync=${snapshot.capturedAt} tasks=${snapshot.counts?.tasks || 0} projects=${snapshot.counts?.projects || 0}`);
  } else {
    console.log("[inspect] lastSync=none");
  }
  if (!sessionId) {
    console.log("[inspect] session detail API is not exposed; this reports the latest known runtime context only.");
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

  if (!command || args.help) {
    printUsage();
    process.exit(command ? 0 : 1);
  }

  if (command === "bootstrap") {
    await runBootstrap(args);
    return;
  }

  if (command === "doctor") {
    await runDoctor(args);
    return;
  }

  if (command === "sync") {
    await runSync(args);
    return;
  }

  if (command === "repair") {
    await runRepair(args);
    return;
  }

  if (command === "session-inspect") {
    await runSessionInspect(args);
    return;
  }

  printUsage();
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`[error] ${error.message}`);
  process.exit(1);
});
