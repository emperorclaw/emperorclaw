import { test, expect, type Page } from "@playwright/test";

/**
 * Opening a chat is a transition, not a repaint (docs: motion.tsx, chat-enter.ts):
 * the first page of a freshly opened chat rides the shared 400 ms spring with a
 * 30 ms step per row, the panel keeps its final frame, and under
 * prefers-reduced-motion the same class becomes an opacity fade of 160 ms.
 * The contract is measured on the built stylesheet, so it cannot silently drift.
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

/** What the built stylesheet does to `.ec-message-in`, with and without a stagger step. */
function readMessageEntrance(page: Page) {
    return page.evaluate(() => {
        const FRAME_META = new Set(["offset", "computedOffset", "easing", "composite"]);
        const probe = (stagger: number | null) => {
            const element = document.createElement("div");
            element.className = "ec-message-in";
            element.textContent = "probe";
            if (stagger !== null) element.style.setProperty("--ec-stagger", String(stagger));
            document.body.append(element);
            const style = getComputedStyle(element);
            const animation = element.getAnimations()[0];
            const frames = animation ? ((animation.effect as KeyframeEffect).getKeyframes() ?? []) : [];
            const props = new Set<string>();
            for (const frame of frames) {
                for (const key of Object.keys(frame)) if (!FRAME_META.has(key)) props.add(key);
            }
            const result = {
                name: style.animationName,
                duration: style.animationDuration,
                delay: style.animationDelay,
                animated: [...props].sort(),
            };
            element.remove();
            return result;
        };
        return { first: probe(0), third: probe(2), plain: probe(null) };
    });
}

/** The chat column's place inside its card: a panel that keeps its final frame while opening. */
function chatColumnBox(page: Page) {
    return page.evaluate(() => {
        const column = document.querySelector("section")!.getBoundingClientRect();
        const card = document.querySelector(".emperor-panel")!.getBoundingClientRect();
        return { y: column.y - card.y, height: column.height };
    });
}

test("a chat that opens enters on the shared spring, staggered, and focuses its composer", async ({ page }) => {
    await login(page);

    // Several chats per agent need private mode with the setting on; put back afterwards.
    const before = await page.request.get("/api/settings/direct-chats");
    expect(before.status()).toBe(200);
    const original = (await before.json()) as DirectChatSettings;
    const put = await page.request.put("/api/settings/direct-chats", { data: { mode: "private", multiChatEnabled: true } });
    expect(put.status(), `${EMAIL} may not change the direct-chat settings: sign in as an admin`).toBe(200);
    toRestore = { settings: original, storageState: await page.context().storageState() };

    const agentsRes = await page.request.get("/api/agents");
    const { agents } = (await agentsRes.json()) as { agents: { id: string; name: string; use: string }[] };
    const agent = agents.find((a) => a.use === "full");
    expect(agent, `${EMAIL} has no agent they may fully use`).toBeTruthy();

    await page.goto(`/messages?agent=${agent!.id}`);
    const composer = page.getByRole("textbox", { name: `Message ${agent!.name}` });
    await expect(composer).toBeVisible();

    // The shared spring, and the step: 400 ms, 30 ms per row, opacity + translate only.
    const full = await readMessageEntrance(page);
    expect(full.first.name).toBe("ec-message-in");
    expect(full.first.duration).toBe("0.4s");
    expect(full.first.delay).toBe("0s");
    expect(full.third.delay).toBe("0.06s");
    expect(full.plain.delay).toBe("0s");
    expect(full.first.animated, "opacity and 8 px of travel, never height or layout").toEqual(["opacity", "translate"]);

    // New chat: the empty card enters, the caret lands in the composer, nothing moves.
    // (The webfont settles the page header, so measure the chat column inside its card:
    // a height or a scale animation here would show up as the column changing place.)
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(100);
    const panelBefore = await chatColumnBox(page);
    await page.getByRole("button", { name: "New chat" }).click();
    await expect(page.getByText(`New chat with ${agent!.name}`)).toBeVisible();
    await expect(composer).toBeFocused();
    const panelAfter = await chatColumnBox(page);
    expect(Math.abs(panelAfter.y - panelBefore.y), `chat column moved: ${JSON.stringify({ panelBefore, panelAfter })}`).toBeLessThan(0.5);
    expect(Math.abs(panelAfter.height - panelBefore.height), `chat column resized: ${JSON.stringify({ panelBefore, panelAfter })}`).toBeLessThan(0.5);

    // Reduced motion: opacity only, short, no stagger and no movement.
    await page.emulateMedia({ reducedMotion: "reduce" });
    const reduced = await readMessageEntrance(page);
    expect(reduced.first.name).toBe("ec-scrim-in");
    expect(reduced.first.duration).toBe("0.16s");
    expect(reduced.third.delay).toBe("0s");
    expect(reduced.first.animated, "reduced motion fades only: no transform, no travel").toEqual(["opacity"]);
});
