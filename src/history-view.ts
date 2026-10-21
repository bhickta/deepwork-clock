import { el, setHidden, setText, updateScrollableFocus } from "./dom";
import { createIcon } from "./icons";
import {
  confirmedFocusTotals,
  formatDurationLong,
  formatDurationTotal,
  formatLocalDate,
  formatTimestamp
} from "./format";
import type { ExportFormat, HistoryRecord, Phase } from "./contract";
import { t } from "./i18n";

export interface HistoryViewOptions {
  onExport(format: ExportFormat): Promise<void>;
  onDeleteAll(): Promise<void>;
  onConfirm(phaseId: string): Promise<void>;
}

const PHASE_LABEL_KEYS = {
  focus: "history.item.focus",
  short_break: "history.item.short_break",
  long_break: "history.item.long_break"
} as const;

const OUTCOME_LABEL_KEYS = {
  completed: "history.outcome.completed",
  skipped: "history.outcome.skipped",
  ended: "history.outcome.ended"
} as const;

/**
 * The local session history.
 *
 * Interrupted sessions stay out of the confirmed totals until the user
 * confirms them, which is why every interrupted record carries its own
 * confirmation control.
 */
export class HistoryView {
  readonly element: HTMLElement;

  private readonly doc: Document;

  private readonly options: HistoryViewOptions;

  private readonly summary: HTMLElement;

  private readonly list: HTMLElement;

  private readonly empty: HTMLElement;

  private records: HistoryRecord[] = [];

  constructor(doc: Document, options: HistoryViewOptions) {
    this.doc = doc;
    this.options = options;

    this.summary = el("p", { class: "history__summary" });
    this.list = el("ul", { class: "history__list" });
    this.empty = el("p", { class: "history__empty", text: t("history.empty") });

    const exportCsv = el(
      "button",
      {
        class: "button button--small",
        attrs: { type: "button", "data-action": "export-csv" },
        on: { click: () => void this.options.onExport("csv") }
      },
      [createIcon("download", 16), el("span", { text: t("action.export_csv") })]
    );

    const exportJson = el(
      "button",
      {
        class: "button button--small",
        attrs: { type: "button", "data-action": "export-json" },
        on: { click: () => void this.options.onExport("json") }
      },
      [createIcon("download", 16), el("span", { text: t("action.export_json") })]
    );

    const deleteAll = el(
      "button",
      {
        class: "button button--small button--danger",
        attrs: { type: "button", "data-action": "delete-all" },
        on: { click: () => void this.options.onDeleteAll() }
      },
      [createIcon("trash", 16), el("span", { text: t("action.delete_all") })]
    );

    this.element = el("section", { class: "panel history__panel" }, [
      el("div", { class: "panel__header" }, [
        el("div", { class: "history__actions" }, [exportCsv, exportJson, deleteAll])
      ]),
      this.summary,
      this.empty,
      this.list,
      el("p", { class: "history__note", text: t("history.confirm_note") })
    ]);

    this.update([]);
  }

  /** Replace the shown records. */
  update(records: HistoryRecord[]): void {
    this.records = records;
    const active = this.doc.activeElement;
    const focusedItem =
      active instanceof HTMLElement ? active.closest<HTMLElement>("[data-phase-id]") : null;
    const focusedId = focusedItem?.dataset["phaseId"] ?? null;
    const focusedAction =
      active instanceof HTMLElement ? active.getAttribute("data-action") : null;

    const totals = confirmedFocusTotals(records);
    if (records.length === 0) {
      setText(this.summary, "");
      setHidden(this.summary, true);
    } else {
      setText(
        this.summary,
        t("history.summary", {
          duration: formatDurationTotal(totals.totalMs),
          count: totals.sessions
        })
      );
      setHidden(this.summary, false);
    }
    setText(this.empty, t("history.empty"));
    setHidden(this.empty, records.length !== 0);

    this.list.textContent = "";
    for (const record of records) {
      this.list.appendChild(this.renderRecord(record));
    }
    updateScrollableFocus(this.list);

    if (focusedId) {
      const restored = this.list.querySelector<HTMLElement>(
        `[data-phase-id="${focusedId}"]${focusedAction ? ` [data-action="${focusedAction}"]` : ""}`
      );
      restored?.focus();
    }
  }

  /** The records currently shown. */
  get currentRecords(): HistoryRecord[] {
    return this.records;
  }

  private renderRecord(record: HistoryRecord): HTMLElement {
    const phaseKey = PHASE_LABEL_KEYS[record.phase as Phase] ?? "history.item.focus";
    const outcomeKey = OUTCOME_LABEL_KEYS[record.outcome] ?? "history.outcome.ended";
    const needsConfirmation = record.interrupted && !record.confirmed;

    const title = el("p", { class: "history-item__title" }, [
      el("span", { class: "history-item__phase", text: t(phaseKey) }),
      el("span", { class: "history-item__duration", text: formatDurationLong(record.durationMs) })
    ]);

    const meta = el("p", {
      class: "history-item__meta",
      text: `${formatTimestamp(record.startedAt)} · ${formatLocalDate(record.localDate)} · ${t(outcomeKey)}`
    });

    const parts: Array<Node> = [title, meta];
    if (record.label.trim().length > 0) {
      parts.push(el("p", { class: "history-item__label", text: record.label }));
    }

    const statusText = needsConfirmation
      ? t("history.interrupted")
      : record.confirmed
        ? t("history.confirmed")
        : "";
    const status = el("p", { class: "history-item__status" });
    if (statusText) {
      setText(status, statusText);
      status.setAttribute("data-state", needsConfirmation ? "interrupted" : "confirmed");
      setHidden(status, false);
    } else {
      setHidden(status, true);
    }
    parts.push(status);

    const item = el("li", { class: "history-item", data: { phaseId: record.phaseId } }, [
      el("div", { class: "history-item__main" }, parts)
    ]);

    if (needsConfirmation) {
      const confirmButton = el(
        "button",
        {
          class: "button button--small",
          attrs: { type: "button", "data-action": "confirm-record" },
          text: t("history.confirm_action"),
          on: { click: () => void this.options.onConfirm(record.phaseId) }
        }
      );
      item.appendChild(el("div", { class: "history-item__actions" }, [confirmButton]));
    }

    return item;
  }
}
