import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * Automated accessibility and layout checks for the frontend preview.
 *
 * Scope and limits: axe inspects the DOM that the browser exposes. It cannot
 * judge the packaged WebView accessibility tree, native menus, focus order
 * inside the native shell or screen-reader announcements. A passing run here
 * is one input to the manual matrix, never a replacement for it.
 *
 * The suite runs against the development preview (`?demo=1`), because the
 * production bundle has no Tauri backend to talk to.
 */
const DEMO_URL = "/?demo=1";

async function openPreview(page: Page): Promise<void> {
  await page.goto(DEMO_URL);
  const app = page.locator("#app");
  await expect(app).toBeVisible({ timeout: 20_000 });
  // The preview must show a real timer, not the "backend unavailable" shell.
  await expect(page.getByRole("timer")).toBeVisible();
  await expect(page.getByRole("button", { name: "Start", exact: true })).toBeVisible();
}

async function openSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "More options" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

test.describe("frontend preview (demo bridge)", () => {
  test("shows the timer and the start control in the idle state", async ({ page }) => {
    await openPreview(page);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.getByRole("timer")).toHaveAttribute("aria-live", "off");
  });

  test("no serious or critical automated accessibility violations", async ({ page }) => {
    await openPreview(page);
    const results = await new AxeBuilder({ page }).analyze();
    const blocking = results.violations.filter(
      (violation) => violation.impact === "serious" || violation.impact === "critical",
    );
    expect(
      blocking.map((violation) => `${violation.id} (${violation.impact}): ${violation.help}`),
      "serious and critical axe violations must be fixed before a release",
    ).toEqual([]);
  });

  test("the timer is not an active live region", async ({ page }) => {
    await openPreview(page);
    // role="timer" with aria-live="off" is the intended pattern: the digits
    // must not be announced every second.
    const timer = page.getByRole("timer");
    await expect(timer).toHaveAttribute("aria-live", "off");

    // Only *active* live regions are checked for a conflicting timer role.
    const offenders = await page.locator('[aria-live="polite"], [aria-live="assertive"]').evaluateAll(
      (nodes) =>
        nodes
          .filter((node) => node.getAttribute("role") === "timer")
          .map((node) => node.getAttribute("id") ?? node.tagName.toLowerCase()),
    );
    expect(offenders, "an active live region must not use role=timer").toEqual([]);

    // A separate polite region announces state changes exactly once.
    await expect(page.locator("#live-region")).toHaveAttribute("aria-live", "polite");
  });

  test("the idle view hides the recovery prompt and the history", async ({ page }) => {
    await openPreview(page);
    await expect(page.getByRole("heading", { name: "Unfinished session found" })).toBeHidden();
    await expect(page.getByRole("dialog")).toBeHidden();
  });

  test("starting the timer switches the primary control to pause", async ({ page }) => {
    await openPreview(page);
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
    await expect(page.getByRole("timer")).toBeVisible();
  });

  test("the settings dialog is labelled and can be cancelled", async ({ page }) => {
    await openPreview(page);
    await openSettings(page);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    await expect(page.getByLabel("Theme")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("the dark and the high contrast theme are applied", async ({ page }) => {
    await openPreview(page);
    await openSettings(page);

    await page.getByLabel("Theme").selectOption("dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    await page.getByLabel("Theme").selectOption("high-contrast");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "high-contrast");
  });

  test("the compact view is reachable without losing the timer", async ({ page }) => {
    await openPreview(page);
    await page.getByRole("button", { name: "Compact view", exact: true }).click();
    await expect(page.locator("#app")).toHaveAttribute("data-view", "compact");
    await expect(page.getByRole("timer")).toBeVisible();

    await page.getByRole("button", { name: "Expanded view" }).click();
    await expect(page.locator("#app")).toHaveAttribute("data-view", "normal");
    await expect(page.getByRole("timer")).toBeVisible();
  });

  test("200% text scale reflows into a narrow window without horizontal overflow", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 720 });
    await openPreview(page);
    await openSettings(page);

    const scale = page.locator("#text-scale");
    await scale.fill("2");
    await scale.dispatchEvent("input");
    await expect(page.locator("html")).toHaveAttribute("style", /--text-scale:\s*2/);

    const overflow = await page.evaluate(() => {
      const root = document.documentElement;
      return root.scrollWidth - root.clientWidth;
    });
    expect(overflow, "the view must not scroll sideways at 200% text size").toBeLessThanOrEqual(2);
  });
});
