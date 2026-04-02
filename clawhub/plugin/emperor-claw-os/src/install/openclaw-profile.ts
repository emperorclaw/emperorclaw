import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type OpenClawProfileConfig = Record<string, any>;

const TRUSTED_PLUGIN_ID = "emperor-claw-os";

function readJsonObject(filePath: string): OpenClawProfileConfig {
  if (!filePath || !fs.existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function ensureStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

export function inferOpenClawStateDir(pluginRoot: string): string | undefined {
  const configured = String(process.env.OPENCLAW_STATE_DIR || "").trim();
  if (configured) return configured;

  const extensionsDir = path.dirname(pluginRoot);
  if (path.basename(extensionsDir).toLowerCase() !== "extensions") return undefined;

  const stateDir = path.dirname(extensionsDir);
  return fs.existsSync(stateDir) ? stateDir : undefined;
}

export function resolveOpenClawConfigPath(pluginRoot: string): string {
  const configured = String(process.env.OPENCLAW_CONFIG_PATH || "").trim();
  if (configured) return configured;

  const stateDir = inferOpenClawStateDir(pluginRoot);
  if (stateDir) return path.join(stateDir, "openclaw.json");

  return path.join(os.homedir(), ".openclaw", "openclaw.json");
}

export function normalizeOpenClawProfileConfig(
  configPath: string,
  pluginId = TRUSTED_PLUGIN_ID,
): { updated: boolean; configPath: string } {
  const current = readJsonObject(configPath);
  const next: OpenClawProfileConfig = JSON.parse(JSON.stringify(current || {}));

  next.plugins = next.plugins && typeof next.plugins === "object" ? next.plugins : {};
  next.plugins.entries = next.plugins.entries && typeof next.plugins.entries === "object" ? next.plugins.entries : {};
  next.plugins.entries[pluginId] = {
    ...(next.plugins.entries[pluginId] && typeof next.plugins.entries[pluginId] === "object"
      ? next.plugins.entries[pluginId]
      : {}),
    enabled: true,
  };

  const allow = ensureStringArray(next.plugins.allow);
  if (!allow.includes(pluginId)) allow.push(pluginId);
  next.plugins.allow = allow;

  next.agents = next.agents && typeof next.agents === "object" ? next.agents : {};
  next.agents.defaults = next.agents.defaults && typeof next.agents.defaults === "object" ? next.agents.defaults : {};
  next.agents.defaults.sandbox =
    next.agents.defaults.sandbox && typeof next.agents.defaults.sandbox === "object"
      ? next.agents.defaults.sandbox
      : {};

  const currentMode = String(next.agents.defaults.sandbox.mode || "").trim().toLowerCase();
  if (currentMode !== "all" && currentMode !== "non-main") {
    next.agents.defaults.sandbox.mode = "non-main";
  }

  const before = JSON.stringify(current);
  const after = JSON.stringify(next);
  if (before === after) {
    return { updated: false, configPath };
  }

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return { updated: true, configPath };
}

export function inspectOpenClawProfileConfig(
  configPath: string,
  pluginId = TRUSTED_PLUGIN_ID,
): {
  exists: boolean;
  pluginAllowed: boolean;
  pluginEnabled: boolean;
  sandboxMode: string;
  ok: boolean;
  detail: string;
} {
  if (!configPath || !fs.existsSync(configPath)) {
    return {
      exists: false,
      pluginAllowed: false,
      pluginEnabled: false,
      sandboxMode: "",
      ok: false,
      detail: `${configPath} missing`,
    };
  }

  const parsed = readJsonObject(configPath);
  const allow = ensureStringArray(parsed?.plugins?.allow);
  const pluginAllowed = allow.includes(pluginId);
  const pluginEnabled = Boolean(parsed?.plugins?.entries?.[pluginId]?.enabled);
  const sandboxMode = String(parsed?.agents?.defaults?.sandbox?.mode || "").trim();
  const sandboxOk = sandboxMode === "non-main" || sandboxMode === "all";
  const ok = pluginAllowed && pluginEnabled && sandboxOk;

  return {
    exists: true,
    pluginAllowed,
    pluginEnabled,
    sandboxMode,
    ok,
    detail: ok
      ? `plugin allowed, plugin enabled, sandbox=${sandboxMode}`
      : `pluginAllowed=${pluginAllowed}, pluginEnabled=${pluginEnabled}, sandbox=${sandboxMode || "missing"}`,
  };
}
