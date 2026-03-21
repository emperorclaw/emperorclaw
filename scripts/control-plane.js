#!/usr/bin/env node

/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");

const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_OPENCLAW_HOME = path.join(os.homedir(), ".openclaw");
const DEFAULT_COMPANION_DIR = path.join(
  DEFAULT_OPENCLAW_HOME,
  "emperor-control-plane",
);
const DEFAULT_CONFIG_PATH = path.join(
  DEFAULT_COMPANION_DIR,
  "bridge.config.json",
);
const DEFAULT_BRIDGE_ENTRY = path.join(
  REPO_ROOT,
  "clawhub",
  "emperor-claw-os",
  "examples",
  "bridge.js",
);
const DEFAULT_API_BASE_URL =
  process.env.EMPEROR_CLAW_API_URL || "http://localhost:3000";

function printUsage() {
  console.log(`Usage:
  node scripts/control-plane.js bootstrap [options]
  node scripts/control-plane.js doctor [options]

Commands:
  bootstrap   Create a local OpenClaw companion directory, launch wrappers, and
              a safe config file around the shipped Emperor bridge.
  doctor      Verify MCP/runtime connectivity end to end against a live Emperor
              server: token, websocket, runtime register, session, heartbeat,
              thread send, checkpoint, and session end.

Options:
  --api-base-url <url>   Emperor base URL. Default: ${DEFAULT_API_BASE_URL}
  --token <token>        Company token. Default: EMPEROR_CLAW_API_TOKEN
  --config <path>        Companion config path. Default: ${DEFAULT_CONFIG_PATH}
  --openclaw-home <dir>  OpenClaw home directory. Default: ${DEFAULT_OPENCLAW_HOME}
  --workspace <dir>      OpenClaw workspace path. Default: <openclaw-home>/workspace
  --agent-name <name>    Diagnostic/bridge agent name. Default: emperor-doctor
  --runtime-id <id>      Runtime id. Default: emperor-doctor-<hostname>
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
  const configPath = path.resolve(
    args.config || path.join(companionDir, "bridge.config.json"),
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
    doctorAgentName,
    runtimeId,
  };
}

function renderPosixBridgeLauncher(config) {
  return `#!/usr/bin/env bash
set -euo pipefail

export EMPEROR_CLAW_API_URL="\${EMPEROR_CLAW_API_URL:-${config.apiBaseUrl}}"
export EMPEROR_CLAW_API_TOKEN="\${EMPEROR_CLAW_API_TOKEN:-}"
export EMPEROR_AGENT_NAME="\${EMPEROR_AGENT_NAME:-${config.doctorAgentName}}"
export EMPEROR_RUNTIME_ID="\${EMPEROR_RUNTIME_ID:-${config.runtimeId}}"

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
if not defined EMPEROR_AGENT_NAME set "EMPEROR_AGENT_NAME=${config.doctorAgentName}"
if not defined EMPEROR_RUNTIME_ID set "EMPEROR_RUNTIME_ID=${config.runtimeId}"
if not defined EMPEROR_CLAW_API_TOKEN (
  echo EMPEROR_CLAW_API_TOKEN is required.
  exit /b 1
)
node "${config.bridgeEntry}"
`;
}

function renderPosixDoctorLauncher(config) {
  return `#!/usr/bin/env bash
set -euo pipefail
node "${path.join(REPO_ROOT, "scripts", "control-plane.js")}" doctor --config "${config.configPath}" "$@"
`;
}

function renderWindowsDoctorLauncher(config) {
  return `@echo off
node "${path.join(REPO_ROOT, "scripts", "control-plane.js")}" doctor --config "${config.configPath}" %*
`;
}

function renderCompanionReadme(config) {
  return `Emperor Control Plane Companion

This directory was generated by scripts/control-plane.js bootstrap.

Files:
- bridge.config.json: local Emperor/OpenClaw companion config
- run-bridge.sh / run-bridge.cmd: launch the shipped Emperor bridge
- doctor.sh / doctor.cmd: run MCP/runtime diagnostics
- openclaw.control-plane.json: conservative OpenClaw config overlay to merge manually

Recommended flow:
1. Export EMPEROR_CLAW_API_TOKEN in your shell.
2. Run doctor first:
   ${process.platform === "win32" ? "doctor.cmd" : "./doctor.sh"}
3. Launch the bridge:
   ${process.platform === "win32" ? "run-bridge.cmd" : "./run-bridge.sh"}

Current values:
- API base URL: ${config.apiBaseUrl}
- WS URL: ${config.wsUrl}
- Workspace: ${config.workspace}
- Bridge entry: ${config.bridgeEntry}
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
    workspace: config.workspace,
    doctorAgentName: config.doctorAgentName,
    runtimeId: config.runtimeId,
    openclawHome: config.openclawHome,
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
    renderPosixDoctorLauncher(config),
    0o755,
  );
  writeTextFile(
    path.join(config.companionDir, "doctor.cmd"),
    renderWindowsDoctorLauncher(config),
  );
  writeTextFile(
    path.join(config.companionDir, ".env.example"),
    `EMPEROR_CLAW_API_URL=${config.apiBaseUrl}
EMPEROR_CLAW_API_TOKEN=replace_me
EMPEROR_AGENT_NAME=${config.doctorAgentName}
EMPEROR_RUNTIME_ID=${config.runtimeId}
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

  console.log(`[ok] Companion config written to ${config.configPath}`);
  console.log(`[ok] Launch wrappers written to ${config.companionDir}`);
  console.log(
    `[next] Export EMPEROR_CLAW_API_TOKEN, then run ${
      process.platform === "win32"
        ? path.join(config.companionDir, "doctor.cmd")
        : path.join(config.companionDir, "doctor.sh")
    }`,
  );
}

function loadConfig(args) {
  const configPath = path.resolve(args.config || DEFAULT_CONFIG_PATH);
  if (!fs.existsSync(configPath)) {
    return null;
  }
  const raw = fs.readFileSync(configPath, "utf8");
  return JSON.parse(raw);
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
    console.log("[done] Emperor control-plane doctor passed");
  } finally {
    ws.close();
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

  printUsage();
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`[error] ${error.message}`);
  process.exit(1);
});
