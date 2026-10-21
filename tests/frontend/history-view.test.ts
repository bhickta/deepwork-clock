// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HistoryView } from "../../src/history-view";
import type { ExportFormat } from "../../src/contract";
import { makeHistoryRecord } from "./helpers/fake-bridge";

interface Harness {
  view: HistoryView;
  exports: ExportFormat[];
  confirmed: string[];
  deleted: number;
}

function build(records = [] as ReturnType<typeof makeHistoryRecord>[]): Harness {
  const harness: Harness = {
    view: null as unknown as HistoryView,
    exports: [],
    confirmed: [],
    deleted: 0
  };
  harness.view = new HistoryView(document, {
    onExport: async (format) => {
      harness.exports.push(format);
    },
    onDeleteAll: async () => {
      harness.deleted += 1;
    },
    onConfirm: async (phaseId) => {
      harness.confirmed.push(phaseId);
    }
  });
  document.body.appendChild(harness.view.element);
  harness.view.update(records);
  return harness;
}

beforeEach(() => {
  document.body.textContent = "";
});

describe("HistoryView", () => {
  it("shows an empty state without records", () => {
    const harness = build();
    expect(harness.view.element.querySelectorAll(".history-item")).toHaveLength(0);
    expect(harness.view.element.querySelector(".history__empty")?.hasAttribute("hidden")).toBe(false);
  });

  it("leaves interrupted sessions out of the confirmed total", () => {
    const harness = build([
      makeHistoryRecord({ phaseId: "a", durationMs: 25 * 60_000, interrupted: false }),
      makeHistoryRecord({ phaseId: "b", durationMs: 10 * 60_000, interrupted: true, confirmed: false })
    ]);

    const summary = harness.view.element.querySelector(".history__summary")?.textContent ?? "";
    expect(summary).toContain("25 min");
    expect(summary).toContain("1 sessions");
  });

  it("offers a confirmation for an interrupted session", async () => {
    const harness = build([
      makeHistoryRecord({ phaseId: "b", interrupted: true, confirmed: false })
    ]);

    const button = harness.view.element.querySelector<HTMLButtonElement>(
      '[data-action="confirm-record"]'
    );
    expect(button).not.toBeNull();
    button?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.confirmed).toEqual(["b"]);
  });

  it("does not offer a confirmation for a finished session", () => {
    const harness = build([makeHistoryRecord({ phaseId: "a", interrupted: false })]);
    expect(harness.view.element.querySelector('[data-action="confirm-record"]')).toBeNull();
  });

  it("exports through the backend", async () => {
    const harness = build();
    harness.view.element.querySelector<HTMLButtonElement>('[data-action="export-csv"]')?.click();
    harness.view.element.querySelector<HTMLButtonElement>('[data-action="export-json"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.exports).toEqual(["csv", "json"]);
  });

  it("asks the owner before deleting every record", async () => {
    const harness = build();
    harness.view.element.querySelector<HTMLButtonElement>('[data-action="delete-all"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.deleted).toBe(1);
  });

  it("keeps the focus on the record that was confirmed", async () => {
    const harness = build([
      makeHistoryRecord({ phaseId: "a", interrupted: true, confirmed: false }),
      makeHistoryRecord({ phaseId: "b", interrupted: true, confirmed: false })
    ]);

    const button = harness.view.element.querySelector<HTMLButtonElement>(
      '[data-action="confirm-record"]'
    );
    button?.focus();
    button?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.activeElement?.getAttribute("data-action")).toBe("confirm-record");
  });

  it("announces nothing on its own", () => {
    const announce = vi.fn();
    const view = new HistoryView(document, {
      onExport: async () => undefined,
      onDeleteAll: async () => undefined,
      onConfirm: async () => undefined
    });
    view.update([makeHistoryRecord()]);
    expect(announce).not.toHaveBeenCalled();
  });
});
