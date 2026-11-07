import { test, expect, type Locator, type Page } from "@playwright/test";

const baseURL = () => process.env.E2E_BASE_URL || "http://127.0.0.1:3210";

/**
 * Regression for the v0.31.1 Views bug: the global press feedback scaled every
 * `a[href]` on :active, which made the anchor the containing block of its
 * `::after` overlay. Rows whose click target is that overlay (the title is a
 * stretched link) collapsed to the width of the text on pointer-down, so a
 * click anywhere else in the row released outside the link and never navigated.
 *
 * Every row assertion below clicks far from the link's own text box. Stretched
 * links are located by their overlay utilities, never by the fix's own
 * `data-stretched-link`, so these tests also run against a build that predates
 * the fix — that is what makes them a regression test and not a tautology.
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

const stretchedLinks = (scope: Page | Locator) => scope.locator('a[href][class*="after:inset-0"]');

/** The positioned row a stretched link stretches over. */
const rowOf = (link: Locator) => link.locator("xpath=ancestor::li[1]");

const scaleOf = (target: Locator) => target.evaluate((el) => getComputedStyle(el).scale);

/**
 * Press a point inside the row but outside the link's own box — the box the
 * overlay collapses to when the anchor is scaled — skipping anything that
 * paints above the overlay (the archive button, the row actions). Asserts that
 * such a point exists, so the test can never pass vacuously.
 */
async function pressOutsideLink(page: Page, row: Locator, link: Locator) {
  const box = await row.boundingBox();
  const linkBox = await link.boundingBox();
  expect(box, "row should be laid out").not.toBeNull();
  expect(linkBox, "stretched link should be laid out").not.toBeNull();

  const margins = [0.5, 0.65, 0.8, 0.9]; // y as a fraction of the row height
  const across = [0.95, 0.85, 0.75, 0.65, 0.5];
  const outside = (x: number, y: number) =>
    x > linkBox!.x + linkBox!.width + 4 || y > linkBox!.y + linkBox!.height + 4;
  const overControl = (x: number, y: number) =>
    page.evaluate(([px, py]) => {
      const el = document.elementFromPoint(px, py);
      return Boolean(el?.closest('button, [role="button"], input, select, textarea'));
    }, [x, y]);

  for (const fy of margins) {
    const y = box!.y + box!.height * fy;
    for (const fx of across) {
      const x = box!.x + box!.width * fx;
      if (!outside(x, y)) continue;
      if (await overControl(x, y)) continue;
      await page.mouse.move(x, y);
      await page.mouse.down();
      return;
    }
  }
  throw new Error("no press point outside the link's box: the row is too small to host this check");
}

test("a Views row opens from anywhere in the row, not only on the title", async ({ page }) => {
  await login(page);

  const title = `Row click regression ${Date.now()}`;
  const created = await page.request.post("/api/views", {
    data: { title, description: "Playwright fixture for the stretched-link click", scopeType: "company", visibility: "scope", panels: [] },
  });
  expect(created.status(), await created.text()).toBe(201);
  const { view } = (await created.json()) as { view: { id: string } };

  await page.goto("/views");
  const link = page.locator('a[href^="/views/"]').filter({ hasText: title });
  await expect(link).toBeVisible();

  await pressOutsideLink(page, rowOf(link), link);
  await page.mouse.up();

  await expect(page).toHaveURL(new RegExp(`/views/${view.id}$`), { timeout: 15_000 });
});

test("a needs-attention row opens from anywhere in the row", async ({ page }) => {
  await login(page);
  await page.goto("/");

  if ((await stretchedLinks(page).count()) === 0) test.skip(true, "no needs-attention entries on this instance");
  const link = stretchedLinks(page).first();
  const href = await link.getAttribute("href");
  expect(href).toBeTruthy();

  await pressOutsideLink(page, rowOf(link), link);
  await page.mouse.up();

  await page.waitForURL((url) => url.pathname === new URL(href!, baseURL()).pathname, { timeout: 15_000 });
});

test("the stretched title keeps its geometry on press (a scale would collapse the overlay)", async ({ page }) => {
  await login(page);
  await page.goto("/views");

  const link = stretchedLinks(page).first();
  await expect(link).toBeVisible();

  await pressOutsideLink(page, rowOf(link), link);
  await expect.poll(() => scaleOf(link), { timeout: 5_000 }).toBe("none");
  await page.mouse.up();
});

test("ordinary controls still answer the press with the scale", async ({ page }) => {
  await login(page);
  await page.goto("/views");

  const control = page.locator(".emperor-app-shell button:not([disabled]):not([data-no-press]):visible").first();
  await expect(control).toBeVisible();
  const box = await control.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await expect
    .poll(async () => Number.parseFloat(await scaleOf(control)), { timeout: 5_000 })
    .toBeCloseTo(0.97, 2);
  await page.mouse.up();
  await expect.poll(() => scaleOf(control)).toBe("none");
});
