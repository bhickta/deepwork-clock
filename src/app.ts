import { el, setHidden, setText } from "./dom";
import { createIcon, setIcon } from "./icons";
import { confirmDialog, Modal } from "./dialogs";
import { Menu } from "./menu";
import { HistoryView } from "./history-view";
import { SettingsView } from "./settings-view";
import { TimerView } from "./timer-view";
import { formatDurationLong, interpolateRemaining } from "./format";
import { applyTextScale, applyTheme, watchSystemTheme } from "./theme";
import {
  describeShortcut,
  effectiveShortcut,
  installShortcuts,
  isMacPlatform,
  shortcutLabel,
  SHORTCUTS
} from "./shortcuts";
import { t } from "./i18n";
import { playCompletionChime } from "./sound";
import { SessionName } from "./session-name";
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
  SyncSummary,
  Theme,
  TimerConfig
} from "./contract";
import { APP_NAME, APP_REPOSITORY, APP_VERSION } from "./version";

export interface AppOptions {
  root: HTMLElement;
  bridge: Bridge;
  now?: () => number;
  document?: Document;
  /** Play one completion chime at the given volume (0 to 100). */
  playSound?: (volumePercent: number) => void;
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

  private readonly playSound: (volumePercent: number) => void;

  private sessionName!: SessionName;

  /** In-flight name save, awaited before a phase starts. */
  private pendingNameSave: Promise<void> | null = null;

  /** The last phase that already made a sound, so a duplicate is silent. */
  private chimedPhaseId: string | null = null;

  private snapshot: Snapshot | null = null;

  private settings: Settings | null = null;

  private capabilities: Capabilities = {};

  private history: HistoryRecord[] = [];

  private timerView!: TimerView;

  private settingsView!: SettingsView;

  private historyView!: HistoryView;

  private helpModal!: Modal;

  private aboutModal!: Modal;

  private diagnosticsPre!: HTMLElement;

  private diagnosticsStatus!: HTMLElement;

  private diagnosticsShowButton!: HTMLButtonElement;

  private diagnosticsCopyButton!: HTMLButtonElement;

  private diagnosticsJson: string | null = null;

  private diagnosticsPending: Promise<string | null> | null = null;

  private diagnosticsToken = 0;

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

  private floatButton!: HTMLButtonElement;

  private pinButton!: HTMLButtonElement;

  /** The `<kbd>` of each help row, so a remapped shortcut updates it. */
  private readonly helpKeys = new Map<string, HTMLElement>();

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
    this.playSound =
      options.playSound ??
      ((volumePercent: number) => {
        playCompletionChime(volumePercent, { document: this.doc });
      });
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
      this.updateHelpShortcuts();
      this.applyCapabilities();
      this.pinned = settings.floating;
      this.applyViewMode(settings.viewMode);
      this.sessionName.setValue(settings.config.label);
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

    this.sessionName = new SessionName({
      doc: this.doc,
      onCommit: (name) => {
        this.pendingNameSave = this.saveSessionName(name);
      }
    });

    this.settingsView = new SettingsView(this.doc, {
      capabilities: this.capabilities,
      onSave: (draft) => this.saveSettingsDraft(draft),
      onCancel: () => this.applyThemeSettings(),
      onPreview: (theme, textScale) => this.previewTheme(theme, textScale),
      onPreviewSound: (volumePercent) => this.previewCompletionSound(volumePercent),
      onChooseSyncDirectory: () => this.bridge.chooseSyncDirectory(),
      onSyncSessions: () => this.syncSessions(),
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

    this.floatButton = el(
      "button",
      {
        class: "icon-button",
        attrs: {
          type: "button",
          title: t("window.float"),
          "data-action": "float",
          "aria-pressed": "false"
        },
        on: { click: () => void this.toggleFloat() }
      },
      [
        el("span", { class: "button__icon" }, [createIcon("float", 18)]),
        el("span", { class: "sr-only", text: t("window.float") })
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
        {
          id: "restore-window",
          label: t("window.restore_position"),
          onSelect: () => void this.restoreWindowPosition()
        },
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
          this.floatButton,
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
      this.sessionName.element,
      this.timerView.element,
      presets
    ]);
  }

  private createHelpModal(): Modal {
    const modal = new Modal(this.doc, { title: t("help.title"), size: "medium" });
    const isMac = isMacPlatform(this.doc.defaultView?.navigator);
    const rows = SHORTCUTS.map((spec) => {
      const keys = el("kbd", { text: describeShortcut(spec, isMac) });
      this.helpKeys.set(spec.id, keys);
      return el("tr", { data: { shortcutId: spec.id } }, [
        el("th", { attrs: { scope: "row" }, text: shortcutLabel(spec) }),
        el("td", { class: "help__keys" }, [keys])
      ]);
    });
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
    const modal = new Modal(this.doc, {
      title: t("about.title"),
      size: "small",
      onClose: () => this.resetDiagnostics()
    });
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
    modal.body.appendChild(el("p", { class: "modal__note", text: t("about.sound") }));

    this.diagnosticsShowButton = el("button", {
      class: "button button--small",
      attrs: { type: "button", "data-action": "diagnostics-show" },
      text: t("about.diagnostics.show"),
      on: { click: () => void this.showDiagnostics() }
    });
    this.diagnosticsCopyButton = el("button", {
      class: "button button--small",
      attrs: { type: "button", "data-action": "diagnostics-copy" },
      text: t("about.diagnostics.copy"),
      on: { click: () => void this.copyDiagnostics() }
    });
    setHidden(this.diagnosticsCopyButton, true);
    this.diagnosticsStatus = el("p", { class: "field__note", attrs: { role: "status" } });
    setHidden(this.diagnosticsStatus, true);
    this.diagnosticsPre = el("pre", {
      class: "diagnostics-pre",
      attrs: {
        tabindex: "0",
        "aria-label": t("about.diagnostics"),
        spellcheck: "false"
      }
    });
    setHidden(this.diagnosticsPre, true);

    modal.body.appendChild(
      el(
        "section",
        { class: "about__section", attrs: { "aria-labelledby": "about-diagnostics-heading" } },
        [
          el("h3", {
            class: "about__section-title",
            id: "about-diagnostics-heading",
            text: t("about.diagnostics")
          }),
          el("p", { class: "modal__note", text: t("about.diagnostics.lead") }),
          el("div", { class: "about__actions" }, [
            this.diagnosticsShowButton,
            this.diagnosticsCopyButton
          ]),
          this.diagnosticsStatus,
          this.diagnosticsPre
        ]
      )
    );
    modal.body.appendChild(
      el("p", { class: "modal__note", text: `${APP_NAME} — ${t("about.version", { version: APP_VERSION })}` })
    );
    return modal;
  }

  /**
   * Ask the desktop for a fresh diagnostics document when the dialog opens.
   *
   * It stays hidden until the user asks to see it, so a long document never
   * fills the About dialog on its own.
   */
  private async loadDiagnostics(): Promise<string | null> {
    if (this.diagnosticsJson !== null) {
      return this.diagnosticsJson;
    }
    const pending = this.diagnosticsPending;
    if (pending) {
      return pending;
    }
    const token = this.diagnosticsToken;
    const request = this.fetchDiagnostics(token);
    this.diagnosticsPending = request;
    try {
      return await request;
    } finally {
      if (this.diagnosticsPending === request) {
        this.diagnosticsPending = null;
      }
    }
  }

  private async fetchDiagnostics(token: number): Promise<string | null> {
    try {
      const json = await this.bridge.getDiagnostics();
      if (token !== this.diagnosticsToken) {
        return null;
      }
      this.diagnosticsJson = json;
      return json;
    } catch (error) {
      if (token !== this.diagnosticsToken) {
        return null;
      }
      const message = toAppError(error).message;
      this.showError(t("error.diagnostics_failed", { message }));
      setText(this.diagnosticsStatus, t("about.diagnostics.failed"));
      setHidden(this.diagnosticsStatus, false);
      return null;
    }
  }

  /** Reveal the fetched document on request. */
  private async showDiagnostics(): Promise<void> {
    const json = await this.loadDiagnostics();
    if (json === null) {
      return;
    }
    setText(this.diagnosticsPre, json);
    setHidden(this.diagnosticsPre, false);
    setHidden(this.diagnosticsShowButton, true);
    setHidden(this.diagnosticsCopyButton, false);
    setHidden(this.diagnosticsStatus, true);
    // The button that had focus is gone, so focus moves to the text itself.
    this.diagnosticsPre.focus();
  }

  private async copyDiagnostics(): Promise<void> {
    const json = this.diagnosticsJson;
    if (json === null) {
      return;
    }
    try {
      const clipboard = this.doc.defaultView?.navigator.clipboard;
      if (!clipboard || typeof clipboard.writeText !== "function") {
        throw new Error("The clipboard is not available.");
      }
      await clipboard.writeText(json);
      this.showNotice(t("about.diagnostics.copied"));
      this.announce(t("about.diagnostics.copied"));
    } catch {
      // Select the text so the keyboard copy shortcut still works.
      this.selectDiagnostics();
      this.showNotice(t("about.diagnostics.copy_manual"));
      this.announce(t("about.diagnostics.copy_manual"));
    }
  }

  private selectDiagnostics(): void {
    const selection = this.doc.defaultView?.getSelection?.() ?? null;
    if (!selection) {
      return;
    }
    const range = this.doc.createRange();
    range.selectNodeContents(this.diagnosticsPre);
    selection.removeAllRanges();
    selection.addRange(range);
    this.diagnosticsPre.focus();
  }

  /** Forget the previous document so every opening fetches a fresh one. */
  private resetDiagnostics(): void {
    this.diagnosticsToken += 1;
    this.diagnosticsJson = null;
    this.diagnosticsPending = null;
    if (!this.diagnosticsPre) {
      return;
    }
    setText(this.diagnosticsPre, "");
    setHidden(this.diagnosticsPre, true);
    setHidden(this.diagnosticsShowButton, false);
    setHidden(this.diagnosticsCopyButton, true);
    setText(this.diagnosticsStatus, "");
    setHidden(this.diagnosticsStatus, true);
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
        float: () => void this.toggleFloat(),
        pin: () => void this.togglePin(),
        settings: () => this.openSettings(),
        help: () => this.openHelp(),
        announce: () => this.announceRemaining()
      },
      isMac,
      // Resolved on every keydown, so a saved remap applies immediately.
      () => this.settings?.localShortcuts ?? {}
    );
  }

  /** Show the bindings that are really in use, including local remaps. */
  private updateHelpShortcuts(): void {
    const isMac = isMacPlatform(this.doc.defaultView?.navigator);
    const overrides = this.settings?.localShortcuts ?? {};
    for (const spec of SHORTCUTS) {
      const keys = this.helpKeys.get(spec.id);
      if (keys) {
        setText(keys, describeShortcut(effectiveShortcut(spec, overrides), isMac));
      }
    }
  }

  private applySnapshot(snapshot: Snapshot): void {
    const current = this.snapshot;
    if (current && snapshot.revision < current.revision) {
      // An older revision never replaces a newer one.
      return;
    }
    this.maybePlayCompletionSound(current, snapshot);
    this.snapshot = snapshot;
    this.snapshotReceivedAt = this.now();
    this.renderTimer();
    this.announceTransition(snapshot);
    if (snapshot.status === "recovery_pending" && !this.recovery) {
      void this.loadRecovery();
    }
  }

  /**
   * Play one chime when a phase really completes.
   *
   * The initial render, a recovered session and a repeated snapshot for the
   * same phase stay silent. The sound is best effort and never touches the
   * timer: a failure here cannot undo or delay a completion.
   */
  private maybePlayCompletionSound(previous: Snapshot | null, next: Snapshot): void {
    if (!previous) {
      return;
    }
    const settings = this.settings;
    if (!settings || !settings.sound || settings.soundVolume <= 0) {
      return;
    }
    if (next.status !== "completed") {
      // Auto-advance publishes the next phase instead of a completed one. The
      // focus counter only grows when a focus phase really completed, so it is
      // the durable signal to use here. Skips do not change it.
      if (
        next.status === "idle" &&
        next.completedFocusCount > previous.completedFocusCount
      ) {
        const key = `auto-advance:${next.completedFocusCount}`;
        if (key !== this.chimedPhaseId) {
          this.chimedPhaseId = key;
          this.playCompletionSound(settings.soundVolume);
        }
      }
      return;
    }
    if (previous.status === "completed") {
      return;
    }
    const phaseId = next.phaseId;
    if (phaseId === null || phaseId === this.chimedPhaseId) {
      return;
    }
    this.chimedPhaseId = phaseId;
    this.playCompletionSound(settings.soundVolume);
  }

  /** Play the chime; an audio device failure is deliberately harmless. */
  private playCompletionSound(volumePercent: number): void {
    try {
      this.playSound(volumePercent);
    } catch {
      // A missing or busy audio device must never affect the timer.
    }
  }

  /** The explicit preview in the settings dialog ignores the on/off toggle. */
  private previewCompletionSound(volumePercent: number): void {
    this.playCompletionSound(volumePercent);
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
    if (this.pendingNameSave) {
      await this.pendingNameSave;
    }
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
      this.updateHelpShortcuts();
      this.applyCapabilities();
      this.sessionName.setValue(saved.config.label);
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
    const blocked = state === "unavailable" || state === "permission_required";
    if (blocked) {
      // The request would be refused, so it is not sent at all.
      this.pinButton.setAttribute("aria-disabled", "true");
      const reason = pin ? pin.reason : "";
      this.pinButton.title = `${t("settings.capability.unavailable")} ${reason}`.trim();
    } else {
      this.pinButton.removeAttribute("aria-disabled");
      this.pinButton.title =
        state === "unknown" ? t("pin.unknown_state") : t("settings.capability.available");
    }
    this.updateWindowControls();
    this.settingsView.updateCapabilities(this.capabilities);
  }

  /** The floating view is the compact window that also asked to stay on top. */
  private isFloating(): boolean {
    return this.viewMode === "compact" && this.pinned;
  }

  /**
   * Reflect the derived window state on the header controls.
   *
   * The floating button is pressed only while the window is both compact and
   * pinned, so it never claims a state the two underlying requests do not
   * describe.
   */
  private updateWindowControls(): void {
    const pin = this.capabilities["pin"];
    const state = pin?.state ?? "unknown";
    const blocked = state === "unavailable" || state === "permission_required";
    const floating = this.isFloating();
    this.pinButton.setAttribute("aria-pressed", this.pinned ? "true" : "false");
    this.floatButton.setAttribute("aria-pressed", floating ? "true" : "false");
    if (blocked) {
      const reason = pin?.reason ?? t("settings.capability.missing");
      const note = `${t("settings.capability.unavailable")} ${reason}`.trim();
      this.floatButton.setAttribute("aria-disabled", "true");
      this.floatButton.title = `${t("window.float")} — ${note}`;
    } else {
      this.floatButton.removeAttribute("aria-disabled");
      this.floatButton.title = floating ? t("window.unfloat") : t("window.float");
    }
    const floatLabel = this.floatButton.querySelector(".sr-only");
    if (floatLabel) {
      setText(floatLabel, floating ? t("window.unfloat") : t("window.float"));
    }
    const pinLabel = this.pinButton.querySelector(".sr-only");
    if (pinLabel) {
      setText(pinLabel, this.pinned ? t("action.unpin") : t("action.pin"));
    }
  }

  private updateCompactButton(): void {
    const compacted = this.viewMode === "compact";
    const icon = this.compactButton.querySelector<HTMLElement>(".button__icon");
    if (icon) {
      setIcon(icon, compacted ? "expand" : "compact", 18);
    }
    this.compactButton.title = compacted ? t("window.normal") : t("window.compact");
    const label = this.compactButton.querySelector(".sr-only");
    if (label) {
      setText(label, this.compactButton.title);
    }
  }

  /** Apply the layout that the backend restored, without a window request. */
  private applyViewMode(mode: "normal" | "compact"): void {
    this.viewMode = mode;
    this.root.setAttribute("data-view", mode);
    this.updateCompactButton();
    this.updateWindowControls();
  }

  /**
   * Remember the layout so a restored compact window never comes back with
   * the normal layout. Best effort: the window already changed.
   */
  private async rememberViewMode(): Promise<void> {
    const settings = this.settings;
    if (
      !settings ||
      (settings.viewMode === this.viewMode && settings.floating === this.isFloating())
    ) {
      return;
    }
    try {
      this.settings = await this.bridge.saveSettings({
        expectedSettingsRevision: settings.revision,
        settings: { ...settings, viewMode: this.viewMode, floating: this.isFloating() }
      });
    } catch {
      // Another save may have won the revision race. The layout stays as the
      // user left it; the next settings save records it again.
    }
  }

  private async toggleCompact(): Promise<void> {
    const next = this.viewMode === "normal" ? "compact" : "normal";
    try {
      await this.bridge.windowAction(next);
      this.applyViewMode(next);
      void this.rememberViewMode();
      this.announce(next === "compact" ? t("window.compact") : t("window.normal"));
    } catch (error) {
      this.showError(toAppError(error).message);
    }
  }

  private async toggleFloat(): Promise<void> {
    const pin = this.capabilities["pin"];
    const state = pin?.state ?? "unknown";
    if (state === "unavailable" || state === "permission_required") {
      const reason = pin?.reason ?? t("settings.capability.missing");
      const message = t("window.float.unavailable", { reason });
      this.showNotice(message);
      this.announce(message);
      return;
    }
    const floating = this.isFloating();
    try {
      // One request carries the whole change: the backend owns the window.
      await this.bridge.windowAction(floating ? "unfloat" : "float");
      this.pinned = !floating;
      this.applyViewMode(floating ? "normal" : "compact");
      void this.rememberViewMode();
      if (state === "unknown") {
        // The request was sent, but the desktop decides the result.
        this.showNotice(t("float.request_sent"));
      } else {
        this.showNotice(floating ? t("float.disabled") : t("float.enabled"));
      }
      this.announce(floating ? t("announce.float_off") : t("announce.float_on"));
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
      this.updateWindowControls();
      void this.rememberViewMode();
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

  /** Ask the backend to reset and centre the window. */
  private async restoreWindowPosition(): Promise<void> {
    try {
      await this.bridge.windowAction("restore");
      this.showNotice(t("window.restored"));
      this.announce(t("window.restored"));
    } catch (error) {
      this.showError(toAppError(error).message);
    }
  }

  /**
   * Store the optional session name. It is applied to the next phase; while
   * the timer is idle the engine is reconfigured immediately so the current
   * start uses it.
   */
  private async saveSessionName(name: string): Promise<void> {
    const settings = this.settings;
    if (!settings || settings.config.label === name) {
      return;
    }
    const config: TimerConfig = { ...settings.config, label: name };
    try {
      const saved = await this.bridge.saveSettings({
        expectedSettingsRevision: settings.revision,
        settings: { ...settings, config }
      });
      this.settings = saved;
      const snapshot = this.snapshot;
      if (snapshot && (snapshot.status === "idle" || snapshot.status === "completed")) {
        await this.send({ type: "configure", config: saved.config });
      }
      this.announce(
        name.length > 0
          ? t("session.name.saved", { name })
          : t("session.name.cleared")
      );
    } catch (error) {
      this.sessionName.setValue(settings.config.label);
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
      this.sessionName.setSuggestions(this.history.map((record) => record.label));
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

  /**
   * Run one Markdown sync pass.
   *
   * Imported sessions become part of the local history, so an open history view
   * is refreshed. A failure is thrown back to the settings dialog, which shows
   * it next to the folder field without touching the saved path.
   */
  private async syncSessions(): Promise<SyncSummary> {
    const summary = await this.bridge.syncSessions();
    if (summary.imported > 0) {
      await this.loadHistory();
    }
    return summary;
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
    this.resetDiagnostics();
    this.aboutModal.openDialog();
    // Fetch immediately so the document is ready when it is requested; the
    // text still stays hidden until the user presses Show diagnostics.
    void this.loadDiagnostics();
  }
}
