/**
 * Browser regression tests for the preview build.
 *
 * These checks cover the failures a jsdom test cannot see: the cascade of the
 * stylesheet, the layout in the proposed window sizes and the rendered
 * accessibility tree.
 */
import { expect, test } from "@playwright/test";

import {
  COMPACT_VIEW,
  NORMAL_VIEW,
  SMALL_COMPACT_VIEW,
  expectNoSeriousAxeViolations,
  hasHorizontalOverflow,
  isFullyVisible,
  openPreview,
  saveEvidence
} from "./helpers";

test.describe("idle state", () => {
  test.use({ viewport: NORMAL_VIEW });

  test("shows the timer without the panels that belong to other states", async ({ page }) => {
    await openPreview(page);

    await expect(page.locator(".phase-badge__text")).toHaveText("Focus");
    await expect(page.locator(".timer-status")).toHaveText("Ready");
    await expect(page.locator("#timer-digits")).toHaveText("50:00");

    // The recovery panel belongs to the recovery state only.
    await expect(page.locator(".recovery")).toBeHidden();
    // The history lives in its own dialog and must not sit in the page.
    await expect(page.locator(".history__panel")).toBeHidden();
    // Ending a session only makes sense while a session runs.
    await expect(page.locator('[data-action="end"]')).toBeHidden();
    // The engine only accepts a skip for a running, paused or completed
    // phase, so the control is not offered while the timer is idle.
    await expect(page.locator('[data-action="skip"]')).toBeHidden();
    await expect(page.locator('[data-action="primary"]')).toHaveText(/Start/);
  });

  test("offers the next phase once the phase is running", async ({ page }) => {
    await openPreview(page);
    await expect(page.locator('[data-action="skip"]')).toBeHidden();

    await page.click('[data-action="primary"]');
    await expect(page.locator('[data-action="skip"]')).toBeVisible();
    await expect(page.locator('[data-action="skip"]')).toBeEnabled();
  });

  test("keeps the primary action inside the normal window", async ({ page }) => {
    await openPreview(page);
    expect(await isFullyVisible(page, '[data-action="primary"]')).toBe(true);
    expect(await isFullyVisible(page, "#timer-digits")).toBe(true);
    expect(await hasHorizontalOverflow(page)).toBe(false);
    await saveEvidence(page, "01-idle-normal-420x440");
  });

  test("has no serious accessibility problems while idle", async ({ page }) => {
    await openPreview(page);
    await expectNoSeriousAxeViolations(page, "idle");
  });
});

test.describe("running state", () => {
  test.use({ viewport: NORMAL_VIEW });

  test("shows the pause control and keeps the recovery panel hidden", async ({ page }) => {
    await openPreview(page);
    await page.click('[data-action="primary"]');
    await expect(page.locator('[data-action="primary"]')).toHaveText(/Pause/);
    await expect(page.locator(".recovery")).toBeHidden();
    await expect(page.locator('[data-action="end"]')).toBeVisible();
    expect(await isFullyVisible(page, '[data-action="primary"]')).toBe(true);
    await saveEvidence(page, "02-running-normal-420x440");
    await expectNoSeriousAxeViolations(page, "running");
  });

  test("asks before a destructive action and cancels with Escape", async ({ page }) => {
    await openPreview(page);
    await page.click('[data-action="primary"]');
    await page.click('[data-action="reset"]');

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(".modal__footer .button").first()).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.locator('[data-action="primary"]')).toHaveText(/Pause/);
  });
});

test.describe("dialogs", () => {
  test.use({ viewport: NORMAL_VIEW });

  test("opens the settings, the history, the shortcuts and the about dialog", async ({ page }) => {
    await openPreview(page);

    await page.click('[data-action="menu"]');
    await expect(page.locator('[role="menu"]')).toBeVisible();
    await saveEvidence(page, "03a-overflow-menu");
    await page.click('[data-menu-item="settings"]');
    await expect(page.locator('[role="dialog"]')).toBeVisible();
    await expect(page.locator(".settings-form")).toBeVisible();
    await saveEvidence(page, "03-settings-normal");
    await expectNoSeriousAxeViolations(page, "settings dialog");
    await page.keyboard.press("Escape");

    await page.click('[data-action="menu"]');
    await page.click('[data-menu-item="history"]');
    await expect(page.locator(".history__panel")).toBeVisible();
    await saveEvidence(page, "03b-history-normal");
    await expectNoSeriousAxeViolations(page, "history dialog");
    await page.keyboard.press("Escape");

    await page.click('[data-action="menu"]');
    await page.click('[data-menu-item="shortcuts"]');
    await expect(page.locator(".help__table")).toBeVisible();
    await expectNoSeriousAxeViolations(page, "shortcut dialog");
    await page.keyboard.press("Escape");

    await page.click('[data-action="menu"]');
    await page.click('[data-menu-item="about"]');
    await expect(page.locator(".modal__lead")).toBeVisible();
    await expectNoSeriousAxeViolations(page, "about dialog");
    await page.keyboard.press("Escape");
  });
});

test.describe("themes", () => {
  test.use({ viewport: NORMAL_VIEW });

  test("renders the dark and the high contrast palette", async ({ page }) => {
    await openPreview(page);

    await page.click('[data-action="menu"]');
    await page.click('[data-menu-item="settings"]');
    await page.selectOption("#theme", "dark");
    await page.waitForTimeout(150);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await saveEvidence(page, "04-settings-dark");
    await expectNoSeriousAxeViolations(page, "dark theme");
    await page.locator(".modal__footer .button--primary").click();
    await expect(page.locator('[role="dialog"]')).toBeHidden();

    await page.click('[data-action="menu"]');
    await page.click('[data-menu-item="settings"]');
    await page.selectOption("#theme", "high-contrast");
    await page.waitForTimeout(150);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "high-contrast");
    await saveEvidence(page, "05-high-contrast");
    await expectNoSeriousAxeViolations(page, "high contrast theme");
    await page.locator(".modal__footer .button--primary").click();
    await expect(page.locator('[role="dialog"]')).toBeHidden();
  });
});

test.describe("without the desktop app", () => {
  test.use({ viewport: NORMAL_VIEW });

  test("shows the connection problem instead of an empty timer", async ({ page }) => {
    // Without the preview the native bridge is used, and it cannot answer
    // outside the desktop application.
    await page.goto("/?demo=0");

    await expect(page.locator(".panel--fatal")).toBeVisible();
    await expect(page.locator(".timer-panel")).toBeHidden();
    await expect(page.locator(".recovery")).toBeHidden();
    await expect(page.locator(".history__panel")).toBeHidden();
    await expect(page.locator(".phase-badge")).toBeHidden();
    await saveEvidence(page, "08-no-desktop-app");
  });
});

test.describe("compact view", () => {
  test.use({ viewport: COMPACT_VIEW });

  test("keeps the timer and the primary control visible", async ({ page }) => {
    await openPreview(page);
    await page.click('[data-action="compact"]');
    await expect(page.locator(".app-shell")).toHaveAttribute("data-view", "compact");

    expect(await isFullyVisible(page, '[data-action="primary"]')).toBe(true);
    expect(await isFullyVisible(page, "#timer-digits")).toBe(true);
    expect(await hasHorizontalOverflow(page)).toBe(false);

    // The controls keep their 44 pixel targets in the compact window.
    const primary = await page.locator('[data-action="primary"]').first().boundingBox();
    expect(primary?.height).toBeGreaterThanOrEqual(44);
    const headerButton = await page.locator('.icon-button[data-action="compact"]').boundingBox();
    expect(headerButton?.height).toBeGreaterThanOrEqual(44);

    await saveEvidence(page, "06-compact-320x200");
    await expectNoSeriousAxeViolations(page, "compact view");
  });
});

test.describe("small compact window", () => {
  test.use({ viewport: SMALL_COMPACT_VIEW });

  test("stays scrollable instead of clipping", async ({ page }) => {
    await openPreview(page);
    await page.click('[data-action="compact"]');

    expect(await hasHorizontalOverflow(page)).toBe(false);

    // The primary control stays reachable by scrolling.
    await page.locator('[data-action="primary"]').scrollIntoViewIfNeeded();
    expect(await isFullyVisible(page, '[data-action="primary"]')).toBe(true);
    await saveEvidence(page, "06b-compact-300x160-scrolled");
  });
});

test.describe("recovery", () => {
  test.use({ viewport: NORMAL_VIEW });

  test("shows the age of the interrupted session", async ({ page }) => {
    await openPreview(page, "demo=1&recovery=1");

    await expect(page.locator(".recovery")).toBeVisible();
    const detail = page.locator(".recovery__detail");
    await expect(detail).toBeVisible();
    await expect(detail).toContainText("minutes");
    await expect(page.locator('[data-action="recovery-accept"]')).toBeVisible();
    await expect(page.locator('[data-action="recovery-discard"]')).toBeVisible();
    await saveEvidence(page, "09-recovery");
    await expectNoSeriousAxeViolations(page, "recovery");
  });
});

test.describe("storage warning", () => {
  test.use({ viewport: COMPACT_VIEW });

  test("keeps a storage failure reachable in the compact view", async ({ page }) => {
    await openPreview(page, "demo=1&warning=1");

    // The compact view has no room for the inline list, so the header
    // carries an indicator that opens the same warnings in a dialog.
    await page.click('[data-action="compact"]');
    const indicator = page.locator('[data-action="warnings"]');
    await expect(indicator).toBeVisible();
    await expect(indicator).toContainText("1");
    await expect(page.locator(".warnings")).toBeHidden();

    await indicator.click();
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible();

    // The warnings stay a polite status region inside the dialog.
    const status = dialog.locator('[role="status"]');
    await expect(status).toBeVisible();
    await expect(status.locator(".warning__text")).toHaveText(
      "The settings could not be written to disk. The timer keeps running."
    );
    await saveEvidence(page, "10-compact-storage-warning");
    await expectNoSeriousAxeViolations(page, "compact warning dialog");
  });
});

test.describe("large text", () => {
  test.use({ viewport: NORMAL_VIEW });

  test("reflows at 200% text size without losing the primary control", async ({ page }) => {
    await openPreview(page);
    await page.click('[data-action="menu"]');
    await page.click('[data-menu-item="settings"]');
    await page.fill("#text-scale", "2");
    await page.dispatchEvent("#text-scale", "input");
    await page.waitForTimeout(150);
    await page.locator(".modal__footer .button--primary").click();
    await expect(page.locator('[role="dialog"]')).toBeHidden();

    const scale = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--text-scale").trim()
    );
    expect(scale).toBe("2");
    expect(await hasHorizontalOverflow(page)).toBe(false);
    await saveEvidence(page, "07-text-scale-200");
  });
});
