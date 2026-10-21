/**
 * String catalog for every user facing string.
 *
 * Keeping the text in one module makes the app translation ready: no English
 * fragments are concatenated at call sites, and placeholders such as `{count}`
 * are substituted through a single helper.
 */
const CATALOG = {
  "app.title": "Deepwork Clock",
  "app.tagline": "A calm desktop timer",

  "banner.demo": "Browser preview — changes are not saved",

  "phase.focus": "Focus",
  "phase.short_break": "Short break",
  "phase.long_break": "Long break",

  "status.idle": "Ready",
  "status.running": "Running",
  "status.paused": "Paused",
  "status.completed": "Focus complete",
  "status.recovery_pending": "An unfinished session needs a decision",

  "action.start": "Start",
  "action.start_break": "Start break",
  "action.start_focus": "Start focus",
  "action.start_again": "Start again",
  "action.pause": "Pause",
  "action.resume": "Resume",
  "action.reset": "Reset",
  "action.skip": "Next",
  "action.advance": "Next phase",
  "action.end": "End session",
  "action.save": "Save settings",
  "action.settings": "Settings",
  "action.cancel": "Cancel",
  "action.close": "Close",
  "action.retry": "Retry",
  "action.confirm": "Confirm",
  "action.discard": "Discard",
  "action.export_csv": "Export CSV",
  "action.export_json": "Export JSON",
  "action.delete_all": "Delete all history",
  "action.announce": "Announce remaining time",
  "action.pin": "Pin the window above others",
  "action.unpin": "Unpin the window",
  "action.menu": "More options",
  "action.about": "About Deepwork Clock",
  "action.dismiss_warning": "Dismiss",

  "label.timer": "Timer",
  "label.current_phase": "Current phase",
  "label.session_label": "Session label",
  "label.remaining": "Remaining time",
  "label.application": "Application",
  "label.timer_controls": "Timer controls",
  "label.secondary_controls": "Secondary controls",
  "label.presets": "Focus cycle presets",
  "label.history": "Session history",
  "label.durations": "Durations",
  "label.appearance": "Appearance",
  "label.system": "Desktop integration",
  "label.history_options": "History options",

  "timer.focus_count": "{count} focus phases completed",
  "timer.no_label": "No session label",

  "presets.note": "Presets set the focus and the short break length.",
  "presets.apply": "Apply the {preset} preset",
  "presets.dialog_title": "Apply the {preset} preset?",
  "presets.dialog_body":
    "The current phase keeps its duration. The new preset is used from your next session.",
  "presets.dialog_confirm": "Use it for the next session",

  "dialog.reset_title": "Reset the current phase?",
  "dialog.reset_body": "The remaining time in this phase is discarded. This cannot be undone.",
  "dialog.skip_title": "Skip to the next phase?",
  "dialog.skip_body": "This phase is recorded as skipped and is not counted as completed focus time.",
  "dialog.end_title": "End this session?",
  "dialog.end_body": "The phase is recorded as ended. Interrupted work is not counted until you confirm it.",
  "dialog.delete_title": "Delete all session history?",
  "dialog.delete_body":
    "Every stored session record is removed from this computer. This cannot be undone.",
  "dialog.cancel_confirm_title": "Discard unsaved changes?",
  "dialog.cancel_confirm_body": "Your settings edits have not been saved.",

  "recovery.title": "Unfinished session found",
  "recovery.body":
    "The last session was interrupted. Resume it to continue where you stopped, or discard it.",
  "recovery.resume": "Resume session",
  "recovery.discard": "Discard session",
  "recovery.checkpoint":
    "The last saved point is {age} old, with {duration} left on the clock.",

  "settings.title": "Settings",
  "settings.mode": "Timer mode",
  "settings.durations": "Durations",
  "settings.appearance": "Appearance",
  "settings.system": "Desktop integration",
  "settings.history_options": "History options",
  "settings.mode.countdown": "Countdown",
  "settings.mode.cycle": "Focus cycle",
  "settings.mode.hint": "Countdown runs one phase. A focus cycle alternates focus and breaks.",
  "settings.focus": "Focus",
  "settings.short_break": "Short break",
  "settings.long_break": "Long break",
  "settings.hours": "Hours",
  "settings.minutes": "Minutes",
  "settings.seconds": "Seconds",
  "settings.interval": "Long break after every {count} focus phases",
  "settings.interval_hint": "Between 1 and 12 focus phases.",
  "settings.label": "Session label",
  "settings.label.hint": "Up to {max} characters. Stored only on this computer.",
  "settings.theme": "Theme",
  "settings.theme.system": "Match the system",
  "settings.theme.light": "Light",
  "settings.theme.dark": "Dark",
  "settings.theme.high_contrast": "High contrast",
  "settings.text_scale": "Text size",
  "settings.text_scale_value": "{value}%",
  "settings.notifications": "Desktop notifications",
  "settings.sound": "Completion sound",
  "settings.global_shortcut": "Global shortcut",
  "settings.global_shortcut.hint":
    "Off by default. Example: CommandOrControl+Alt+Shift+Space. Leave empty to clear it.",
  "settings.launch_at_login": "Start when I log in",
  "settings.close_to_tray": "Close to the tray instead of quitting",
  "settings.history_enabled": "Keep session history",
  "settings.retention_days": "Keep history for {count} days",
  "settings.next_session_note":
    "These settings are saved now and are used from the next session. The running phase keeps its current configuration.",
  "settings.saved": "Settings saved.",
  "settings.capability.available": "Available on this computer.",
  "settings.capability.unavailable": "Your desktop does not support this option.",
  "settings.capability.permission_required": "This option needs permission before it can be used.",
  "settings.capability.unknown": "Support for this option could not be verified.",
  "settings.capability.missing": "This desktop app did not report support for this option.",
  "settings.dirty_note": "You have unsaved changes.",

  "error.invalid_duration": "Choose a duration between 1 second and 24 hours.",
  "error.invalid_label": "The session label must be {max} characters or fewer.",
  "error.invalid_label_control": "The session label cannot contain control characters.",
  "error.invalid_interval": "Choose between 1 and 12 focus phases.",
  "error.invalid_text_scale": "Choose a text size between 100% and 200%.",
  "error.invalid_retention": "Choose a retention period between 1 and 3650 days.",
  "error.invalid_shortcut": "Use a combination such as CommandOrControl+Alt+Shift+Space.",
  "error.shortcut_required": "Enter a shortcut or turn the global shortcut off.",
  "error.save_failed": "The settings could not be saved: {message}",
  "error.command_failed": "That action did not run: {message}",
  "error.stale": "The timer state changed. The view was refreshed, please try again.",
  "error.connection": "The timer service could not be reached: {message}",
  "error.history_failed": "The session history could not be loaded: {message}",
  "error.export_failed": "The export failed: {message}",
  "error.export_cancelled": "Export cancelled.",
  "error.export_saved": "Exported to {path}",
  "error.delete_failed": "The history could not be deleted: {message}",
  "error.history_deleted": "All session history was deleted.",
  "error.confirm_failed": "That record could not be confirmed: {message}",

  "history.empty": "No sessions have been recorded yet.",
  "history.summary": "{duration} of confirmed focus time across {count} sessions",
  "history.summary_days": "{duration} of confirmed focus time on {date}",
  "history.session_count": "{count} sessions",
  "history.item.focus": "Focus",
  "history.item.short_break": "Short break",
  "history.item.long_break": "Long break",
  "history.outcome.completed": "Completed",
  "history.outcome.skipped": "Skipped",
  "history.outcome.ended": "Ended",
  "history.interrupted": "Interrupted, waiting for confirmation",
  "history.confirmed": "Confirmed",
  "history.confirm_action": "Confirm this session",
  "history.confirm_note":
    "Interrupted sessions stay out of your totals until you confirm them.",
  "history.show": "Show session history",
  "history.hide": "Hide session history",
  "history.disabled": "Session history is turned off in the settings.",

  "pin.unavailable": "This desktop cannot pin the window: {reason}",
  "pin.enabled": "The pin request was accepted.",
  "pin.disabled": "The window is no longer pinned.",
  "pin.request_sent":
    "The request was sent. Your desktop decides whether the window really stays above the other windows.",
  "pin.unknown_state":
    "This desktop did not report whether pinning works here, so the request is sent without a promise.",
  "window.compact": "Compact view",
  "window.normal": "Expanded view",
  "window.restored": "The window was restored.",

  "help.title": "Keyboard shortcuts",
  "help.intro":
    "Shortcuts work while the timer window has focus. They are ignored while you type in a field.",
  "help.column.action": "Action",
  "help.column.keys": "Keys",
  "help.note": "Primary is Command on macOS and Ctrl elsewhere.",
  "help.about_button": "About Deepwork Clock",

  "about.title": "About Deepwork Clock",
  "about.version": "Version {version}",
  "about.body":
    "Deepwork Clock is a small desktop timer for focused work. The timer runs in the desktop app; this window only shows its state.",
  "about.privacy":
    "Everything stays on this computer. There is no account, no analytics and no network access.",
  "about.license": "Released under the MIT licence.",
  "about.source": "Source code: {repository}",
  "about.mode.native": "Connected to the desktop timer service.",
  "about.mode.demo": "Browser preview. Nothing is saved.",

  "footer.tagline": "A little space for focused work.",
  "footer.hint": "Press F1 for keyboard shortcuts.",

  "announce.started": "{phase} started.",
  "announce.paused": "Paused. {duration} remaining.",
  "announce.completed": "Focus complete. {phase} is ready when you are.",
  "announce.idle": "Ready. {phase} is set for {duration}.",
  "announce.recovery": "An unfinished session was found. Choose resume or discard.",
  "announce.remaining": "{phase}: {duration} remaining.",

  "error.connection_title": "The timer service is not available",
  "error.warnings_failed": "The warnings could not be read: {message}",
  "error.recovery_discard_title": "Discard the unfinished session?",
  "error.recovery_discard_body":
    "The remaining time of that session is removed and the session is not counted.",
  "history.open": "Show session history",
  "history.closed": "Hide session history",

  "warnings.title": "Warnings",
  "warnings.lead":
    "The timer keeps running. These messages stay until they are dismissed or the problem is gone.",
  "warnings.show": "Show the warnings",
  "warnings.count": "{count} warnings, show the details",
  "warnings.count_one": "{count} warning, show the details"
} as const;

export type StringKey = keyof typeof CATALOG;

export type TemplateVars = Readonly<Record<string, string | number>>;

/** Resolve a catalog entry, substituting `{placeholder}` tokens. */
export function t(key: StringKey, vars?: TemplateVars): string {
  const template: string = CATALOG[key];
  if (!vars) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name];
    return value === undefined ? match : String(value);
  });
}

/** Exposed for tests and for tooling that needs the raw catalog. */
export function catalogKeys(): readonly StringKey[] {
  return Object.keys(CATALOG) as StringKey[];
}
