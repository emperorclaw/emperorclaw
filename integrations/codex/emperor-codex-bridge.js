/**
 * EmperorClaw Codex Bridge
 *
 * Polls EmperorClaw for new messages directed to this agent,
 * runs `codex exec` with the message as prompt, and posts the result back.
 *
 * Usage: node emperor-codex-bridge.js
 *
 * Env vars (same contract as Hermes bridge):
 *   EMPEROR_CLAW_API_URL     — EmperorClaw base URL (default http://localhost:3000)
 *   EMPEROR_CLAW_API_TOKEN   — API token (required)
 *   EMPEROR_CLAW_AGENT_ID    — Agent UUID (required)
 *   EMPEROR_CLAW_AGENT_NAME  — Agent display name
 *   EMPEROR_CLAW_AGENT_ROLE  — Agent role description
 *   POLL_SECONDS             — Poll interval (default 5)
 */

const { spawn } = require("child_process");
const os = require("os");
const { classifyMessage, loopGuardOk, estimateUsageTokens, stripCodexNoise } = require("./bridge-logic");

const API_URL = (process.env.EMPEROR_CLAW_API_URL || "http://localhost:3000").replace(/\/+$/, "");
const API_TOKEN = process.env.EMPEROR_CLAW_API_TOKEN || "";
const AGENT_ID = process.env.EMPEROR_CLAW_AGENT_ID || "";
const AGENT_NAME = process.env.EMPEROR_CLAW_AGENT_NAME || "Codex Agent";
const AGENT_ROLE = process.env.EMPEROR_CLAW_AGENT_ROLE || "operator";
const POLL_SECONDS = Math.max(2, parseInt(process.env.EMPEROR_CLAW_POLL_SECONDS || "5", 10));
const TIMEOUT_SECONDS = parseInt(process.env.EMPEROR_CLAW_CODEX_TIMEOUT || "120", 10);

if (!API_TOKEN || !AGENT_ID) {
    console.error("[emperor-codex] EMPEROR_CLAW_API_TOKEN and EMPEROR_CLAW_AGENT_ID are required");
    process.exit(1);
}

const seen = new Set();
const loopCounts = new Map(); // threadId → consecutive agent message count
let lastSeenAt = null;

function log(msg) {
    console.log(`[emperor-codex] ${new Date().toISOString()} ${msg}`);
}

async function api(method, path, body) {
    const url = `${API_URL}/api/mcp${path}`;
    const headers = {
        "Authorization": `Bearer ${API_TOKEN}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "emperor-codex-bridge/0.1.0",
    };
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(url, opts);
    const text = await res.text();
    if (!res.ok) throw new Error(`API ${method} ${path} failed ${res.status}: ${text.slice(0, 500)}`);
    return text ? JSON.parse(text) : {};
}

async function heartbeat() {
    try {
        await api("POST", "/agents/heartbeat", { agentId: AGENT_ID, currentLoad: 0 });
    } catch (e) {
        log(`heartbeat failed: ${e.message}`);
    }
}

async function checkBudget() {
    try {
        const payload = await api("GET", `/agents/${AGENT_ID}`);
        const agent = payload.agent || payload;
        const status = agent.budgetStatus || "active";
        const usage = agent.monthlyTokenUsage || 0;
        const budget = agent.monthlyBudgetCents || 0;
        if (status === "paused") {
            log(`BUDGET PAUSED: ${usage} tokens used of ${budget} cents budget`);
            return false;
        }
        return true;
    } catch (e) {
        return true; // If we can't check, allow (fail open)
    }
}

async function reportUsage(inputTokens, outputTokens) {
    // Use /agents/report-usage (same path as the Hermes bridge): the server
    // INCREMENTS monthly usage, computes cost from the pricing table, and flips
    // budgetStatus to warning/paused. The old PATCH /agents/{id} path OVERWROTE
    // monthlyTokenUsage, never set cost, and never enforced the budget.
    try {
        await api("POST", "/agents/report-usage", {
            agentId: AGENT_ID,
            inputTokens: Math.max(0, Math.round(inputTokens) || 0),
            outputTokens: Math.max(0, Math.round(outputTokens) || 0),
        });
    } catch (e) {
        log(`usage report failed: ${e.message}`);
    }
}

async function syncMessages() {
    const query = ["mode=all"];
    if (lastSeenAt) query.push(`since=${encodeURIComponent(lastSeenAt)}`);
    const payload = await api("GET", `/messages/sync?${query.join("&")}`);
    return Array.isArray(payload.messages) ? payload.messages : [];
}

async function sendReply(message, text) {
    if (!text) return;
    await api("POST", "/messages/send", {
        thread_id: message.threadId || message.thread_id,
        thread_type: message.threadType || message.thread_type || "direct",
        agentId: AGENT_ID,
        text,
        targetAgentId: null,
    });
}

async function updateStatus(message, opts = {}) {
    const threadId = message.threadId || message.thread_id;
    if (!threadId) return;
    await api("POST", "/chat/status", {
        threadId,
        agentId: AGENT_ID,
        ...opts,
    });
}

async function main() {
    log(`starting agent=${AGENT_NAME} id=${AGENT_ID} poll=${POLL_SECONDS}s`);

    // Register runtime
    try {
        await api("POST", "/runtime/register", {
            runtimeId: `codex-${AGENT_ID.slice(0, 8)}`,
            name: `Codex on ${os.hostname()}`,
            hostname: os.hostname(),
            gatewayVersion: "codex-cli",
            capabilitiesJson: ["codex-cli", "thread-reply"],
        });
    } catch (e) { /* ignore */ }

    await heartbeat();

    let lastHeartbeat = Date.now();

    while (true) {
        try {
            if (Date.now() - lastHeartbeat >= 60000) {
                await heartbeat();
                lastHeartbeat = Date.now();
            }

            const messages = await syncMessages();
            for (const msg of messages) {
                const msgId = msg.id;
                if (!msgId || seen.has(msgId)) continue;

                // ── SAFETY CHECKS (pure logic in ./bridge-logic.js) ─────
                const threadId = msg.threadId || msg.thread_id || "";
                const text = (msg.text || "").trim();

                const decision = classifyMessage(msg, { agentId: AGENT_ID, agentName: AGENT_NAME });

                // Reset the loop guard whenever a human speaks in the thread.
                if (decision.resetLoop) loopCounts.set(threadId, 0);

                if (decision.action === "skip") {
                    seen.add(msgId);
                    if (msg.createdAt) lastSeenAt = msg.createdAt;
                    continue;
                }

                // Loop guard: cap consecutive non-human replies per thread.
                if (!loopGuardOk(loopCounts, threadId)) {
                    log(`loop guard tripped in thread ${threadId}, pausing`);
                    seen.add(msgId);
                    if (msg.createdAt) lastSeenAt = msg.createdAt;
                    continue;
                }

                log(`dispatching message ${msgId}: "${text.slice(0, 80)}..."`);
                
                // Budget check — skip if paused. Check on EVERY message: sampling
                // (every 5th) let a paused agent keep answering 4 of 5 messages.
                // checkBudget() is a single cheap GET and messages are infrequent.
                const budgetOk = await checkBudget();
                if (!budgetOk) {
                    await sendReply(msg, `⚠️ Budget exhausted. ${AGENT_NAME} is paused until the next billing cycle.`);
                    await updateStatus(msg, { typing: false, executionState: "resolved" });
                    seen.add(msgId);
                    if (msg.createdAt) lastSeenAt = msg.createdAt;
                    continue;
                }

                await updateStatus(msg, { markRead: true, executionState: "seen" });
                await updateStatus(msg, { typing: true, executionState: "acting" });

                // Operating manual + message prompt
                const prompt = [
                    `You are an AI agent running on EmperorClaw, an open-source AI operations platform (github.com/emperorclaw/emperorclaw).`,
                    `Agent: ${AGENT_NAME} | Role: ${AGENT_ROLE} | Runtime: Codex CLI (on-demand)`,
                    ``,
                    `## EmperorClaw Context`,
                    `- You reply to messages via chat. You do NOT have direct access to EmperorClaw tools (projects, tasks, storage).`,
                    `- For operations requiring EmperorClaw API access (listing projects, creating tasks, uploading files), direct the user to a Hermes agent.`,
                    `- Direct chat: private 1-on-1 thread. Reply normally.`,
                    `- Team chat: only respond when explicitly @mentioned by name. Stay silent otherwise.`,
                    `- Be concise. One clear answer per response. No walls of text.`,
                    ``,
                    `## Message to answer`,
                    text,
                ].join("\n");

                // Pipe prompt via stdin (Paperclip pattern)
                // shell:true needed on Windows for .cmd files
                try {
                    const result = await new Promise((resolve, reject) => {
                        const child = spawn("codex", ["exec", "-"], {
                            timeout: TIMEOUT_SECONDS * 1000,
                            stdio: ["pipe", "pipe", "pipe"],
                            shell: process.platform === "win32",
                            env: { ...process.env },
                        });

                        let stdout = "";
                        let stderr = "";
                        child.stdout.on("data", (d) => { stdout += d.toString("utf-8"); });
                        child.stderr.on("data", (d) => { stderr += d.toString("utf-8"); });

                        // Write prompt to stdin and close it
                        child.stdin.write(prompt);
                        child.stdin.end();

                        child.on("close", (code) => {
                            // Strip Codex rollout noise (Paperclip pattern)
                            const clean = stripCodexNoise(stdout);
                            const output = clean || stderr.trim();
                            resolve({ output, code });
                        });
                        child.on("error", reject);
                    });

                    if (result.output) {
                        await sendReply(msg, result.output);
                        log(`replied to ${msgId} (${result.output.length} chars)`);
                        // Estimate and report token usage. Split into input (prompt)
                        // vs output (reply) so the server applies the correct
                        // per-direction price and enforces budget.
                        const usage = estimateUsageTokens(text, result.output);
                        reportUsage(usage.inputTokens, usage.outputTokens).catch(() => {});
                    }
                } catch (execErr) {
                    log(`codex exec failed: ${execErr.message}`);
                    await sendReply(msg, `[Codex error: ${execErr.message}]`);
                }

                await updateStatus(msg, { typing: false, executionState: "resolved" });
                seen.add(msgId);
                if (msg.createdAt) lastSeenAt = msg.createdAt;

                // Keep seen set and loop counts bounded
                if (seen.size > 500) {
                    const arr = [...seen];
                    arr.splice(0, 250);
                    seen.clear();
                    arr.forEach((id) => seen.add(id));
                }
                if (loopCounts.size > 100) {
                    const entries = [...loopCounts.entries()];
                    entries.splice(0, 50);
                    loopCounts.clear();
                    entries.forEach(([k, v]) => loopCounts.set(k, v));
                }
            }
        } catch (e) {
            log(`loop error: ${e.message}`);
        }

        await new Promise((r) => setTimeout(r, POLL_SECONDS * 1000));
    }
}

main().catch((e) => {
    console.error("[emperor-codex] Fatal:", e.message);
    process.exit(1);
});
