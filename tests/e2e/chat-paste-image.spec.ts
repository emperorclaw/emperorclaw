import { test, expect, type Page } from "@playwright/test";

/**
 * Paste-to-attach (src/lib/clipboard-images.ts): images pasted into the chat
 * composer upload through /api/chat/attachments exactly like the attach button,
 * screenshots without a real filename get `pasted-image-<timestamp>`, several
 * images in one paste each become an attachment, and a text paste is left to
 * the browser. Needs an agent the signed-in person may fully use; a missing
 * precondition fails the run with the reason (E2E_ALLOW_SKIP=1 skips instead).
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

function requirePrecondition(ok: boolean, reason: string) {
    if (ok) return;
    if (process.env.E2E_ALLOW_SKIP) test.skip(true, reason);
    throw new Error(`Precondition not met: ${reason} (set E2E_ALLOW_SKIP=1 to skip instead)`);
}

/** Dispatches a paste carrying the given clipboard content; returns whether the composer took it over. */
function paste(page: Page, label: string, content: { images?: number; text?: string }) {
    return page.getByRole("textbox", { name: label }).evaluate(async (el, { images, text }) => {
        const data = new DataTransfer();
        if (text) data.setData("text/plain", text);
        // A 1x1 PNG, named like Chrome names clipboard screenshots.
        const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
        for (let i = 0; i < (images ?? 0); i++) data.items.add(new File([png], "image.png", { type: "image/png" }));
        const event = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
        el.dispatchEvent(event);
        return event.defaultPrevented;
    }, content);
}

test("pasting images attaches them; pasting text does not", async ({ page }) => {
    await login(page);
    const agentsRes = await page.request.get("/api/agents");
    expect(agentsRes.status()).toBe(200);
    const { agents } = (await agentsRes.json()) as { agents: { id: string; name: string; use: string }[] };
    const agent = agents.find((a) => a.use === "full");
    requirePrecondition(Boolean(agent), `${EMAIL} has no agent they may fully use`);

    await page.goto(`/messages?agent=${agent!.id}`);
    const label = `Message ${agent!.name}`;
    await expect(page.getByRole("textbox", { name: label })).toBeVisible();

    expect(await paste(page, label, { text: "just words" }), "a text paste stays with the browser").toBe(false);

    const uploads = page.waitForResponse((res) => res.url().endsWith("/api/chat/attachments") && res.request().method() === "POST");
    expect(await paste(page, label, { images: 2 }), "an image paste is taken over").toBe(true);
    expect((await uploads).status()).toBe(200);

    const chips = page.getByText(/^pasted-image-\d{8}-\d{6}-[12]\.png$/);
    await expect(chips).toHaveCount(2);
});
