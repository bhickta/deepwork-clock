import { el, setHidden, setText } from "./dom";
import { confirmDialog, Modal } from "./dialogs";
import {
  countCharacters,
  durationParts,
  isValidLabel,
  MAX_LABEL_LENGTH,
  MAX_RETENTION_DAYS,
  parseDurationParts
} from "./format";
import type { Capabilities, Settings, Theme, TimerConfig } from "./contract";
import { MAX_LOCAL_SHORTCUT_LENGTH } from "./contract";
import {
  chordFromEvent,
  effectiveShortcut,
  formatShortcut,
  isMacPlatform,
  isModifierOnlyKey,
  normalizeLocalShortcuts,
  SHORTCUTS,
  validateShortcutChord,
  type ShortcutIssue,
  type ShortcutSpec
} from "./shortcuts";
import { t } from "./i18n";

export interface SettingsViewOptions {
  capabilities: Capabilities;
  /** Persist the draft. Returns an error message, or null on success. */
  onSave(draft: Settings): Promise<string | null>;
  onCancel(): void;
  /** Live preview while the dialog is open. */
  onPreview(theme: Theme, textScale: number): void;
  announce(message: string): void;
}

interface DurationControls {
  group: HTMLElement;
  hours: HTMLInputElement;
  minutes: HTMLInputElement;
  seconds: HTMLInputElement;
  error: HTMLElement;
}

interface ToggleControls {
  wrapper: HTMLElement;
  input: HTMLInputElement;
  note: HTMLElement;
}

interface ShortcutRow {
  spec: ShortcutSpec;
  wrapper: HTMLElement;
  input: HTMLInputElement;
  error: HTMLElement;
}

const CAPABILITY_CONTROL_NAMES = ["notifications", "sound", "globalShortcut", "autostart", "tray"] as const;

let settingsCounter = 0;

function fieldWrapper(id: string, labelText: string, control: HTMLElement, hint?: string): HTMLElement {
  const label = el("label", { class: "field__label", attrs: { for: id }, text: labelText });
  const hintElement = hint
    ? el("p", { class: "field__hint", id: `${id}-hint`, text: hint })
    : null;
  const describedBy = hintElement ? `${id}-hint` : null;
  if (describedBy) {
    control.setAttribute("aria-describedby", describedBy);
  }
  return el("div", { class: "field" }, [label, control, hintElement]);
}

function durationControls(
  id: string,
  labelText: string,
  onChange: () => void
): DurationControls {
  const hours = el("input", {
    class: "input input--number",
    attrs: { type: "number", min: "0", max: "24", step: "1", id: `${id}-hours`, inputmode: "numeric" }
  });
  const minutes = el("input", {
    class: "input input--number",
    attrs: { type: "number", min: "0", max: "59", step: "1", id: `${id}-minutes`, inputmode: "numeric" }
  });
  const seconds = el("input", {
    class: "input input--number",
    attrs: { type: "number", min: "0", max: "59", step: "1", id: `${id}-seconds`, inputmode: "numeric" }
  });
  const error = el("p", { class: "field__error", id: `${id}-error`, attrs: { role: "alert" } });
  setHidden(error, true);

  const parts = el("div", { class: "duration-parts" }, [
    el("div", { class: "duration-part" }, [
      el("label", { class: "duration-part__label", attrs: { for: `${id}-hours` }, text: t("settings.hours") }),
      hours
    ]),
    el("div", { class: "duration-part" }, [
      el("label", { class: "duration-part__label", attrs: { for: `${id}-minutes` }, text: t("settings.minutes") }),
      minutes
    ]),
    el("div", { class: "duration-part" }, [
      el("label", { class: "duration-part__label", attrs: { for: `${id}-seconds` }, text: t("settings.seconds") }),
      seconds
    ])
  ]);

  const group = el("fieldset", { class: "duration-group" }, [
    el("legend", { class: "duration-group__legend", text: labelText }),
    parts,
    error
  ]);

  for (const input of [hours, minutes, seconds]) {
    input.addEventListener("input", onChange);
  }

  return { group, hours, minutes, seconds, error };
}

function toggleControls(
  id: string,
  labelText: string,
  hint: string | undefined,
  onChange: () => void
): ToggleControls {
  const input = el("input", {
    class: "checkbox",
    attrs: { type: "checkbox", id }
  });
  const note = el("p", { class: "field__note", id: `${id}-note` });
  setHidden(note, true);
  const hintElement = hint ? el("p", { class: "field__hint", id: `${id}-hint`, text: hint }) : null;
  const describedBy = [hintElement ? `${id}-hint` : null, `${id}-note`].filter(Boolean).join(" ");
  input.setAttribute("aria-describedby", describedBy);

  const wrapper = el("div", { class: "field field--toggle" }, [
    el("div", { class: "toggle-row" }, [
      input,
      el("label", { class: "toggle-row__label", attrs: { for: id }, text: labelText })
    ]),
    hintElement,
    note
  ]);

  input.addEventListener("change", onChange);
  return { wrapper, input, note };
}

/**
 * The settings dialog.
 *
 * The draft lives in the form controls, so a snapshot that arrives while the
 * dialog is open never resets what the user typed.
 */
export class SettingsView {
  readonly element: HTMLElement;

  private readonly doc: Document;

  private readonly options: SettingsViewOptions;

  private readonly modal: Modal;

  private readonly form: HTMLFormElement;

  private readonly dirtyNote: HTMLElement;

  private readonly saveError: HTMLElement;

  private readonly modeInputs: HTMLInputElement[] = [];

  private readonly focus: DurationControls;

  private readonly shortBreak: DurationControls;

  private readonly longBreak: DurationControls;

  private readonly interval: HTMLInputElement;

  private readonly intervalError: HTMLElement;

  private readonly label: HTMLInputElement;

  private readonly labelError: HTMLElement;

  private readonly theme: HTMLSelectElement;

  private readonly textScale: HTMLInputElement;

  private readonly textScaleOutput: HTMLOutputElement;

  private readonly notifications: ToggleControls;

  private readonly sound: ToggleControls;

  private readonly globalShortcutEnabled: ToggleControls;

  private readonly globalShortcut: HTMLInputElement;

  private readonly globalShortcutError: HTMLElement;

  private readonly launchAtLogin: ToggleControls;

  private readonly closeToTray: ToggleControls;

  private readonly historyEnabled: ToggleControls;

  private readonly retentionDays: HTMLInputElement;

  private readonly retentionError: HTMLElement;

  private readonly toggles = new Map<string, ToggleControls>();

  private readonly shortcutRows = new Map<string, ShortcutRow>();

  private readonly isMac: boolean;

  private localShortcuts: Record<string, string> = {};

  private base: Settings | null = null;

  private dirty = false;

  private capabilities: Capabilities;

  constructor(doc: Document, options: SettingsViewOptions) {
    this.doc = doc;
    this.options = options;
    this.capabilities = options.capabilities;
    this.isMac = isMacPlatform(doc.defaultView?.navigator);

    const onChange = (): void => this.markDirty();

    this.focus = durationControls("focus", t("settings.focus"), onChange);
    this.shortBreak = durationControls("short-break", t("settings.short_break"), onChange);
    this.longBreak = durationControls("long-break", t("settings.long_break"), onChange);

    this.interval = el("input", {
      class: "input input--number",
      attrs: { type: "number", min: "1", max: "12", step: "1", id: "interval", inputmode: "numeric" }
    });
    this.intervalError = el("p", { class: "field__error", id: "interval-error", attrs: { role: "alert" } });
    setHidden(this.intervalError, true);
    this.interval.setAttribute("aria-describedby", "interval-error");
    this.interval.addEventListener("input", onChange);

    this.label = el("input", {
      class: "input",
      attrs: { type: "text", id: "label", maxlength: String(MAX_LABEL_LENGTH), autocomplete: "off" }
    });
    this.labelError = el("p", { class: "field__error", id: "label-error", attrs: { role: "alert" } });
    setHidden(this.labelError, true);
    this.label.setAttribute("aria-describedby", "label-error");
    this.label.addEventListener("input", onChange);

    this.theme = el("select", { class: "input", attrs: { id: "theme" } }, [
      el("option", { attrs: { value: "system" }, text: t("settings.theme.system") }),
      el("option", { attrs: { value: "light" }, text: t("settings.theme.light") }),
      el("option", { attrs: { value: "dark" }, text: t("settings.theme.dark") }),
      el("option", { attrs: { value: "high-contrast" }, text: t("settings.theme.high_contrast") })
    ]);
    this.theme.addEventListener("change", () => {
      this.markDirty();
      this.preview();
    });

    this.textScale = el("input", {
      class: "range",
      attrs: { type: "range", id: "text-scale", min: "1", max: "2", step: "0.05" }
    });
    this.textScaleOutput = el("output", {
      class: "range-output",
      attrs: { for: "text-scale", id: "text-scale-output" },
      text: "100%"
    });
    this.textScale.addEventListener("input", () => {
      this.markDirty();
      this.preview();
    });

    this.notifications = toggleControls(
      "notifications",
      t("settings.notifications"),
      undefined,
      onChange
    );
    this.sound = toggleControls("sound", t("settings.sound"), undefined, onChange);
    this.globalShortcutEnabled = toggleControls(
      "global-shortcut-enabled",
      t("settings.global_shortcut"),
      t("settings.global_shortcut.hint"),
      onChange
    );
    this.launchAtLogin = toggleControls(
      "launch-at-login",
      t("settings.launch_at_login"),
      undefined,
      onChange
    );
    this.closeToTray = toggleControls(
      "close-to-tray",
      t("settings.close_to_tray"),
      undefined,
      onChange
    );
    this.historyEnabled = toggleControls(
      "history-enabled",
      t("settings.history_enabled"),
      undefined,
      onChange
    );

    this.toggles.set("notifications", this.notifications);
    this.toggles.set("sound", this.sound);
    this.toggles.set("globalShortcut", this.globalShortcutEnabled);
    this.toggles.set("autostart", this.launchAtLogin);
    this.toggles.set("tray", this.closeToTray);

    this.globalShortcut = el("input", {
      class: "input",
      attrs: { type: "text", id: "global-shortcut", autocomplete: "off", spellcheck: "false" }
    });
    this.globalShortcutError = el("p", {
      class: "field__error",
      id: "global-shortcut-error",
      attrs: { role: "alert" }
    });
    setHidden(this.globalShortcutError, true);
    this.globalShortcut.setAttribute("aria-describedby", "global-shortcut-error");
    this.globalShortcut.addEventListener("input", onChange);

    this.retentionDays = el("input", {
      class: "input input--number",
      attrs: { type: "number", min: "1", max: String(MAX_RETENTION_DAYS), step: "1", id: "retention-days", inputmode: "numeric" }
    });
    this.retentionError = el("p", {
      class: "field__error",
      id: "retention-days-error",
      attrs: { role: "alert" }
    });
    setHidden(this.retentionError, true);
    this.retentionDays.setAttribute("aria-describedby", "retention-days-error");
    this.retentionDays.addEventListener("input", onChange);

    this.dirtyNote = el("p", { class: "settings__dirty", text: t("settings.dirty_note") });
    setHidden(this.dirtyNote, true);

    this.saveError = el("p", { class: "settings__error", attrs: { role: "alert" } });
    setHidden(this.saveError, true);

    const modeCountdown = el("input", {
      class: "radio",
      attrs: { type: "radio", name: "mode", id: "mode-countdown", value: "countdown" }
    });
    const modeCycle = el("input", {
      class: "radio",
      attrs: { type: "radio", name: "mode", id: "mode-cycle", value: "cycle" }
    });
    this.modeInputs.push(modeCountdown, modeCycle);
    modeCountdown.addEventListener("change", onChange);
    modeCycle.addEventListener("change", onChange);

    this.form = el(
      "form",
      { class: "settings-form", attrs: { novalidate: "", id: `settings-form-${++settingsCounter}` } },
      [
      el("fieldset", { class: "fieldset" }, [
        el("legend", { class: "fieldset__legend", text: t("settings.mode") }),
        el("div", { class: "radio-row" }, [
          el("div", { class: "radio-option" }, [
            modeCountdown,
            el("label", { attrs: { for: "mode-countdown" }, text: t("settings.mode.countdown") })
          ]),
          el("div", { class: "radio-option" }, [
            modeCycle,
            el("label", { attrs: { for: "mode-cycle" }, text: t("settings.mode.cycle") })
          ])
        ]),
        el("p", { class: "field__hint", text: t("settings.mode.hint") })
      ]),
      el("fieldset", { class: "fieldset" }, [
        el("legend", { class: "fieldset__legend", text: t("settings.durations") }),
        el("div", { class: "duration-grid" }, [
          this.focus.group,
          this.shortBreak.group,
          this.longBreak.group
        ]),
        fieldWrapper(
          "interval",
          t("settings.interval", { count: "N" }),
          this.interval,
          t("settings.interval_hint")
        ),
        this.intervalError
      ]),
      el("fieldset", { class: "fieldset" }, [
        el("legend", { class: "fieldset__legend", text: t("settings.label") }),
        fieldWrapper(
          "label",
          t("settings.label"),
          this.label,
          t("settings.label.hint", { max: MAX_LABEL_LENGTH })
        ),
        this.labelError
      ]),
      el("fieldset", { class: "fieldset" }, [
        el("legend", { class: "fieldset__legend", text: t("settings.appearance") }),
        fieldWrapper("theme", t("settings.theme"), this.theme),
        el("div", { class: "field" }, [
          el("label", { class: "field__label", attrs: { for: "text-scale" }, text: t("settings.text_scale") }),
          el("div", { class: "range-row" }, [this.textScale, this.textScaleOutput])
        ])
      ]),
      el("fieldset", { class: "fieldset" }, [
        el("legend", { class: "fieldset__legend", text: t("settings.sound") }),
        this.notifications.wrapper,
        this.sound.wrapper
      ]),
      el("fieldset", { class: "fieldset" }, [
        el("legend", { class: "fieldset__legend", text: t("settings.system") }),
        this.globalShortcutEnabled.wrapper,
        fieldWrapper("global-shortcut", t("settings.global_shortcut"), this.globalShortcut),
        this.globalShortcutError,
        this.launchAtLogin.wrapper,
        this.closeToTray.wrapper
      ]),
      el("fieldset", { class: "fieldset" }, [
        el("legend", { class: "fieldset__legend", text: t("settings.history_options") }),
        this.historyEnabled.wrapper,
        fieldWrapper("retention-days", t("settings.retention_days", { count: "N" }), this.retentionDays),
        this.retentionError
      ]),
      this.buildShortcutsSection(),
      el("p", { class: "settings__note", text: t("settings.next_session_note") }),
      this.dirtyNote,
      this.saveError
    ]);

    this.form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.submit();
    });

    const saveButton = el("button", {
      class: "button button--primary",
      attrs: { type: "submit", form: this.form.id },
      text: t("action.save")
    });

    const cancelButton = el("button", {
      class: "button",
      attrs: { type: "button" },
      text: t("action.cancel"),
      on: { click: () => void this.requestCancel() }
    });

    this.modal = new Modal(doc, {
      title: t("settings.title"),
      size: "large",
      onClose: () => {
        this.dirty = false;
        setHidden(this.dirtyNote, true);
      },
      confirmClose: async () => {
        if (!this.dirty) {
          return true;
        }
        return this.confirmDiscard();
      }
    });

    this.modal.body.appendChild(this.form);
    this.modal.footer.appendChild(cancelButton);
    this.modal.footer.appendChild(saveButton);
    this.element = this.modal.element;

    this.updateCapabilities(this.capabilities);
  }

  get isOpen(): boolean {
    return this.modal.isOpen;
  }

  /** True when the form holds changes that were not saved. */
  get isDirty(): boolean {
    return this.dirty;
  }

  /** Open the dialog with the given settings as the starting point. */
  open(base: Settings): void {
    this.base = base;
    if (!this.dirty) {
      this.populate(base);
    }
    setHidden(this.saveError, true);
    this.updateCapabilities(this.capabilities);
    this.modal.openDialog();
  }

  /** Close the dialog without saving, asking first when edits are pending. */
  async close(): Promise<void> {
    await this.modal.requestClose();
  }

  /** Refresh the capability notes, for example after the app learns more. */
  updateCapabilities(capabilities: Capabilities): void {
    this.capabilities = capabilities;
    for (const name of CAPABILITY_CONTROL_NAMES) {
      const controls = this.toggles.get(name);
      if (!controls) {
        continue;
      }
      const capability = capabilities[name];
      if (!capability) {
        controls.input.disabled = false;
        controls.input.removeAttribute("aria-disabled");
        setText(controls.note, t("settings.capability.missing"));
        setHidden(controls.note, false);
        continue;
      }
      if (capability.state === "available") {
        controls.input.disabled = false;
        controls.input.removeAttribute("aria-disabled");
        setText(controls.note, t("settings.capability.available"));
        setHidden(controls.note, false);
        continue;
      }
      const reason = capability.reason ? ` ${capability.reason}` : "";
      if (capability.state === "unknown") {
        // The support is not known, so the option stays usable and the
        // uncertainty is stated instead of being hidden.
        controls.input.disabled = false;
        controls.input.removeAttribute("aria-disabled");
        setText(controls.note, `${t("settings.capability.unknown")}${reason}`);
        setHidden(controls.note, false);
        continue;
      }
      controls.input.disabled = true;
      controls.input.setAttribute("aria-disabled", "true");
      if (capability.state === "unavailable") {
        setText(controls.note, `${t("settings.capability.unavailable")}${reason}`);
      } else {
        setText(controls.note, `${t("settings.capability.permission_required")}${reason}`);
      }
      setHidden(controls.note, false);
    }
  }

  private buildShortcutsSection(): HTMLElement {
    const rows = SHORTCUTS.map((spec) => this.createShortcutRow(spec));
    const resetAll = el("button", {
      class: "button",
      attrs: { type: "button", "data-action": "shortcuts-reset-all" },
      text: t("settings.shortcuts.reset_all"),
      on: { click: () => this.resetAllShortcuts() }
    });
    return el("fieldset", { class: "fieldset" }, [
      el("legend", { class: "fieldset__legend", text: t("settings.shortcuts") }),
      el("p", { class: "field__hint", text: t("settings.shortcuts.hint") }),
      el(
        "div",
        { class: "shortcuts-list" },
        rows.map((row) => row.wrapper)
      ),
      el("div", { class: "shortcuts-actions" }, [resetAll])
    ]);
  }

  private createShortcutRow(spec: ShortcutSpec): ShortcutRow {
    const inputId = `shortcut-${spec.id}`;
    const errorId = `${inputId}-error`;
    const input = el("input", {
      class: "input shortcut-row__input",
      attrs: {
        type: "text",
        id: inputId,
        readonly: true,
        autocomplete: "off",
        spellcheck: "false",
        maxlength: String(MAX_LOCAL_SHORTCUT_LENGTH),
        "aria-describedby": errorId
      }
    });
    const error = el("p", { class: "field__error", id: errorId, attrs: { role: "alert" } });
    setHidden(error, true);
    const label = el("label", {
      class: "shortcut-row__label",
      attrs: { for: inputId },
      text: spec.label
    });
    const reset = el("button", {
      class: "button shortcut-row__reset",
      attrs: { type: "button", "data-action": `shortcut-reset-${spec.id}` },
      text: t("settings.shortcuts.reset"),
      title: t("settings.shortcuts.reset_action", { action: spec.label }),
      on: { click: () => this.resetShortcut(spec) }
    });
    const wrapper = el("div", { class: "shortcut-row", data: { shortcutId: spec.id } }, [
      label,
      input,
      reset,
      error
    ]);
    input.addEventListener("keydown", (event) => this.onShortcutKeyDown(event, spec, input, error));
    // Selecting the current combination makes an accidental edit obvious.
    input.addEventListener("focus", () => input.select());
    const row: ShortcutRow = { spec, wrapper, input, error };
    this.shortcutRows.set(spec.id, row);
    return row;
  }

  /** The stored wording of the binding a row currently uses. */
  private displayShortcut(spec: ShortcutSpec): string {
    return formatShortcut(effectiveShortcut(spec, this.localShortcuts), this.isMac);
  }

  private onShortcutKeyDown(
    event: KeyboardEvent,
    spec: ShortcutSpec,
    input: HTMLInputElement,
    error: HTMLElement
  ): void {
    // Tab keeps moving the focus, also out of the field.
    if (event.key === "Tab") {
      return;
    }
    if (event.isComposing) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      input.value = this.displayShortcut(spec);
      this.clearShortcutError(input, error);
      return;
    }
    if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      event.stopPropagation();
      this.resetShortcut(spec);
      return;
    }
    if (isModifierOnlyKey(event.key)) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const chord = chordFromEvent(event, this.isMac);
    if (chord === null) {
      this.showShortcutError(input, error, t("error.shortcut_unsupported"));
      return;
    }
    const issue = validateShortcutChord(chord, spec.id, this.localShortcuts);
    if (issue !== null) {
      this.showShortcutError(input, error, shortcutIssueMessage(issue));
      return;
    }
    this.localShortcuts = { ...this.localShortcuts, [spec.id]: chord };
    input.value = chord;
    this.clearShortcutError(input, error);
    this.markDirty();
  }

  private showShortcutError(
    input: HTMLInputElement,
    error: HTMLElement,
    message: string
  ): void {
    setText(error, message);
    setHidden(error, false);
    input.setAttribute("aria-invalid", "true");
    this.options.announce(message);
  }

  private clearShortcutError(input: HTMLInputElement, error: HTMLElement): void {
    setText(error, "");
    setHidden(error, true);
    input.removeAttribute("aria-invalid");
  }

  /** Drop one override and show the default binding again. */
  private resetShortcut(spec: ShortcutSpec): void {
    const row = this.shortcutRows.get(spec.id);
    if (spec.id in this.localShortcuts) {
      const next = { ...this.localShortcuts };
      delete next[spec.id];
      this.localShortcuts = next;
      this.markDirty();
    }
    if (row) {
      row.input.value = this.displayShortcut(spec);
      this.clearShortcutError(row.input, row.error);
    }
  }

  private resetAllShortcuts(): void {
    this.localShortcuts = {};
    for (const row of this.shortcutRows.values()) {
      row.input.value = this.displayShortcut(row.spec);
      this.clearShortcutError(row.input, row.error);
    }
    this.markDirty();
  }

  /** Refresh the displayed bindings, for example after the settings changed. */
  private populateShortcuts(settings: Settings): void {
    this.localShortcuts = { ...settings.localShortcuts };
    for (const row of this.shortcutRows.values()) {
      row.input.value = this.displayShortcut(row.spec);
      this.clearShortcutError(row.input, row.error);
    }
  }

  private markDirty(): void {
    this.dirty = true;
    setHidden(this.dirtyNote, false);
  }

  private preview(): void {
    this.options.onPreview(this.selectedTheme(), this.selectedTextScale());
  }

  private selectedTheme(): Theme {
    const value = this.theme.value;
    if (value === "light" || value === "dark" || value === "high-contrast" || value === "system") {
      return value;
    }
    return "system";
  }

  private selectedTextScale(): number {
    const value = Number.parseFloat(this.textScale.value);
    if (!Number.isFinite(value)) {
      return 1;
    }
    return Math.min(2, Math.max(1, value));
  }

  private populate(settings: Settings): void {
    const config = settings.config;
    for (const input of this.modeInputs) {
      input.checked = input.value === config.mode;
    }
    this.writeDuration(this.focus, config.focusMs);
    this.writeDuration(this.shortBreak, config.shortBreakMs);
    this.writeDuration(this.longBreak, config.longBreakMs);
    this.interval.value = String(config.longBreakInterval);
    this.label.value = config.label;
    this.theme.value = settings.theme;
    this.textScale.value = String(settings.textScale);
    this.textScaleOutput.textContent = t("settings.text_scale_value", {
      value: Math.round(settings.textScale * 100)
    });
    this.notifications.input.checked = settings.notifications;
    this.sound.input.checked = settings.sound;
    this.globalShortcutEnabled.input.checked = settings.globalShortcutEnabled;
    this.globalShortcut.value = settings.globalShortcut;
    this.launchAtLogin.input.checked = settings.launchAtLogin;
    this.closeToTray.input.checked = settings.closeToTray;
    this.historyEnabled.input.checked = settings.historyEnabled;
    this.retentionDays.value = String(settings.retentionDays);
    this.populateShortcuts(settings);
    this.clearErrors();
  }

  private writeDuration(controls: DurationControls, ms: number): void {
    const parts = durationParts(ms);
    controls.hours.value = String(parts.hours);
    controls.minutes.value = String(parts.minutes);
    controls.seconds.value = String(parts.seconds);
  }

  private readDuration(
    controls: DurationControls,
    message: string
  ): { ok: boolean; ms: number } {
    const hours = Number.parseInt(controls.hours.value, 10);
    const minutes = Number.parseInt(controls.minutes.value, 10);
    const seconds = Number.parseInt(controls.seconds.value, 10);
    const result = parseDurationParts(hours, minutes, seconds);
    if (!result.ok) {
      this.showError(controls, message);
      return { ok: false, ms: 0 };
    }
    this.clearError(controls);
    return { ok: true, ms: result.ms };
  }

  private showError(controls: DurationControls, message: string): void {
    setText(controls.error, message);
    setHidden(controls.error, false);
    for (const input of [controls.hours, controls.minutes, controls.seconds]) {
      input.setAttribute("aria-invalid", "true");
      input.setAttribute("aria-describedby", controls.error.id);
    }
  }

  private clearError(controls: DurationControls): void {
    setText(controls.error, "");
    setHidden(controls.error, true);
    for (const input of [controls.hours, controls.minutes, controls.seconds]) {
      input.removeAttribute("aria-invalid");
      input.removeAttribute("aria-describedby");
    }
  }

  private showFieldError(input: HTMLInputElement, error: HTMLElement, message: string): void {
    setText(error, message);
    setHidden(error, false);
    input.setAttribute("aria-invalid", "true");
    input.setAttribute("aria-describedby", error.id);
  }

  private clearFieldError(input: HTMLInputElement, error: HTMLElement): void {
    setText(error, "");
    setHidden(error, true);
    input.removeAttribute("aria-invalid");
    input.removeAttribute("aria-describedby");
  }

  private clearErrors(): void {
    this.clearError(this.focus);
    this.clearError(this.shortBreak);
    this.clearError(this.longBreak);
    this.clearFieldError(this.interval, this.intervalError);
    this.clearFieldError(this.label, this.labelError);
    this.clearFieldError(this.globalShortcut, this.globalShortcutError);
    this.clearFieldError(this.retentionDays, this.retentionError);
  }

  private buildDraft(): { draft: Settings | null; firstInvalid: HTMLElement | null } {
    const base = this.base;
    if (!base) {
      return { draft: null, firstInvalid: null };
    }

    const focus = this.readDuration(this.focus, t("error.invalid_duration"));
    const shortBreak = this.readDuration(this.shortBreak, t("error.invalid_duration"));
    const longBreak = this.readDuration(this.longBreak, t("error.invalid_duration"));
    let firstInvalid: HTMLElement | null = null;
    if (!focus.ok) {
      firstInvalid = this.focus.hours;
    } else if (!shortBreak.ok && !firstInvalid) {
      firstInvalid = this.shortBreak.hours;
    } else if (!longBreak.ok && !firstInvalid) {
      firstInvalid = this.longBreak.hours;
    }

    const intervalValue = Number.parseInt(this.interval.value, 10);
    if (!Number.isInteger(intervalValue) || intervalValue < 1 || intervalValue > 12) {
      this.showFieldError(this.interval, this.intervalError, t("error.invalid_interval"));
      firstInvalid = firstInvalid ?? this.interval;
    } else {
      this.clearFieldError(this.interval, this.intervalError);
    }

    const labelValue = this.label.value;
    if (countCharacters(labelValue) > MAX_LABEL_LENGTH) {
      this.showFieldError(
        this.label,
        this.labelError,
        t("error.invalid_label", { max: MAX_LABEL_LENGTH })
      );
      firstInvalid = firstInvalid ?? this.label;
    } else if (!isValidLabel(labelValue)) {
      this.showFieldError(this.label, this.labelError, t("error.invalid_label_control"));
      firstInvalid = firstInvalid ?? this.label;
    } else {
      this.clearFieldError(this.label, this.labelError);
    }

    const textScale = this.selectedTextScale();
    if (textScale < 1 || textScale > 2) {
      firstInvalid = firstInvalid ?? this.textScale;
    }

    const shortcutValue = this.globalShortcut.value.trim();
    const shortcutEnabled = this.globalShortcutEnabled.input.checked;
    if (shortcutEnabled) {
      if (shortcutValue.length === 0) {
        this.showFieldError(
          this.globalShortcut,
          this.globalShortcutError,
          t("error.shortcut_required")
        );
        firstInvalid = firstInvalid ?? this.globalShortcut;
      } else if (!isShortcutPattern(shortcutValue)) {
        this.showFieldError(
          this.globalShortcut,
          this.globalShortcutError,
          t("error.invalid_shortcut")
        );
        firstInvalid = firstInvalid ?? this.globalShortcut;
      } else {
        this.clearFieldError(this.globalShortcut, this.globalShortcutError);
      }
    } else {
      this.clearFieldError(this.globalShortcut, this.globalShortcutError);
    }

    const retentionValue = Number.parseInt(this.retentionDays.value, 10);
    if (
      !Number.isInteger(retentionValue) ||
      retentionValue < 1 ||
      retentionValue > MAX_RETENTION_DAYS
    ) {
      this.showFieldError(this.retentionDays, this.retentionError, t("error.invalid_retention"));
      firstInvalid = firstInvalid ?? this.retentionDays;
    } else {
      this.clearFieldError(this.retentionDays, this.retentionError);
    }

    if (!focus.ok || !shortBreak.ok || !longBreak.ok || firstInvalid) {
      return { draft: null, firstInvalid };
    }

    const mode = this.modeInputs.find((input) => input.checked)?.value === "countdown" ? "countdown" : "cycle";
    const config: TimerConfig = {
      mode,
      focusMs: focus.ms,
      shortBreakMs: shortBreak.ms,
      longBreakMs: longBreak.ms,
      longBreakInterval: intervalValue,
      label: labelValue
    };

    const draft: Settings = {
      schemaVersion: 1,
      revision: base.revision,
      theme: this.selectedTheme(),
      textScale,
      config,
      notifications: this.notifications.input.checked,
      sound: this.sound.input.checked,
      soundVolume: base.soundVolume,
      autoAdvance: base.autoAdvance,
      globalShortcutEnabled: shortcutEnabled,
      globalShortcut: shortcutValue,
      launchAtLogin: this.launchAtLogin.input.checked,
      closeToTray: this.closeToTray.input.checked,
      historyEnabled: this.historyEnabled.input.checked,
      retentionDays: retentionValue,
      // Only usable overrides that differ from the default are stored.
      localShortcuts: normalizeLocalShortcuts(this.localShortcuts, this.isMac)
    };

    return { draft, firstInvalid: null };
  }

  private async submit(): Promise<void> {
    const { draft, firstInvalid } = this.buildDraft();
    if (!draft) {
      if (firstInvalid) {
        firstInvalid.focus();
      }
      this.options.announce(t("error.invalid_duration"));
      return;
    }

    setHidden(this.saveError, true);
    const message = await this.options.onSave(draft);
    if (message) {
      setText(this.saveError, t("error.save_failed", { message }));
      setHidden(this.saveError, false);
      this.options.announce(t("error.save_failed", { message }));
      return;
    }
    this.dirty = false;
    setHidden(this.dirtyNote, true);
    this.base = draft;
    this.options.announce(t("settings.saved"));
    this.modal.close();
  }

  private async requestCancel(): Promise<void> {
    if (this.dirty) {
      const discard = await this.confirmDiscard();
      if (!discard) {
        return;
      }
    }
    this.options.onCancel();
    this.modal.close();
  }

  private async confirmDiscard(): Promise<boolean> {
    return confirmDialog(this.doc, {
      title: t("dialog.cancel_confirm_title"),
      description: t("dialog.cancel_confirm_body"),
      confirmLabel: t("action.discard"),
      cancelLabel: t("action.cancel"),
      tone: "danger",
      initialFocus: "cancel"
    });
  }
}

function shortcutIssueMessage(issue: ShortcutIssue): string {
  switch (issue) {
    case "duplicate":
      return t("error.shortcut_duplicate");
    case "bare":
      return t("error.shortcut_bare");
    case "reserved":
      return t("error.shortcut_reserved");
    default:
      return t("error.shortcut_unsupported");
  }
}

const SHORTCUT_MODIFIERS = new Set([
  "commandorcontrol",
  "commandorctrl",
  "ctrl",
  "control",
  "command",
  "cmd",
  "alt",
  "option",
  "shift",
  "super",
  "meta"
]);

/**
 * A shortcut has to look like `CommandOrControl+Alt+Shift+Space`.
 *
 * It needs at least one modifier and a key that is not a modifier itself.
 */
export function isShortcutPattern(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return false;
  }
  const parts = trimmed
    .split("+")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length < 2) {
    return false;
  }
  if (parts.some((part) => !/^[A-Za-z0-9]+$/.test(part))) {
    return false;
  }
  const last = parts[parts.length - 1];
  if (last === undefined || SHORTCUT_MODIFIERS.has(last.toLowerCase())) {
    return false;
  }
  return parts.slice(0, -1).some((part) => SHORTCUT_MODIFIERS.has(part.toLowerCase()));
}
