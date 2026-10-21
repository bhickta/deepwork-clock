/**
 * Development only preview backend.
 *
 * It mimics the desktop engine closely enough to exercise the interface in a
 * plain browser. It is only selected in a development build when the page is
 * opened with `?demo=1`, and the app shows a banner while it is active.
 */
import {
  appError,
  type AppError,
  type Capabilities,
  type ExportFormat,
  type HistoryRecord,
  type Mode,
  type Phase,
  type RecoveryCheckpoint,
  type SaveSettingsRequest,
  type Settings,
  type Snapshot,
  type Status,
  type TimerConfig,
  type TimerCommandRequest
} from "./contract";
import type { Bridge } from "./bridge";

const DEFAULT_CONFIG: TimerConfig = {
  mode: "cycle",
  focusMs: 50 * 60 * 1000,
  shortBreakMs: 10 * 60 * 1000,
  longBreakMs: 30 * 60 * 1000,
  longBreakInterval: 4,
  label: ""
};

function defaultSettings(): Settings {
  return {
    schemaVersion: 1,
    revision: 1,
    theme: "system",
    textScale: 1,
    config: { ...DEFAULT_CONFIG },
    notifications: false,
    sound: false,
    globalShortcutEnabled: false,
    globalShortcut: "",
    launchAtLogin: false,
    closeToTray: false,
    historyEnabled: true,
    retentionDays: 90
  };
}

const DEMO_CAPABILITIES: Capabilities = {
  pin: {
    state: "unavailable",
    reason: "A browser preview cannot keep a window above other windows."
  },
  tray: {
    state: "unavailable",
    reason: "A browser preview has no system tray."
  },
  globalShortcut: {
    state: "unavailable",
    reason: "A browser preview cannot register a system wide shortcut."
  },
  notifications: {
    state: "unavailable",
    reason: "A browser preview cannot show desktop notifications."
  },
  autostart: {
    state: "unavailable",
    reason: "A browser preview cannot register a login item."
  },
  sound: {
    state: "unknown",
    reason: "The browser preview does not report sound support."
  }
};

function localDateString(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function cloneConfig(config: TimerConfig): TimerConfig {
  return { ...config };
}

function cloneSettings(settings: Settings): Settings {
  return { ...settings, config: cloneConfig(settings.config) };
}

function cloneRecord(record: HistoryRecord): HistoryRecord {
  return { ...record };
}

class DemoBackend {
  private revision = 1;

  private phaseCounter = 1;

  private phaseId = "demo-phase-1";

  private sessionId = "demo-session-1";

  private mode: Mode = DEFAULT_CONFIG.mode;

  private phase: Phase = "focus";

  private status: Status = "idle";

  private durationMs = DEFAULT_CONFIG.focusMs;

  private remainingMs = DEFAULT_CONFIG.focusMs;

  private completedFocusCount = 0;

  private label = "";

  private interrupted = false;

  private config: TimerConfig = cloneConfig(DEFAULT_CONFIG);

  private settings: Settings = defaultSettings();

  private history: HistoryRecord[] = [];

  private phaseStartedAt = new Date().toISOString();

  private anchorRemainingMs = 0;

  private anchorTime = 0;

  private readonly listeners = new Set<(snapshot: Snapshot) => void>();

  private readonly warningListeners = new Set<(error: AppError) => void>();

  private readonly warningList: AppError[] = [];

  private recovery: RecoveryCheckpoint | null = null;

  private ticker: ReturnType<typeof setInterval> | null = null;

  constructor(options: { recovery?: boolean; warning?: boolean } = {}) {
    if (options.warning) {
      // The preview can pretend that the storage is not writable, so the
      // warning path can be looked at.
      this.reportWarning(
        appError(
          "STORAGE_UNAVAILABLE",
          "The settings could not be written to disk. The timer keeps running."
        )
      );
    }
    if (options.recovery) {
      // The preview can pretend that the application was closed in the middle
      // of a session, so the recovery path can be looked at.
      const ageMs = 4 * 60_000 + 20_000;
      this.remainingMs = 12 * 60_000;
      this.durationMs = 50 * 60_000;
      this.status = "recovery_pending";
      this.interrupted = true;
      this.phaseStartedAt = new Date(Date.now() - ageMs).toISOString();
      this.recovery = {
        savedAt: this.phaseStartedAt,
        ageMs,
        phaseId: this.phaseId,
        remainingMs: this.remainingMs
      };
    }
  }

  snapshot(): Snapshot {
    return {
      schemaVersion: 1,
      revision: this.revision,
      sessionId: this.sessionId,
      phaseId: this.phaseId,
      mode: this.mode,
      phase: this.phase,
      status: this.status,
      durationMs: this.durationMs,
      remainingMs: Math.max(0, Math.round(this.currentRemainingMs())),
      completedFocusCount: this.completedFocusCount,
      label: this.label,
      interrupted: this.interrupted
    };
  }

  settingsSnapshot(): Settings {
    return cloneSettings(this.settings);
  }

  capabilities(): Capabilities {
    return DEMO_CAPABILITIES;
  }

  /** The checkpoint of an interrupted session, when the preview simulates one. */
  recoveryCheckpoint(): RecoveryCheckpoint | null {
    if (!this.recovery) {
      return null;
    }
    return { ...this.recovery };
  }

  historySnapshot(): HistoryRecord[] {
    return this.history.map(cloneRecord);
  }

  apply(request: TimerCommandRequest): Snapshot {
    const action = request.action;
    switch (action.type) {
      case "configure":
        this.configure(action.config);
        break;
      case "start":
        this.start();
        break;
      case "pause":
        this.pause();
        break;
      case "resume":
        this.resume();
        break;
      case "reset":
        this.reset();
        break;
      case "skip":
        this.skip();
        break;
      case "advance":
        this.advance();
        break;
      case "end":
        this.end();
        break;
      case "accept_recovery":
        this.acceptRecovery();
        break;
      case "discard_recovery":
        this.discardRecovery();
        break;
      default:
        throw appError("INTERNAL", "The preview does not know that action.");
    }
    this.revision += 1;
    this.emit();
    return this.snapshot();
  }

  saveSettings(request: SaveSettingsRequest): Settings {
    const next = cloneSettings(request.settings);
    if (next.config.focusMs < 1_000 || next.config.focusMs > 86_400_000) {
      // The preview reports the problem the way the desktop app does: as a
      // warning that stays visible, next to the failed command.
      const error = appError(
        "INVALID_DURATION",
        "The focus duration must be between one second and 24 hours."
      );
      this.reportWarning(error);
      throw error;
    }
    next.revision = this.settings.revision + 1;
    this.settings = next;
    this.config = cloneConfig(next.config);
    return this.settingsSnapshot();
  }

  confirmHistory(phaseId: string): void {
    const record = this.history.find((entry) => entry.phaseId === phaseId);
    if (!record) {
      throw appError("NOT_FOUND", "That session record no longer exists.");
    }
    record.confirmed = true;
  }

  deleteHistory(): void {
    this.history = [];
  }

  subscribe(listener: (snapshot: Snapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** The warnings that are still relevant. */
  warnings(): AppError[] {
    return this.warningList.map((warning) => ({ ...warning }));
  }

  subscribeWarning(listener: (error: AppError) => void): () => void {
    this.warningListeners.add(listener);
    return () => {
      this.warningListeners.delete(listener);
    };
  }

  /** Raise a warning, the way the desktop app does when storage fails. */
  reportWarning(error: AppError): void {
    const known = this.warningList.some(
      (warning) => warning.code === error.code && warning.message === error.message
    );
    if (!known) {
      this.warningList.push({ ...error });
    }
    for (const listener of Array.from(this.warningListeners)) {
      listener({ ...error });
    }
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of Array.from(this.listeners)) {
      listener(snapshot);
    }
  }

  private currentRemainingMs(): number {
    if (this.status !== "running") {
      return this.remainingMs;
    }
    return Math.max(0, this.anchorRemainingMs - (Date.now() - this.anchorTime));
  }

  private durationFor(phase: Phase): number {
    if (phase === "focus") {
      return this.config.focusMs;
    }
    if (phase === "short_break") {
      return this.config.shortBreakMs;
    }
    return this.config.longBreakMs;
  }

  private configure(config: TimerConfig): void {
    if (this.status === "running" || this.status === "paused") {
      throw appError(
        "INVALID_STATE",
        "The running phase keeps its configuration until the next session."
      );
    }
    this.config = cloneConfig(config);
    this.mode = config.mode;
    this.label = config.label;
    this.phase = "focus";
    this.durationMs = this.durationFor("focus");
    this.remainingMs = this.durationMs;
    this.status = "idle";
    this.interrupted = false;
    this.phaseStartedAt = new Date().toISOString();
    this.newPhaseId();
    this.stopTicker();
  }

  private start(): void {
    if (this.status === "running") {
      return;
    }
    if (this.status !== "idle") {
      return;
    }
    this.status = "running";
    this.anchorRemainingMs = this.remainingMs;
    this.anchorTime = Date.now();
    this.startTicker();
  }

  private pause(): void {
    if (this.status !== "running") {
      return;
    }
    this.remainingMs = this.currentRemainingMs();
    this.status = "paused";
    this.stopTicker();
  }

  private resume(): void {
    if (this.status !== "paused") {
      return;
    }
    this.status = "running";
    this.anchorRemainingMs = this.remainingMs;
    this.anchorTime = Date.now();
    this.startTicker();
  }

  private reset(): void {
    this.stopTicker();
    this.durationMs = this.durationFor(this.phase);
    this.remainingMs = this.durationMs;
    this.status = "idle";
    this.interrupted = false;
    this.phaseStartedAt = new Date().toISOString();
    this.newPhaseId();
  }

  private skip(): void {
    if (this.mode !== "cycle") {
      throw appError("INVALID_STATE", "A countdown has no next phase to skip to.");
    }
    if (this.status === "running" || this.status === "paused") {
      this.appendHistory("skipped", true);
    }
    this.selectNextPhase();
  }

  private advance(): void {
    if (this.mode !== "cycle") {
      throw appError("INVALID_STATE", "A countdown has no next phase.");
    }
    if (this.status !== "completed") {
      throw appError("INVALID_STATE", "There is no finished phase to advance from.");
    }
    this.selectNextPhase();
  }

  private end(): void {
    if (this.status === "running" || this.status === "paused") {
      this.appendHistory("ended", true);
    }
    this.stopTicker();
    this.status = "idle";
    this.remainingMs = this.durationMs;
    this.interrupted = false;
    this.phaseStartedAt = new Date().toISOString();
    this.newPhaseId();
  }

  private acceptRecovery(): void {
    if (this.status !== "recovery_pending") {
      return;
    }
    this.status = "running";
    this.anchorRemainingMs = this.remainingMs;
    this.anchorTime = Date.now();
    this.recovery = null;
    this.startTicker();
  }

  private discardRecovery(): void {
    if (this.status !== "recovery_pending") {
      return;
    }
    this.stopTicker();
    this.status = "idle";
    this.remainingMs = this.durationMs;
    this.interrupted = false;
    this.recovery = null;
    this.newPhaseId();
  }

  private selectNextPhase(): void {
    if (this.mode === "countdown") {
      this.phase = "focus";
    } else if (this.phase === "focus") {
      const interval = Math.max(1, this.config.longBreakInterval);
      this.phase = this.completedFocusCount % interval === 0 ? "long_break" : "short_break";
    } else {
      this.phase = "focus";
    }
    this.durationMs = this.durationFor(this.phase);
    this.remainingMs = this.durationMs;
    this.status = "idle";
    this.interrupted = false;
    this.phaseStartedAt = new Date().toISOString();
    this.newPhaseId();
    this.stopTicker();
  }

  private newPhaseId(): void {
    this.phaseCounter += 1;
    this.phaseId = `demo-phase-${this.phaseCounter}`;
  }

  private appendHistory(outcome: HistoryRecord["outcome"], interrupted: boolean): void {
    const endedAt = new Date().toISOString();
    const started = Date.parse(this.phaseStartedAt);
    const elapsed = Number.isNaN(started) ? 0 : Math.max(0, Date.now() - started);
    this.history.unshift({
      phaseId: this.phaseId,
      phase: this.phase,
      startedAt: this.phaseStartedAt,
      endedAt,
      durationMs: elapsed,
      label: this.label,
      outcome,
      interrupted,
      confirmed: false,
      localDate: localDateString(new Date())
    });
  }

  private complete(): void {
    this.remainingMs = 0;
    this.status = "completed";
    if (this.phase === "focus") {
      this.completedFocusCount += 1;
    }
    this.appendHistory("completed", false);
  }

  private startTicker(): void {
    if (this.ticker !== null) {
      return;
    }
    this.ticker = setInterval(() => this.tick(), 250);
  }

  private stopTicker(): void {
    if (this.ticker !== null) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  private tick(): void {
    if (this.status !== "running") {
      this.stopTicker();
      return;
    }
    const remaining = this.currentRemainingMs();
    this.remainingMs = remaining;
    if (remaining <= 0) {
      this.complete();
      this.stopTicker();
      this.revision += 1;
      this.emit();
    }
  }
}

/** Build the development preview bridge. */
export function createDemoBridge(
  options: { recovery?: boolean; warning?: boolean } = {}
): Bridge {
  const backend = new DemoBackend(options);
  return {
    kind: "demo",

    async getSnapshot(): Promise<Snapshot> {
      return backend.snapshot();
    },

    async timerCommand(request: TimerCommandRequest): Promise<Snapshot> {
      return backend.apply(request);
    },

    async getSettings(): Promise<Settings> {
      return backend.settingsSnapshot();
    },

    async saveSettings(request: SaveSettingsRequest): Promise<Settings> {
      return backend.saveSettings(request);
    },

    async getCapabilities(): Promise<Capabilities> {
      return backend.capabilities();
    },

    async getWarnings(): Promise<AppError[]> {
      return backend.warnings();
    },

    async getRecovery(): Promise<RecoveryCheckpoint | null> {
      return backend.recoveryCheckpoint();
    },

    async windowAction(): Promise<void> {
      // The preview resizes nothing; the app mirrors the request in the layout.
    },

    async listHistory(): Promise<HistoryRecord[]> {
      return backend.historySnapshot();
    },

    async exportHistory(format: ExportFormat): Promise<string | null> {
      throw appError(
        "UNSUPPORTED",
        `Exporting history as ${format} needs the desktop app.`
      );
    },

    async deleteHistory(): Promise<void> {
      backend.deleteHistory();
    },

    async confirmHistory(phaseId: string): Promise<void> {
      backend.confirmHistory(phaseId);
    },

    async subscribeSnapshot(listener: (snapshot: Snapshot) => void): Promise<() => void> {
      return backend.subscribe(listener);
    },

    async subscribeWarning(listener: (error: AppError) => void): Promise<() => void> {
      return backend.subscribeWarning(listener);
    }
  };
}
