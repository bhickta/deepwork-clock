/**
 * Helpers for the browser regression tests.
 *
 * The browser checks cover what jsdom cannot: the real cascade of the
 * stylesheet, the layout in the proposed window sizes and the accessibility
 * tree of the rendered page.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

export const NORMAL_VIEW = { width: 420, height: 440 };
export const COMPACT_VIEW = { width: 320, height: 200 };
export const SMALL_COMPACT_VIEW = { width: 300, height: 160 };

export const EVIDENCE_DIR =
  process.env.PREVIEW_EVIDENCE_DIR ?? "/tmp/deepwork-workers/preview";

/** Open the development preview and wait for the timer to be rendered. */
export async function openPreview(page: Page, query = "demo=1"): Promise<void> {
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
  });
  await page.goto(`/?${query}`);
  await expect(page.locator(".timer-panel")).toBeVisible();
  await expect(page.locator("#timer-digits")).toBeVisible();
  if (errors.length > 0) {
    throw new Error(`page errors: ${errors.join(", ")}`);
  }
}

/** Assert that the page has no serious or critical accessibility problems. */
export async function expectNoSeriousAxeViolations(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
    .analyze();
  const serious = results.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical"
  );
  if (serious.length > 0) {
    const summary = serious
      .map((violation) => `${violation.id} (${violation.impact}): ${violation.help}`)
      .join(" | ");
    throw new Error(`axe found problems in ${label}: ${summary}`);
  }
}

/** Save a screenshot as evidence. */
export async function saveEvidence(page: Page, name: string): Promise<string> {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const path = `${EVIDENCE_DIR}/${name}.png`;
  await page.screenshot({ path });
  return path;
}

/** True when the element is inside the visible area of the viewport. */
export async function isFullyVisible(page: Page, selector: string): Promise<boolean> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) {
    return false;
  }
  const viewport = page.viewportSize();
  if (!viewport) {
    return false;
  }
  return (
    box.y >= 0 &&
    box.x >= 0 &&
    box.y + box.height <= viewport.height + 0.5 &&
    box.x + box.width <= viewport.width + 0.5
  );
}

/** True when the document scrolls sideways. */
export async function hasHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
  );
}

/**
 * Measure the horizontal overflow of the page and of the nested boxes.
 *
 * A page can scroll sideways because of one wide element, and a dialog can
 * clip its own content even when the page itself does not scroll. Both are
 * checked here.
 */
export interface OverflowReport {
  root: number;
  boxes: Record<string, number>;
  outsideViewport: string[];
}

export async function measureOverflow(page: Page): Promise<OverflowReport> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const boxes: Record<string, number> = {};
    const selectors = [
      ".modal",
      ".modal__body",
      ".modal__footer",
      ".settings-form",
      ".fieldset",
      ".duration-group",
      ".duration-parts",
      ".timer-panel",
      ".app-header",
      ".app-main"
    ];
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      if (node) {
        boxes[selector] = node.scrollWidth - node.clientWidth;
      }
    }
    const outside: string[] = [];
    const limit = root.clientWidth;
    for (const node of document.querySelectorAll<HTMLElement>("#app *")) {
      const rect = node.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        continue;
      }
      if (rect.right > limit + 1 || rect.left < -1) {
        const label = node.className ? `.${String(node.className).split(" ")[0]}` : node.tagName.toLowerCase();
        outside.push(`${label} (${Math.round(rect.left)}..${Math.round(rect.right)})`);
      }
    }
    return {
      root: root.scrollWidth - root.clientWidth,
      boxes,
      outsideViewport: outside.slice(0, 10)
    };
  });
}
