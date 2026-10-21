import { el, setHidden, setText } from "./dom";
import { createIcon, setIcon } from "./icons";
import { formatClock, formatDurationLong } from "./format";
import type { RecoveryCheckpoint, Snapshot } from "./contract";
import { t } from "./i18n";

export interface TimerViewOptions {
  onPrimary(): void;
  onReset(): void;
  onSkip(): void;
  onEnd(): void;
  onAnnounce(): void;
  onRecoveryAccept(): void;
  onRecoveryDiscard(): void;
}

const PHASE_LABEL_KEYS = {
  focus: "phase.focus",
  short_break: "phase.short_break",
  long_break: "phase.long_break"
} as const;

const STATUS_LABEL_KEYS = {
  idle: "status.idle",
  running: "status.running",
  paused: "status.paused",
  completed: "status.completed",
  recovery_pending: "status.recovery_pending"
} as const;

/**
 * The timer surface.
 *
 * The DOM is built once. Updates only change text and attributes so a focused
 * control is never replaced while the timer ticks.
 */
export class TimerView {
  readonly element: HTMLElement;

  private readonly digits: HTMLElement;

  private readonly phaseBadge: HTMLElement;

  private readonly phaseText: HTMLElement;

  private readonly statusLine: HTMLElement;

  private readonly labelLine: HTMLElement;

  private readonly focusCount: HTMLElement;

  private readonly primaryButton: HTMLButtonElement;

  private readonly primaryIcon: HTMLElement;

  private readonly primaryLabel: HTMLElement;

  private readonly resetButton: HTMLButtonElement;

  private readonly skipButton: HTMLButtonElement;

  private readonly endButton: HTMLButtonElement;

  private readonly recovery: HTMLElement;

  private readonly recoveryDetail: HTMLElement;

  private primaryMode = "";

  constructor(options: TimerViewOptions) {
    this.phaseText = el("span", { class: "phase-badge__text", text: t("phase.focus") });
    this.phaseBadge = el("p", { class: "phase-badge", data: { phase: "focus" } }, [this.phaseText]);

    this.labelLine = el("p", { class: "session-label" });

    this.digits = el("div", {
      class: "timer-digits",
      attrs: {
        id: "timer-digits",
        role: "timer",
        "aria-live": "off",
        "aria-atomic": "true",
        "aria-label": t("label.remaining")
      },
      text: "--:--"
    });

    this.statusLine = el("p", { class: "timer-status", text: t("status.idle") });

    this.primaryIcon = el("span", { class: "button__icon" });
    this.primaryLabel = el("span", { class: "button__label", text: t("action.start") });
    this.primaryButton = el(
      "button",
      {
        class: "button button--primary button--wide",
        attrs: { type: "button", "data-action": "primary" },
        on: { click: () => options.onPrimary() }
      },
      [this.primaryIcon, this.primaryLabel]
    );

    this.resetButton = el("button", {
      class: "button",
      attrs: { type: "button", "data-action": "reset" },
      text: t("action.reset"),
      on: { click: () => options.onReset() }
    });

    this.skipButton = el("button", {
      class: "button",
      attrs: { type: "button", "data-action": "skip" },
      text: t("action.skip"),
      on: { click: () => options.onSkip() }
    });

    this.endButton = el("button", {
      class: "button button--quiet",
      attrs: { type: "button", "data-action": "end" },
      text: t("action.end"),
      on: { click: () => options.onEnd() }
    });

    const announceButton = el(
      "button",
      {
        class: "icon-button",
        attrs: { type: "button", title: t("action.announce"), "data-action": "announce" },
        on: { click: () => options.onAnnounce() }
      },
      [createIcon("volume", 18), el("span", { class: "sr-only", text: t("action.announce") })]
    );

    const controls = el("div", { class: "timer-controls" }, [
      this.primaryButton,
      el("div", { class: "timer-controls__row" }, [this.resetButton, this.skipButton, this.endButton, announceButton])
    ]);

    this.focusCount = el("p", { class: "timer-focus-count" });

    this.recoveryDetail = el("p", { class: "recovery__detail" });

    this.recovery = el("section", { class: "recovery", attrs: { "aria-labelledby": "recovery-heading" } }, [
      el("h3", { class: "recovery__title", id: "recovery-heading", text: t("recovery.title") }),
      el("p", { class: "recovery__body", text: t("recovery.body") }),
      this.recoveryDetail,
      el("div", { class: "recovery__actions" }, [
        el("button", {
          class: "button button--primary",
          attrs: { type: "button", "data-action": "recovery-accept" },
          text: t("recovery.resume"),
          on: { click: () => options.onRecoveryAccept() }
        }),
        el("button", {
          class: "button",
          attrs: { type: "button", "data-action": "recovery-discard" },
          text: t("recovery.discard"),
          on: { click: () => options.onRecoveryDiscard() }
        })
      ])
    ]);

    this.element = el("section", { class: "panel timer-panel", attrs: { "aria-labelledby": "phase-heading" } }, [
      el("h2", { class: "sr-only", id: "phase-heading", text: t("label.current_phase") }),
      this.recovery,
      this.phaseBadge,
      this.labelLine,
      this.digits,
      this.statusLine,
      this.focusCount,
      controls
    ]);

    // Nothing is known before the first snapshot arrives, so the parts that
    // depend on it stay out of the way.
    setHidden(this.phaseBadge, true);
    setHidden(this.statusLine, true);
    setHidden(this.focusCount, true);
    setHidden(this.labelLine, true);
    setHidden(this.recovery, true);
    setHidden(this.endButton, true);
    setHidden(this.skipButton, true);
  }

  /** Update the timer surface from a snapshot. */
  update(snapshot: Snapshot, remainingMs: number, recovery?: RecoveryCheckpoint | null): void {
    const phaseKey = PHASE_LABEL_KEYS[snapshot.phase];
    setText(this.phaseText, t(phaseKey));
    this.phaseBadge.setAttribute("data-phase", snapshot.phase);
    setHidden(this.phaseBadge, false);

    const label = snapshot.label.trim();
    setText(this.labelLine, label);
    setHidden(this.labelLine, label.length === 0);

    setText(this.statusLine, t(STATUS_LABEL_KEYS[snapshot.status]));
    setHidden(this.statusLine, false);
    // The counter only appears once something was completed.
    setText(this.focusCount, t("timer.focus_count", { count: snapshot.completedFocusCount }));
    setHidden(this.focusCount, snapshot.completedFocusCount === 0);

    this.setRemaining(remainingMs);
    this.setPrimary(snapshot);
    this.setSecondary(snapshot);
    setHidden(this.recovery, snapshot.status !== "recovery_pending");
    this.setRecoveryDetail(recovery ?? null);
  }

  /** Show how old the recovered checkpoint is, when the backend knows it. */
  private setRecoveryDetail(recovery: RecoveryCheckpoint | null): void {
    if (!recovery) {
      setHidden(this.recoveryDetail, true);
      setText(this.recoveryDetail, "");
      return;
    }
    setText(
      this.recoveryDetail,
      t("recovery.checkpoint", {
        age: formatDurationLong(recovery.ageMs),
        duration: formatDurationLong(recovery.remainingMs)
      })
    );
    setHidden(this.recoveryDetail, false);
  }

  /** Update only the digits, used while the display interpolates. */
  setRemaining(remainingMs: number): void {
    setText(this.digits, formatClock(remainingMs));
  }

  /** The remaining time shown right now. */
  get remainingText(): string {
    return this.digits.textContent ?? "";
  }

  /** The element that shows the remaining time. */
  get digitsElement(): HTMLElement {
    return this.digits;
  }

  /** The primary control, used by tests and by the keyboard shortcut. */
  get primaryControl(): HTMLButtonElement {
    return this.primaryButton;
  }

  private setPrimary(snapshot: Snapshot): void {
    let label: string;
    let icon: "play" | "pause";
    let mode = snapshot.status;

    if (snapshot.status === "idle") {
      label = t("action.start");
      icon = "play";
    } else if (snapshot.status === "running") {
      label = t("action.pause");
      icon = "pause";
    } else if (snapshot.status === "paused") {
      label = t("action.resume");
      icon = "play";
    } else if (snapshot.status === "completed") {
      if (snapshot.mode === "cycle") {
        label = snapshot.phase === "focus" ? t("action.start_break") : t("action.start_focus");
      } else {
        label = t("action.start_again");
      }
      icon = "play";
    } else {
      label = t("action.resume");
      icon = "play";
      mode = "recovery_pending";
    }

    setText(this.primaryLabel, label);
    this.primaryButton.setAttribute("aria-label", label);
    if (this.primaryMode !== mode) {
      this.primaryMode = mode;
      setIcon(this.primaryIcon, icon);
    }
    this.primaryButton.disabled = snapshot.status === "recovery_pending";
  }

  private setSecondary(snapshot: Snapshot): void {
    const recovering = snapshot.status === "recovery_pending";
    this.resetButton.disabled = recovering;
    this.skipButton.disabled = recovering;
    this.endButton.disabled = recovering;

    // The engine only accepts a skip while a phase runs, while it is paused
    // and right after it completed. In every other state the control is not
    // offered at all.
    const skipAvailable =
      snapshot.mode === "cycle" &&
      (snapshot.status === "running" ||
        snapshot.status === "paused" ||
        snapshot.status === "completed");
    setHidden(this.skipButton, !skipAvailable);
    setHidden(this.endButton, snapshot.status !== "running" && snapshot.status !== "paused");
  }
}
