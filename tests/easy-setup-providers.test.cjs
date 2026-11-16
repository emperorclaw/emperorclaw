/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const { readFileSync, existsSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");

const root = resolve(__dirname, "..");

function read(relativePath) {
  return readFileSync(resolve(root, relativePath), "utf8");
}

const FREE_OPENROUTER_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free";

test("Easy Setup offers OpenRouter, DeepSeek and a custom OpenAI-compatible endpoint for local hiring", () => {
  const source = read("src/app/(app)/agents/easy-setup-dialog.tsx");
  ["openrouter", "deepseek"].forEach((id) => {
    assert.ok(source.includes(`id: "${id}"`), `Easy Setup should offer ${id}`);
  });
  assert.ok(source.includes("id: CUSTOM_LLM_PROVIDER"), "Easy Setup should offer a custom endpoint");
  ["openai", "anthropic", "google", "grok"].forEach((id) => {
    assert.ok(!source.includes(`id: "${id}"`), `Easy Setup should no longer offer ${id}`);
  });
});

test("Easy Setup defaults OpenRouter to the free Nemotron model", () => {
  const source = read("src/app/(app)/agents/easy-setup-dialog.tsx");
  assert.ok(source.includes(FREE_OPENROUTER_MODEL), "OpenRouter should default to the free model");
});

test("Hermes runtime maps a custom endpoint to Hermes' custom provider with its base URL", () => {
  const entrypoint = read("integrations/hermes/entrypoint.sh");
  assert.match(entrypoint, /custom\)[\s\S]*cfg model\.provider custom[\s\S]*cfg model\.base_url "\$EMPEROR_CLAW_LLM_BASE_URL"/);
  assert.match(entrypoint, /EMPEROR_CLAW_LLM_MODEL EMPEROR_CLAW_LLM_BASE_URL/, "the base URL is written to the profile .env");
  const provisioning = read("src/lib/hermes-provisioning.ts");
  assert.ok(provisioning.includes("EMPEROR_CLAW_LLM_BASE_URL="), "provisioning passes the base URL to the container");
  assert.ok(provisioning.includes(":host-gateway"), "provisioning maps host.docker.internal on Linux");
});

test("Hermes runtime defaults OpenRouter to the same free model", () => {
  const entrypoint = read("integrations/hermes/entrypoint.sh");
  assert.ok(entrypoint.includes(FREE_OPENROUTER_MODEL), "entrypoint.sh should default OpenRouter to the free model");
});

test("Free OpenRouter model is seeded at zero cost", () => {
  const migrationPath = "src/db/migrations/0044_free-openrouter-model.sql";
  assert.ok(existsSync(resolve(root, migrationPath)), "a migration should seed the free model pricing");
  const sql = read(migrationPath);
  assert.ok(sql.includes(FREE_OPENROUTER_MODEL), "migration should insert the free model");
  assert.ok(sql.includes("0, 0"), "free model pricing should be zero");
  const journal = read("src/db/migrations/meta/_journal.json");
  assert.ok(journal.includes("0044_free-openrouter-model"), "migration journal should list the new migration");
});

test("Hermes runtime only gives an agent the host-gateway route when its endpoint is host.docker.internal", () => {
  const provisioning = read("src/lib/hermes-provisioning.ts");
  assert.match(provisioning, /if \(llmEndpointHost\(llmBaseUrl\) === DOCKER_HOST_ALIAS\) extraHosts = /);
});

test("entrypoint.sh never writes a config record from a value with a tab or line break", (t) => {
  const { spawnSync } = require("node:child_process");
  const entrypoint = read("integrations/hermes/entrypoint.sh").replace(/\r\n/g, "\n");
  const start = entrypoint.indexOf("CONFIG_PAIRS=\"$(mktemp)\"");
  const end = entrypoint.indexOf("# Stop a tool loop");
  assert.ok(start > 0 && end > start, "the config section is where the test expects it");
  const section = entrypoint.slice(start, end);
  const script = `log() { printf '[entrypoint] %s\\n' "$*" >&2; }\n${section}\ncat "$CONFIG_PAIRS"\n`;
  const probe = spawnSync("sh", ["-c", "exit 0"]);
  if (probe.error) {
    t.skip("no POSIX sh on this machine");
    return;
  }
  const run = (env) => spawnSync("sh", ["-c", script], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });
  const ok = run({ EMPEROR_CLAW_LLM_PROVIDER: "custom", EMPEROR_CLAW_LLM_BASE_URL: "http://host.docker.internal:11434/v1", EMPEROR_CLAW_LLM_MODEL: "qwen2.5-coder:32b-instruct-q4_K_M" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^set\tmodel\.default\tqwen2\.5-coder:32b-instruct-q4_K_M$/m);
  assert.match(ok.stdout, /^set\tmodel\.base_url\thttp:\/\/host\.docker\.internal:11434\/v1$/m);

  const hostile = run({
    EMPEROR_CLAW_LLM_PROVIDER: "openai",
    EMPEROR_CLAW_LLM_MODEL: "gpt-4o\nset\tmodel.base_url\thttp://evil.example",
  });
  assert.equal(hostile.status, 0, hostile.stderr);
  assert.ok(!hostile.stdout.includes("evil.example"), "no injected record");
  assert.match(hostile.stdout, /^set\tmodel\.default\tgpt-4o-mini$/m, "falls back to the provider default");
  assert.match(hostile.stderr, /ignoring EMPEROR_CLAW_LLM_MODEL/);

  const badUrl = run({ EMPEROR_CLAW_LLM_PROVIDER: "custom", EMPEROR_CLAW_LLM_BASE_URL: "http://a\tset\tmodel.provider\tevil", EMPEROR_CLAW_LLM_MODEL: "m" });
  assert.equal(badUrl.status, 0, badUrl.stderr);
  assert.ok(!badUrl.stdout.includes("evil"), "no injected record");
  assert.ok(!/model\.base_url/.test(badUrl.stdout), "the base URL is not written");

  const carriage = run({ EMPEROR_CLAW_LLM_PROVIDER: "deepseek\r", EMPEROR_CLAW_LLM_MODEL: "m" });
  assert.equal(carriage.status, 0, carriage.stderr);
  assert.ok(!carriage.stdout.includes("\r"), "no carriage return reaches the config");

  // GitHub Copilot: Hermes' native provider, its default endpoint, Copilot's default model.
  const copilot = run({ EMPEROR_CLAW_LLM_PROVIDER: "copilot" });
  assert.equal(copilot.status, 0, copilot.stderr);
  assert.match(copilot.stdout, /^set\tmodel\.provider\tcopilot$/m);
  assert.match(copilot.stdout, /^unset\tmodel\.base_url/m);
  assert.match(copilot.stdout, /^set\tmodel\.default\tgpt-5-mini$/m);
  const copilotModel = run({ EMPEROR_CLAW_LLM_PROVIDER: "copilot", EMPEROR_CLAW_LLM_MODEL: "claude-sonnet-4.5" });
  assert.equal(copilotModel.status, 0, copilotModel.stderr);
  assert.match(copilotModel.stdout, /^set\tmodel\.default\tclaude-sonnet-4\.5$/m);
});

test("entrypoint.sh copies the Copilot token into the profile .env", (t) => {
  const { spawnSync } = require("node:child_process");
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const entrypoint = read("integrations/hermes/entrypoint.sh").replace(/\r\n/g, "\n");
  const start = entrypoint.indexOf("dotenv_value() {");
  const loop = entrypoint.indexOf("for key in EMPEROR_CLAW_API_URL", start);
  const end = entrypoint.indexOf("\ndone\n", loop);
  assert.ok(start > 0 && loop > start && end > loop, "the .env section is where the test expects it");
  if (spawnSync("sh", ["-c", "exit 0"]).error) {
    t.skip("no POSIX sh on this machine");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ec-copilot-env-"));
  try {
    const envFile = path.join(dir, ".env").replace(/\\/g, "/");
    fs.writeFileSync(envFile, "");
    const script = `log() { printf '[entrypoint] %s\\n' "$*" >&2; }\nENV_FILE='${envFile}'\n${entrypoint.slice(start, end)}\ndone\n`;
    const token = `gho_${"x".repeat(36)}`; // fake, shape only
    const res = spawnSync("sh", ["-c", script], { env: { PATH: process.env.PATH, COPILOT_GITHUB_TOKEN: token, EMPEROR_CLAW_LLM_PROVIDER: "copilot" }, encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
    const written = fs.readFileSync(envFile, "utf8");
    assert.match(written, new RegExp(`^COPILOT_GITHUB_TOKEN=${token}$`, "m"));
    assert.match(written, /^EMPEROR_CLAW_LLM_PROVIDER=copilot$/m);
    assert.ok(!res.stdout.includes(token) && !res.stderr.includes(token), "the token is never printed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const provisioning = read("src/lib/hermes-provisioning.ts");
  assert.match(provisioning, /\[COPILOT_PROVIDER\]: COPILOT_TOKEN_ENV/);
});
