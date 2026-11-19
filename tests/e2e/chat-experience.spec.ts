import { test, expect, type Page } from "@playwright/test";
import { randomUUID, createHash } from "node:crypto";

async function openChat(page: Page) {
    await page.addInitScript(() => localStorage.setItem("emperor:interactive-tour:v1", "done"));
    await page.goto("/login", { waitUntil: "networkidle" });
    await page.locator('input[type="email"]').fill(process.env.E2E_EMAIL ?? "admin@acme.com");
    await page.locator('input[type="password"]').fill(process.env.E2E_PASSWORD ?? "password123");
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(url => !url.pathname.startsWith("/login"));
    const response = await page.request.get("/api/agents");
    const { agents } = await response.json();
    const agent = agents.find((row: { use: string }) => row.use === "full");
    expect(agent).toBeTruthy();
    await page.goto(`/messages?agent=${agent.id}`, { waitUntil: "networkidle" });
    const input = page.getByRole("textbox", { name: `Message ${agent.name}` });
    await expect(input).toBeVisible();
    return { agent, input };
}

test("growing composer preserves IME and retries a failed send with the same identity", async ({ page }) => {
    const { input, agent } = await openChat(page);
    const initial = (await input.boundingBox())!.height;
    await input.fill("A multiline draft\n".repeat(8));
    await expect.poll(async () => (await input.boundingBox())!.height).toBeGreaterThan(initial + 40);
    let attempts = 0;
    const keys: string[] = [];
    await page.route("**/api/chat", async route => {
        if (route.request().method() !== "POST") return route.continue();
        keys.push(route.request().postDataJSON().clientMessageId);
        if (++attempts === 1) return route.abort("failed");
        return route.continue();
    });
    await input.dispatchEvent("keydown", { key: "Enter", isComposing: true, keyCode: 229 });
    expect(attempts).toBe(0);
    const sentText = `Chat browser retry ${randomUUID()}`;
    await input.fill(sentText);
    await input.press("Enter");
    await expect(page.getByTestId("pending-send")).toBeVisible();
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.getByTestId("pending-send")).toBeHidden();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    await expect(input).toHaveValue("");
    // Selecting existing content must release auto-follow before a new row lands.
    const transcript = page.locator(".ec-chat-transcript");
    await transcript.getByText(sentText, { exact: true }).evaluate(node => {
        const range = document.createRange(); range.selectNodeContents(node);
        const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    });
    await page.waitForTimeout(100);
    const before = await transcript.evaluate(node => node.scrollTop);
    const marker = `Selection arrival ${randomUUID()}`;
    const arrival = await page.request.post("/api/chat", { data: { clientMessageId: randomUUID(), targetAgentId: agent.id,
        text: `${marker}\n\n${"A long arrival while the reader has selected text.\n\n".repeat(80)}` } });
    expect(arrival.status(), await arrival.text()).toBe(200);
    await expect(transcript.getByText(marker, { exact: true })).toBeAttached();
    await page.waitForTimeout(200);
    expect(Math.abs((await transcript.evaluate(node => node.scrollTop)) - before)).toBeLessThan(30);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const animation = await page.evaluate(() => {
        const probe = document.createElement("span"); probe.className = "ec-chat-shimmer"; probe.textContent = "Working";
        document.body.append(probe); const name = getComputedStyle(probe).animationName; probe.remove(); return name;
    });
    expect(animation).toBe("none");
});

test("real preview transport settles into exactly one durable reply", async ({ page }) => {
    test.skip(!process.env.POSTGRES_CONNECTION_STRING || Boolean(process.env.E2E_BASE_URL), "requires the disposable local/CI database");
    const { agent } = await openChat(page);
    const chat = await (await page.request.get(`/api/chat?targetAgentId=${agent.id}`)).json();
    const { default: postgres } = await import("postgres");
    const sql = postgres(process.env.POSTGRES_CONNECTION_STRING!, { max: 1 });
    const runId = randomUUID(), responseId = randomUUID();
    const token = `ec_chat_test_${randomUUID()}`;
    const tokenHash = createHash("sha256").update(token).digest("hex");
    let savedId: string | null = null;
    try {
        await sql`insert into company_tokens(company_id, agent_id, token_hash, name, scope) values(${chat.thread.companyId},${agent.id},${tokenHash},'chat e2e','mcp_full')`;
        await sql`insert into agent_runs(id, company_id, agent_id, thread_id) values(${runId},${chat.thread.companyId},${agent.id},${chat.thread.id})`;
        const endpoint = `/api/mcp/agents/runs/${runId}/responses?agentId=${agent.id}`;
        const headers = { authorization: `Bearer ${token}` };
        const reply = `Partial response ${randomUUID()}`;
        const preview = await page.request.post(endpoint, { headers, data: { responseId, segmentIndex: 0, revision: 1, text: reply, state: "streaming" } });
        expect(preview.status(), await preview.text()).toBe(200);
        await expect(page.locator(".ec-chat-transcript").getByText(reply, { exact: true })).toBeVisible();
        const saved = await page.request.post("/api/mcp/messages/send", { headers, data: { agentId: agent.id, thread_id: chat.thread.id, text: reply, wake: false } });
        expect(saved.status(), await saved.text()).toBe(200);
        savedId = (await saved.json()).message_id;
        const finished = await page.request.patch(`/api/mcp/agents/runs/${runId}?agentId=${agent.id}`, { headers, data: { status: "succeeded", replyMessageId: savedId } });
        expect(finished.status(), await finished.text()).toBe(200);
        await expect(page.locator("[data-streaming-response]")).toHaveCount(0);
        await expect(page.locator(".ec-chat-transcript").getByText(reply, { exact: true })).toHaveCount(1);
    } finally {
        await sql`delete from agent_runs where id=${runId}`;
        if (savedId) await sql`delete from thread_messages where id=${savedId}`;
        await sql`delete from company_tokens where token_hash=${tokenHash}`;
        await sql.end();
    }
});
