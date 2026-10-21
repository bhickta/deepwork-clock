import { el, setHidden, setText } from "./dom";
import { createIcon, setIcon } from "./icons";
import { confirmDialog, Modal } from "./dialogs";
import { Menu } from "./menu";
import { HistoryView } from "./history-view";
import { SettingsView } from "./settings-view";
import { TimerView } from "./timer-view";
import { formatDurationLong, interpolateRemaining } from "./format";
import { applyTextScale, applyTheme, watchSystemTheme } from "./theme";
import { describeShortcut, installShortcuts, isMacPlatform, SHORTCUTS } from "./shortcuts";
import { t } from "./i18n";
import { newRequestId, toAppError, type Bridge } from "./bridge";
import type {
  Action,
  AppError,
  Capabilities,
  ExportFormat,
  HistoryRecord,
  RecoveryCheckpoint,
  Settings,
  Snapshot,
  Theme,
  TimerConfig
} from "./contract";
import { APP_NAME, APP_REPOSITORY, APP_VERSION } from "./version";

export interface AppOptions {
  root: HTMLElement;
  bridge: Bridge;
  now?: () => number;
  document?: Document;
}

interface Preset {
  id: string;
  label: string;
  focusMs: number;
  shortBreakMs: number;
}

const PRESETS: readonly Preset[] = [
  { id: "25/5", label: "25 / 5", focusMs: 25 * 60_000, shortBreakMs: 5 * 60_000 },
  { id: "50/10", label: "50 / 10", focusMs: 50 * 60_000, shortBreakMs: 10 * 60_000 },
  { id: "90/20", label: "90 / 20", focusMs: 90 * 60_000, shortBreakMs: 20 * 60_000 }
];

const PHASE_LABEL_KEYS = {
  focus: "phase.focus",
  short_break: "phase.short_break",
  long_break: "phase.long_break"
} as const;

/**
 * The application controller.
 *
 * The backend owns the timer. This class renders snapshots, asks for
 * commands and keeps the interface in sync without rebuilding controls that
 * the user is using.
 */
export class App {
  private readonly root: HTMLElement;

  private readonly bridge: Bridge;

  private readonly doc: Document;

  private readonly now: () => number;

  private snapshot: Snapshot | null = null;

  private settings: Settings | null = null;

  private capabilities: Capabilities = {};

  private history: HistoryRecord[] = [];

  private timerView!: TimerView;

  private settingsView!: SettingsView;

  private historyView!: HistoryView;

  private helpModal!: Modal;

  private aboutModal!: Modal;

  private historyModal!: Modal;

  private warningsModal!: Modal;

  private menu!: Menu;

  private liveRegion!: HTMLElement;

  private errorRegion!: HTMLElement;

  private noticeRegion!: HTMLElement;

  private warningsRegion!: HTMLElement;

  private warningList!: HTMLElement;

  private warningModalList!: HTMLElement;

  private warningButton!: HTMLButtonElement;

  private warningButtonCount!: HTMLElement;

  private warningButtonLabel!: HTMLElement;

  private readonly warnings = new Map<string, AppError>();

  private recovery: RecoveryCheckpoint | null = null;

  private fatalPanel!: HTMLElement;

  private compactButton!: HTMLButtonElement;

  private pinButton!: HTMLButtonElement;

  private viewMode: "normal" | "compact" = "normal";

  private pinned = false;

  private snapshotReceivedAt = 0;

  private announcementKey = "";

  private lastAnnouncement = "";

  private tickHandle: number | null = null;

  private unsubscribeSnapshot: (() => void) | null = null;

  private unsubscribeWarning: (() => void) | null = null;

  private stopThemeWatch: (() => void) | null = null;

  constructor(options: AppOptions) {
    this.root = options.root;
    this.bridge = options.bridge;
    this.doc = options.document ?? options.root.ownerDocument ?? document;
    this.now = options.now ?? (() => Date.now());
  }

  /** The latest snapshot received from the backend. */
  get currentSnapshot(): Snapshot | null {
    return this.snapshot;
  }

  /** The settings last read from the backend. */
  get currentSettings(): Settings | null {
    return this.settings;
  }

  /** The capability report last read from the backend. */
  get currentCapabilities(): Capabilities {
    return this.capabilities;
  }

  /** True while the preview banner is shown. */
  get isPreview(): boolean {
    return this.bridge.kind === "demo";
  }

  /** Load the interface and connect to the backend. */
  async start(): Promise<void> {
    this.buildDom();
    this.installShortcuts();
    try {
      // Subscribe before the first snapshot so no transition is missed.
      this.unsubscribeSnapshot = await this.bridge.subscribeSnapshot((snapshot) => {
        this.applySnapshot(snapshot);
      });
      // The same rule holds for warnings: subscribe first, then fetch the
      // warnings that are already known so that nothing is lost.
      this.unsubscribeWarning = await this.bridge.subscribeWarning((error) => {
        this.showWarning(error);
      });
      await this.loadWarnings();
      const [settings, capabilities] = await Promise.all([
        this.bridge.getSettings(),
        this.bridge.getCapabilities()
      ]);
      this.settings = settings;
      this.capabilities = capabilities;
      this.applyThemeSettings();
      this.applyCapabilities();
      const snapshot = await this.bridge.getSnapshot();
      this.applySnapshot(snapshot);
      await this.loadRecovery();
      await this.loadHistory();
      this.stopThemeWatch = watchSystemTheme(() => {
        if (this.settings?.theme === "system") {
          applyTheme("system", this.doc);
        }
      }, this.doc);
    } catch (error) {
      this.showFatal(error);
    }
  }

  /** Stop timers and listeners. */
  dispose(): void {
    if (this.tickHandle !== null) {
      this.doc.defaultView?.clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
    this.menu.closeMenu(false);
    this.unsubscribeSnapshot?.();
    this.unsubscribeSnapshot = null;
    this.unsubscribeWarning?.();
    this.unsubscribeWarning = null;
    this.stopThemeWatch?.();
    this.stopThemeWatch = null;
  }

  private buildDom(): void {
    this.root.textContent = "";
    this.root.classList.add("app-shell");
    this.root.setAttribute("data-view", this.viewMode);
    this.root.removeAttribute("hidden");

    if (this.bridge.kind === "demo") {
      this.root.appendChild(
        el("p", { class: "banner banner--preview", attrs: { role: "status" }, text: t("banner.demo") })
      );
    }

    this.errorRegion = el("p", {
      class: "app-message app-message--error",
      attrs: { role: "alert", id: "app-error" }
    });
    setHidden(this.errorRegion, true);

    this.noticeRegion = el("p", {
      class: "app-message app-message--notice",
      attrs: { role: "status", id: "app-notice" }
    });
    setHidden(this.noticeRegion, true);

    this.warningList = el("ul", { class: "warnings__list" });
    this.warningModalList = el("ul", { class: "warnings__list" });
    this.warningsRegion = el(
      "section",
      {
        class: "warnings",
        attrs: { role: "status", "aria-labelledby": "warnings-heading" }
      },
      [
        el("h2", { class: "warnings__title", id: "warnings-heading", text: t("warnings.title") }),
        el("p", { class: "warnings__lead", text: t("warnings.lead") }),
        this.warningList
      ]
    );
    setHidden(this.warningsRegion, true);

    this.warningButtonCount = el("span", { class: "header-warning__count" });
    this.warningButtonLabel = el("span", { class: "sr-only" });
    this.warningButton = el(
      "button",
      {
        class: "icon-button header-warning",
        attrs: { type: "button", "data-action": "warnings", title: t("warnings.show") },
        on: { click: () => this.openWarnings() }
      },
      [
        el("span", { class: "button__icon" }, [createIcon("warning", 18)]),
        this.warningButtonCount,
        this.warningButtonLabel
      ]
    );
    setHidden(this.warningButton, true);

    this.timerView = new TimerView({
      onPrimary: () => void this.handlePrimary(),
      onReset: () => void this.handleReset(),
      onSkip: () => void this.handleSkip(),
      onEnd: () => void this.handleEnd(),
      onAnnounce: () => this.announceRemaining(),
      onRecoveryAccept: () => void this.send({ type: "accept_recovery" }),
      onRecoveryDiscard: () => void this.discardRecovery()
    });

    this.historyView = new HistoryView(this.doc, {
      onExport: (format) => this.exportHistory(format),
      onDeleteAll: () => this.deleteHistory(),
      onConfirm: (phaseId) => this.confirmHistoryRecord(phaseId)
    });

    this.settingsView = new SettingsView(this.doc, {
      capabilities: this.capabilities,
      onSave: (draft) => this.saveSettingsDraft(draft),
      onCancel: () => this.applyThemeSettings(),
      onPreview: (theme, textScale) => this.previewTheme(theme, textScale),
      announce: (message) => this.announce(message)
    });

    this.helpModal = this.createHelpModal();
    this.aboutModal = this.createAboutModal();
    this.historyModal = new Modal(this.doc, { title: t("label.history"), size: "medium" });
    this.historyModal.body.appendChild(this.historyView.element);
    this.warningsModal = new Modal(this.doc, { title: t("warnings.title"), size: "small" });
    this.warningsModal.body.appendChild(
      el("div", { class: "warnings__status", attrs: { role: "status" } }, [
        el("p", { class: "modal__lead", text: t("warnings.lead") }),
        this.warningModalList
      ])
    );

    const header = this.createHeader();
    const main = this.createMain();
    const footer = el("footer", { class: "app-footer" }, [
      el("p", { class: "app-footer__hint", text: t("footer.tagline") })
    ]);

    this.liveRegion = el("div", {
      class: "sr-only",
      attrs: { role: "status", "aria-live": "polite", id: "live-region" }
    });

    this.root.appendChild(header);
    this.root.appendChild(main);
    this.root.appendChild(footer);
    this.root.appendChild(this.liveRegion);
  }

  private createHeader(): HTMLElement {
    const brand = el("div", { class: "app-header__brand" }, [
      el("span", { class: "brand-mark" }, [createIcon("clock", 22)]),
      el("h1", { class: "app-header__title", text: t("app.title") })
    ]);

    this.compactButton = el(
      "button",
      {
        class: "icon-button",
        attrs: { type: "button", title: t("window.compact"), "data-action": "compact" },
        on: { click: () => void this.toggleCompact() }
      },
      [
        el("span", { class: "button__icon" }, [createIcon("compact", 18)]),
        el("span", { class: "sr-only", text: t("window.compact") })
      ]
    );

    this.pinButton = el(
      "button",
      {
        class: "icon-button",
        attrs: { type: "button", title: t("action.pin"), "data-action": "pin", "aria-pressed": "false" },
        on: { click: () => void this.togglePin() }
      },
      [
        el("span", { class: "button__icon" }, [createIcon("pin", 18)]),
        el("span", { class: "sr-only", text: t("action.pin") })
      ]
    );

    const menuButton = el(
      "button",
      {
        class: "icon-button",
        attrs: { type: "button", title: t("action.menu"), "data-action": "menu" },
        on: {}
      },
      [
        el("span", { class: "button__icon" }, [createIcon("menu", 18)]),
        el("span", { class: "sr-only", text: t("action.menu") })
      ]
    );

    this.menu = new Menu({
      doc: this.doc,
      button: menuButton,
      label: t("action.menu"),
      items: [
        { id: "settings", label: t("action.settings"), onSelect: () => this.openSettings() },
        {
          id: "shortcuts",
          label: t("help.title"),
          hint: "F1",
          onSelect: () => this.openHelp()
        },
        { id: "history", label: t("label.history"), onSelect: () => this.openHistory() },
        { id: "about", label: t("action.about"), onSelect: () => this.openAbout() }
      ]
    });

    return el("header", { class: "app-header" }, [
      brand,
      el(
        "div",
        { class: "app-header__actions", attrs: { role: "group", "aria-label": t("label.application") } },
        [
          this.warningButton,
          this.compactButton,
          this.pinButton,
          el("div", { class: "menu-anchor" }, [menuButton])
        ]
      )
    ]);
  }

  private createMain(): HTMLElement {
    this.fatalPanel = el("section", { class: "panel panel--fatal" });
    setHidden(this.fatalPanel, true);

    const presetButtons = PRESETS.map((preset) =>
      el(
        "button",
        {
          class: "button button--chip",
          attrs: { type: "button", "data-preset": preset.id, title: t("presets.apply", { preset: preset.label }) },
          text: preset.label,
          on: { click: () => void this.applyPreset(preset) }
        }
      )
    );

    const presets = el("div", { class: "presets" }, [
      el(
        "div",
        { class: "presets__row", attrs: { role: "group", "aria-label": t("label.presets") } },
        presetButtons
      ),
      el("p", { class: "presets__note", text: t("presets.note") })
    ]);

    return el("main", { class: "app-main" }, [
      this.warningsRegion,
      this.errorRegion,
      this.noticeRegion,
      this.fatalPanel,
      this.timerView.element,
      presets
    ]);
  }

  private createHelpModal(): Modal {
    const modal = new Modal(this.doc, { title: t("help.title"), size: "medium" });
    const isMac = isMacPlatform(this.doc.defaultView?.navigator);
    const rows = SHORTCUTS.map((spec) =>
      el("tr", {}, [
        el("th", { attrs: { scope: "row" }, text: spec.label }),
        el("td", { class: "help__keys" }, [
          el("kbd", { text: describeShortcut(spec, isMac) })
        ])
      ])
    );
    const table = el("table", { class: "help__table" }, [
      el("caption", { class: "sr-only", text: t("help.title") }),
      el("thead", {}, [
        el("tr", {}, [
          el("th", { attrs: { scope: "col" }, text: t("help.column.action") }),
          el("th", { attrs: { scope: "col" }, text: t("help.column.keys") })
        ])
      ]),
      el("tbody", {}, rows)
    ]);
    modal.body.appendChild(el("p", { class: "modal__lead", text: t("help.intro") }));
    modal.body.appendChild(table);
    modal.body.appendChild(el("p", { class: "modal__note", text: t("help.note") }));
    return modal;
  }

  private createAboutModal(): Modal {
    const modal = new Modal(this.doc, { title: t("about.title"), size: "small" });
    modal.body.appendChild(el("p", { class: "modal__lead", text: t("about.body") }));
    modal.body.appendChild(el("p", { text: t("about.version", { version: APP_VERSION }) }));
    modal.body.appendChild(el("p", { text: t("about.privacy") }));
    modal.body.appendChild(el("p", { text: t("about.license") }));
    modal.body.appendChild(el("p", { text: t("about.source", { repository: APP_REPOSITORY }) }));
    modal.body.appendChild(
      el("p", {
        class: "modal__note",
        text: this.bridge.kind === "demo" ? t("about.mode.demo") : t("about.mode.native")
      })
    );
    modal.body.appendChild(
      el("p", { class: "modal__note", text: `${APP_NAME} — ${t("about.version", { version: APP_VERSION })}` })
    );
    return modal;
  }

  private installShortcuts(): void {
    const isMac = isMacPlatform(this.doc.defaultView?.navigator);
    installShortcuts(
      this.root,
      {
        "toggle-timer": () => void this.handlePrimary(),
        reset: () => void this.handleReset(),
        next: () => void this.handleSkip(),
        compact: () => void this.toggleCompact(),
        pin: () => void this.togglePin(),
        settings: () => this.openSettings(),
        help: () => this.openHelp(),
        announce: () => this.announceRemaining()
      },
      isMac
    );
  }

  private applySnapshot(snapshot: Snapshot): void {
    const current = this.snapshot;
    if (current && snapshot.revision < current.revision) {
      // An older revision never replaces a newer one.
      return;
    }
    this.snapshot = snapshot;
    this.snapshotReceivedAt = this.now();
    this.renderTimer();
    this.announceTransition(snapshot);
    if (snapshot.status === "recovery_pending" && !this.recovery) {
      void this.loadRecovery();
    }
  }

  /** Fetch the checkpoint of an interrupted session. */
  private async loadRecovery(): Promise<void> {
    try {
      this.recovery = await this.bridge.getRecovery();
    } catch {
      this.recovery = null;
    }
    this.renderTimer();
  }

  private renderTimer(): void {
    const snapshot = this.snapshot;
    if (!snapshot) {
      return;
    }
    const remaining = interpolateRemaining(snapshot, this.snapshotReceivedAt, this.now());
    this.timerView.update(snapshot, remaining, this.recovery);
    this.updateTickLoop(snapshot.status === "running");
  }

  private updateTickLoop(running: boolean): void {
    const view = this.doc.defaultView;
    if (!view) {
      return;
    }
    if (running && this.tickHandle === null) {
      this.tickHandle = view.setInterval(() => this.tick(), 250);
    } else if (!running && this.tickHandle !== null) {
      view.clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
  }

  private tick(): void {
    const snapshot = this.snapshot;
    if (!snapshot) {
      return;
    }
    const remaining = interpolateRemaining(snapshot, this.snapshotReceivedAt, this.now());
    this.timerView.setRemaining(remaining);
  }

  private announceTransition(snapshot: Snapshot): void {
    const key = `${snapshot.status}|${snapshot.phase}|${snapshot.completedFocusCount}`;
    if (key === this.announcementKey) {
      return;
    }
    this.announcementKey = key;
    const phase = t(PHASE_LABEL_KEYS[snapshot.phase]);
    const duration = formatDurationLong(snapshot.durationMs);
    switch (snapshot.status) {
      case "running":
        this.announce(t("announce.started", { phase }));
        break;
      case "paused":
        this.announce(t("announce.paused", { duration: formatDurationLong(snapshot.remainingMs) }));
        break;
      case "completed":
        this.announce(t("announce.completed", { phase }));
        break;
      case "recovery_pending":
        this.announce(t("announce.recovery"));
        break;
      default:
        this.announce(t("announce.idle", { phase, duration }));
        break;
    }
  }

  private announce(message: string): void {
    if (!this.liveRegion) {
      return;
    }
    let text = message;
    if (text === this.lastAnnouncement) {
      text = `${message}\u200B`;
    }
    this.lastAnnouncement = message;
    setText(this.liveRegion, text);
  }

  private announceRemaining(): void {
    const snapshot = this.snapshot;
    if (!snapshot) {
      return;
    }
    const remaining = interpolateRemaining(snapshot, this.snapshotReceivedAt, this.now());
    this.announce(
      t("announce.remaining", {
        phase: t(PHASE_LABEL_KEYS[snapshot.phase]),
        duration: formatDurationLong(remaining)
      })
    );
  }

  private showError(message: string): void {
    setText(this.errorRegion, message);
    setHidden(this.errorRegion, false);
    setHidden(this.noticeRegion, true);
  }

  private showNotice(message: string): void {
    setText(this.noticeRegion, message);
    setHidden(this.noticeRegion, false);
  }

  private clearError(): void {
    setHidden(this.errorRegion, true);
  }

  /**
   * Show a warning that the backend reported.
   *
   * The warning stays until it is dismissed or the problem is gone, and it
   * never blocks the timer. The message is shown exactly as the backend wrote
   * it: the frontend never adds the session label to a message and never logs
   * anything.
   */
  private showWarning(error: AppError): void {
    const key = `${error.code}:${error.message}`;
    if (!this.warnings.has(key)) {
      this.warnings.set(key, { code: error.code, message: error.message });
      this.renderWarnings();
    }
    setHidden(this.warningsRegion, this.warnings.size === 0);
    if (error.snapshot) {
      this.applySnapshot(error.snapshot);
    }
  }

  private dismissWarning(key: string): void {
    if (!this.warnings.delete(key)) {
      return;
    }
    this.renderWarnings();
    setHidden(this.warningsRegion, this.warnings.size === 0);
  }

  /**
   * Draw the warnings in the page and in the warning dialog.
   *
   * The compact view hides the inline list to save room, so the header
   * carries a small indicator that opens the same list in a dialog. A disk
   * failure is never hidden without a way to read it.
   */
  private renderWarnings(): void {
    for (const container of [this.warningList, this.warningModalList]) {
      container.textContent = "";
      for (const [key, warning] of this.warnings) {
        container.appendChild(
          el("li", { class: "warning", data: { key } }, [
            el("p", { class: "warning__text", text: warning.message }),
            el("button", {
              class: "warning__dismiss",
              attrs: { type: "button" },
              text: t("action.dismiss_warning"),
              on: { click: () => this.dismissWarning(key) }
            })
          ])
        );
      }
    }

    const count = this.warnings.size;
    setHidden(this.warningButton, count === 0);
    setText(this.warningButtonCount, count > 0 ? String(count) : "");
    const label =
      count === 1
        ? t("warnings.count_one", { count })
        : t("warnings.count", { count });
    setText(this.warningButtonLabel, label);
    this.warningButton.setAttribute("aria-label", label);
    this.warningButton.title = label;
  }

  /** Fetch the warnings that are already known at startup. */
  private async loadWarnings(): Promise<void> {
    try {
      const warnings = await this.bridge.getWarnings();
      for (const warning of warnings) {
        this.showWarning(warning);
      }
    } catch (error) {
      this.showWarning({
        code: "INTERNAL",
        message: t("error.warnings_failed", { message: toAppError(error).message })
      });
    }
  }

  private showFatal(error: unknown): void {
    const message = toAppError(error).message;
    this.showError(t("error.connection", { message }));
    this.fatalPanel.textContent = "";
    this.fatalPanel.appendChild(
      el("h2", { class: "panel__title", text: t("error.connection_title") })
    );
    this.fatalPanel.appendChild(el("p", { text: message }));
    this.fatalPanel.appendChild(
      el("button", {
        class: "button button--primary",
        attrs: { type: "button" },
        text: t("action.retry"),
        on: { click: () => void this.start() }
      })
    );
    setHidden(this.fatalPanel, false);
    setHidden(this.timerView.element, true);
  }

  private async send(action: Action): Promise<Snapshot | null> {
    const snapshot = this.snapshot;
    if (!snapshot) {
      return null;
    }
    try {
      const next = await this.bridge.timerCommand({
        requestId: newRequestId(),
        expectedRevision: snapshot.revision,
        action
      });
      this.applySnapshot(next);
      this.clearError();
      return next;
    } catch (error) {
      const failure = toAppError(error);
      this.showError(t("error.command_failed", { message: failure.message }));
      this.announce(failure.message);
      if (failure.snapshot) {
        this.applySnapshot(failure.snapshot);
      } else if (failure.code === "STALE_REVISION") {
        await this.refreshSnapshot();
      }
      return null;
    }
  }

  private async refreshSnapshot(): Promise<void> {
    try {
      const snapshot = await this.bridge.getSnapshot();
      this.applySnapshot(snapshot);
    } catch {
      // Keep the current view; the next published snapshot restores the truth.
    }
  }

  private async handlePrimary(): Promise<void> {
    const snapshot = this.snapshot;
    if (!snapshot) {
      return;
    }
    switch (snapshot.status) {
      case "idle":
        await this.send({ type: "start" });
        break;
      case "running":
        await this.send({ type: "pause" });
        break;
      case "paused":
        await this.send({ type: "resume" });
        break;
      case "completed":
        await this.beginNextPhase();
        break;
      default:
        break;
    }
  }

  private async beginNextPhase(): Promise<void> {
    const snapshot = this.snapshot;
    if (!snapshot) {
      return;
    }
    const prepare: Action = snapshot.mode === "cycle" ? { type: "advance" } : { type: "reset" };
    const next = await this.send(prepare);
    if (!next) {
      return;
    }
    await this.send({ type: "start" });
  }

  private async handleReset(): Promise<void> {
    const snapshot = this.snapshot;
    if (!snapshot) {
      return;
    }
    if (snapshot.status === "running" || snapshot.status === "paused") {
      const confirmed = await confirmDialog(this.doc, {
        title: t("dialog.reset_title"),
        description: t("dialog.reset_body"),
        confirmLabel: t("action.reset"),
        cancelLabel: t("action.cancel"),
        tone: "danger",
        initialFocus: "cancel"
      });
      if (!confirmed) {
        return;
      }
    }
    await this.send({ type: "reset" });
  }

  private async handleSkip(): Promise<void> {
    const snapshot = this.snapshot;
    if (!snapshot || snapshot.mode !== "cycle") {
      return;
    }
    if (snapshot.status === "running" || snapshot.status === "paused") {
      const confirmed = await confirmDialog(this.doc, {
        title: t("dialog.skip_title"),
        description: t("dialog.skip_body"),
        confirmLabel: t("action.skip"),
        cancelLabel: t("action.cancel"),
        tone: "danger",
        initialFocus: "cancel"
      });
      if (!confirmed) {
        return;
      }
    }
    await this.send({ type: "skip" });
  }

  private async handleEnd(): Promise<void> {
    const snapshot = this.snapshot;
    if (!snapshot) {
      return;
    }
    if (snapshot.status !== "running" && snapshot.status !== "paused") {
      return;
    }
    const confirmed = await confirmDialog(this.doc, {
      title: t("dialog.end_title"),
      description: t("dialog.end_body"),
      confirmLabel: t("action.end"),
      cancelLabel: t("action.cancel"),
      tone: "danger",
      initialFocus: "cancel"
    });
    if (!confirmed) {
      return;
    }
    await this.send({ type: "end" });
  }

  private async discardRecovery(): Promise<void> {
    const confirmed = await confirmDialog(this.doc, {
      title: t("error.recovery_discard_title"),
      description: t("error.recovery_discard_body"),
      confirmLabel: t("action.discard"),
      cancelLabel: t("action.cancel"),
      tone: "danger",
      initialFocus: "cancel"
    });
    if (!confirmed) {
      return;
    }
    await this.send({ type: "discard_recovery" });
  }

  private async applyPreset(preset: Preset): Promise<void> {
    const snapshot = this.snapshot;
    const settings = this.settings;
    if (!snapshot || !settings) {
      return;
    }
    const config: TimerConfig = {
      ...settings.config,
      mode: "cycle",
      focusMs: preset.focusMs,
      shortBreakMs: preset.shortBreakMs
    };
    const active = snapshot.status === "running" || snapshot.status === "paused";
    if (active) {
      const confirmed = await confirmDialog(this.doc, {
        title: t("presets.dialog_title", { preset: preset.label }),
        description: t("presets.dialog_body"),
        confirmLabel: t("presets.dialog_confirm"),
        cancelLabel: t("action.cancel"),
        initialFocus: "cancel"
      });
      if (!confirmed) {
        return;
      }
    }

    const message = await this.persistSettings({ ...settings, config });
    if (message) {
      this.showError(t("error.save_failed", { message }));
      return;
    }
    if (active) {
      this.showNotice(t("presets.dialog_body"));
      return;
    }
    await this.send({ type: "configure", config });
  }

  private async saveSettingsDraft(draft: Settings): Promise<string | null> {
    const message = await this.persistSettings(draft);
    if (message) {
      return message;
    }
    const snapshot = this.snapshot;
    if (snapshot && (snapshot.status === "idle" || snapshot.status === "completed")) {
      await this.send({ type: "configure", config: draft.config });
    }
    return null;
  }

  private async persistSettings(draft: Settings): Promise<string | null> {
    const expectedSettingsRevision = this.settings?.revision ?? 0;
    try {
      const saved = await this.bridge.saveSettings({ expectedSettingsRevision, settings: draft });
      this.settings = saved;
      this.applyThemeSettings();
      this.applyCapabilities();
      return null;
    } catch (error) {
      return toAppError(error).message;
    }
  }

  private applyThemeSettings(): void {
    const settings = this.settings;
    if (!settings) {
      return;
    }
    applyTheme(settings.theme, this.doc);
    applyTextScale(settings.textScale, this.doc);
  }

  private previewTheme(theme: Theme, textScale: number): void {
    applyTheme(theme, this.doc);
    applyTextScale(textScale, this.doc);
  }

  private applyCapabilities(): void {
    const pin = this.capabilities["pin"];
    const state = pin?.state ?? "unknown";
    this.pinButton.setAttribute("aria-pressed", this.pinned ? "true" : "false");
    if (state === "unavailable" || state === "permission_required") {
      // The request would be refused, so it is not sent at all.
      this.pinButton.setAttribute("aria-disabled", "true");
      const reason = pin ? pin.reason : "";
      this.pinButton.title = `${t("settings.capability.unavailable")} ${reason}`.trim();
    } else {
      this.pinButton.removeAttribute("aria-disabled");
      this.pinButton.title =
        state === "unknown" ? t("pin.unknown_state") : t("settings.capability.available");
    }
    this.settingsView.updateCapabilities(this.capabilities);
  }

  private async toggleCompact(): Promise<void> {
    const next = this.viewMode === "normal" ? "compact" : "normal";
    try {
      await this.bridge.windowAction(next);
      this.viewMode = next;
      this.root.setAttribute("data-view", next);
      const icon = this.compactButton.querySelector<HTMLElement>(".button__icon");
      if (icon) {
        setIcon(icon, next === "compact" ? "expand" : "compact", 18);
      }
      this.compactButton.title = next === "compact" ? t("window.normal") : t("window.compact");
      const label = this.compactButton.querySelector(".sr-only");
      if (label) {
        setText(label, this.compactButton.title);
      }
      this.announce(next === "compact" ? t("window.compact") : t("window.normal"));
    } catch (error) {
      this.showError(toAppError(error).message);
    }
  }

  private async togglePin(): Promise<void> {
    const pin = this.capabilities["pin"];
    const state = pin?.state ?? "unknown";
    if (state === "unavailable" || state === "permission_required") {
      const reason = pin?.reason ?? t("settings.capability.missing");
      const message = t("pin.unavailable", { reason });
      this.showNotice(message);
      this.announce(message);
      return;
    }
    try {
      await this.bridge.windowAction(this.pinned ? "unpin" : "pin");
      this.pinned = !this.pinned;
      this.pinButton.setAttribute("aria-pressed", this.pinned ? "true" : "false");
      if (state === "unknown") {
        // The request was sent, but the desktop owns the result: a
        // compositor may ignore it and the frontend cannot know.
        this.showNotice(t("pin.request_sent"));
      } else {
        this.showNotice(this.pinned ? t("pin.enabled") : t("pin.disabled"));
      }
    } catch (error) {
      this.showError(toAppError(error).message);
    }
  }

  private async loadHistory(): Promise<void> {
    if (this.settings && !this.settings.historyEnabled) {
      this.history = [];
      this.historyView.update([]);
      return;
    }
    try {
      this.history = await this.bridge.listHistory(50);
      this.historyView.update(this.history);
    } catch (error) {
      this.showError(t("error.history_failed", { message: toAppError(error).message }));
    }
  }

  private async exportHistory(format: ExportFormat): Promise<void> {
    try {
      const path = await this.bridge.exportHistory(format);
      if (path === null) {
        this.showNotice(t("error.export_cancelled"));
        return;
      }
      this.showNotice(t("error.export_saved", { path }));
    } catch (error) {
      this.showError(t("error.export_failed", { message: toAppError(error).message }));
    }
  }

  private async deleteHistory(): Promise<void> {
    const confirmed = await confirmDialog(this.doc, {
      title: t("dialog.delete_title"),
      description: t("dialog.delete_body"),
      confirmLabel: t("action.delete_all"),
      cancelLabel: t("action.cancel"),
      tone: "danger",
      initialFocus: "cancel"
    });
    if (!confirmed) {
      return;
    }
    try {
      await this.bridge.deleteHistory();
      this.showNotice(t("error.history_deleted"));
      await this.loadHistory();
    } catch (error) {
      this.showError(t("error.delete_failed", { message: toAppError(error).message }));
    }
  }

  private async confirmHistoryRecord(phaseId: string): Promise<void> {
    try {
      await this.bridge.confirmHistory(phaseId);
      await this.loadHistory();
    } catch (error) {
      this.showError(t("error.confirm_failed", { message: toAppError(error).message }));
    }
  }

  private openSettings(): void {
    if (!this.settings) {
      return;
    }
    this.settingsView.open(this.settings);
  }

  private openHistory(): void {
    this.historyModal.openDialog();
  }

  private openWarnings(): void {
    this.warningsModal.openDialog();
  }

  private openHelp(): void {
    this.helpModal.openDialog();
  }

  private openAbout(): void {
    this.aboutModal.openDialog();
  }
}
