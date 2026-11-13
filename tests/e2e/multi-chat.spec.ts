import { test, expect, type Page } from "@playwright/test";

/**
 * Several chats per agent (docs/design/multi-chat-per-agent.md §6, §11 E2E):
 * New chat → first message → the switcher shows it; the `?agent=&thread=`
 * deep link survives a reload; archive makes the chat read-only and Restore
 * brings it back.
 *
 * Needs an agent the signed-in person may fully use and a person who may
 * change the company settings. The company is put in private direct-chat mode
 * with multiple chats on for the run and put back as it was in afterAll, even
 * when the test fails. A missing precondition fails the run with the reason;
 * set E2E_ALLOW_SKIP=1 to skip instead.
 */

const EMAIL = process.env.E2E_EMAIL ?? "admin@acme.com";
const PASSWORD = process.env.E2E_PASSWORD ?? "password123";

async function login(page: Page) {
    await page.goto("/login");
    await page.locator('input[type="email"]').fill(EMAIL);
    await page.locator('input[type="password"]').fill(PASSWORD);
    await page.locator('form button[type="submit"]').click();
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 45_000 });
}

type DirectChatSettings = { mode: "shared" | "private"; multiChatEnabled: boolean };
type StorageState = Awaited<ReturnType<import("@playwright/test").BrowserContext["storageState"]>>;

/** The settings to put back, and the signed-in session to do it with (the test's page is gone by afterAll). */
let toRestore: { settings: DirectChatSettings; storageState: StorageState } | null = null;

test.afterAll(async ({ playwright }, testInfo) => {
    if (!toRestore) return;
    const { settings, storageState } = toRestore;
    toRestore = null;
    const request = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL, storageState });
    try {
        const res = await request.put("/api/settings/direct-chats", { data: { mode: settings.mode, multiChatEnabled: settings.multiChatEnabled } });
        expect(res.status(), `restoring direct-chat settings: ${await res.text()}`).toBe(200);
    } finally {
        await request.dispose();
    }
});

/** A precondition the run needs: fail with the reason, or skip when E2E_ALLOW_SKIP is set. */
function requirePrecondition(ok: boolean, reason: string) {
    if (ok) return;
    if (process.env.E2E_ALLOW_SKIP) test.skip(true, reason);
    throw new Error(`Precondition not met: ${reason} (set E2E_ALLOW_SKIP=1 to skip instead)`);
}

test("new chat, deep link across a reload, archive and restore", async ({ page }) => {
    await login(page);

    const before = await page.request.get("/api/settings/direct-chats");
    requirePrecondition(before.status() === 200, `reading the direct-chat settings answered ${before.status()}`);
    const original = (await before.json()) as DirectChatSettings;
    const put = await page.request.put("/api/settings/direct-chats", { data: { mode: "private", multiChatEnabled: true } });
    requirePrecondition(put.status() === 200, `${EMAIL} may not change the direct-chat settings (${put.status()}): sign in as an admin`);
    toRestore = { settings: original, storageState: await page.context().storageState() };

    const agentsRes = await page.request.get("/api/agents");
    expect(agentsRes.status()).toBe(200);
    const { agents } = (await agentsRes.json()) as { agents: { id: string; name: string; use: string }[] };
    const agent = agents.find((a) => a.use === "full");
    requirePrecondition(Boolean(agent), `${EMAIL} has no agent they may fully use`);

    await page.goto(`/messages?agent=${agent!.id}`);
    const newChat = page.getByRole("button", { name: "New chat" });
    await expect(newChat).toBeVisible();
    await newChat.click();
    await expect(page.getByText(`New chat with ${agent!.name}`)).toBeVisible();

    const title = `Multi-chat e2e ${Date.now()}`;
    const composer = page.getByRole("textbox", { name: `Message ${agent!.name}` });
    await composer.fill(title);
    await composer.press("Enter");

    // The chat now exists: the URL names it exactly and the switcher shows its title.
    await page.waitForURL((url) => url.searchParams.get("thread") !== null && url.searchParams.get("agent") === agent!.id);
    const threadId = new URL(page.url()).searchParams.get("thread")!;
    const switcher = page.getByRole("button", { name: `Switch chat. Current chat: ${title}` });
    await expect(switcher).toBeVisible();
    await switcher.click();
    await expect(page.getByRole("menuitem", { name: new RegExp(title) })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /Main chat/ })).toBeVisible();
    await page.keyboard.press("Escape");

    // A reload opens the same chat.
    await page.reload();
    await expect(page.getByRole("button", { name: `Switch chat. Current chat: ${title}` })).toBeVisible();
    expect(new URL(page.url()).searchParams.get("thread")).toBe(threadId);

    // Archive: read-only with Restore; Restore brings the composer back.
    await page.getByRole("button", { name: "Chat options" }).click();
    await page.getByRole("menuitem", { name: "Archive" }).click();
    await expect(page.getByText("This chat is read-only until you restore it.", { exact: false })).toBeVisible();
    await expect(composer).toHaveCount(0);
    await page.getByRole("button", { name: "Restore" }).click();
    await expect(page.getByRole("textbox", { name: `Message ${agent!.name}` })).toBeVisible();

    // Tidy up: leave the chat archived so repeated runs never reach the cap.
    const archived = await page.request.patch(`/api/chat/threads/${threadId}`, { data: { archived: true } });
    expect(archived.status(), await archived.text()).toBe(200);
});
