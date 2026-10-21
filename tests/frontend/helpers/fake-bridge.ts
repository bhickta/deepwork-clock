import type {
  Action,
  AppError,
  Capabilities,
  ExportFormat,
  HistoryRecord,
  RecoveryCheckpoint,
  SaveSettingsRequest,
  Settings,
  Snapshot,
  TimerCommandRequest,
  WindowAction
} from "../../../src/contract";
import type { Bridge, BridgeKind } from "../../../src/bridge";

/** A snapshot with sensible defaults for tests. */
export function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    schemaVersion: 1,
    revision: 7,
    sessionId: "session-1",
    phaseId: "phase-1",
    mode: "cycle",
    phase: "focus",
    status: "idle",
    durationMs: 50 * 60 * 1000,
    remainingMs: 50 * 60 * 1000,
    completedFocusCount: 0,
    label: "",
    interrupted: false,
    ...overrides
  };
}

/** Settings with sensible defaults for tests. */
export function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    schemaVersion: 1,
    revision: 3,
    theme: "light",
    textScale: 1,
    config: {
      mode: "cycle",
      focusMs: 50 * 60 * 1000,
      shortBreakMs: 10 * 60 * 1000,
      longBreakMs: 30 * 60 * 1000,
      longBreakInterval: 4,
      label: ""
    },
    notifications: false,
    sound: false,
    soundVolume: 60,
    autoAdvance: false,
    globalShortcutEnabled: false,
    globalShortcut: "",
    launchAtLogin: false,
    closeToTray: false,
    historyEnabled: true,
    retentionDays: 90,
    localShortcuts: {},
    ...overrides
  };
}

/** A history record with sensible defaults for tests. */
export function makeHistoryRecord(overrides: Partial<HistoryRecord> = {}): HistoryRecord {
  return {
    phaseId: "phase-1",
    phase: "focus",
    startedAt: "2026-10-21T09:00:00.000Z",
    endedAt: "2026-10-21T09:50:00.000Z",
    durationMs: 50 * 60 * 1000,
    label: "Writing",
    outcome: "completed",
    interrupted: false,
    confirmed: false,
    localDate: "2026-10-21",
    ...overrides
  };
}

/** Apply an action to a snapshot the way the engine would. */
export function reduceSnapshot(snapshot: Snapshot, action: Action): Snapshot {
  const next: Snapshot = { ...snapshot, revision: snapshot.revision + 1 };
  switch (action.type) {
    case "start":
      next.status = "running";
      break;
    case "pause":
      next.status = "paused";
      break;
    case "resume":
      next.status = "running";
      break;
    case "reset":
      next.status = "idle";
      next.remainingMs = next.durationMs;
      break;
    case "skip":
      next.status = "idle";
      next.remainingMs = next.durationMs;
      break;
    case "advance":
      next.status = "idle";
      next.remainingMs = next.durationMs;
      break;
    case "end":
      next.status = "idle";
      next.remainingMs = next.durationMs;
      break;
    case "configure":
      next.mode = action.config.mode;
      next.label = action.config.label;
      next.durationMs = action.config.focusMs;
      next.remainingMs = action.config.focusMs;
      next.status = "idle";
      break;
    case "accept_recovery":
      next.status = "running";
      break;
    case "discard_recovery":
      next.status = "idle";
      break;
    default:
      break;
  }
  return next;
}

export interface FakeBridgeOptions {
  kind?: BridgeKind;
  snapshot?: Partial<Snapshot>;
  settings?: Partial<Settings>;
  capabilities?: Capabilities;
  history?: HistoryRecord[];
}

/** An in memory bridge that records what the app asked for. */
export class FakeBridge implements Bridge {
  readonly kind: BridgeKind;

  snapshot: Snapshot;

  settings: Settings;

  capabilities: Capabilities;

  history: HistoryRecord[];

  warnings: AppError[] = [];

  recovery: RecoveryCheckpoint | null = null;

  /** The order in which the app called the bridge. */
  readonly calls: string[] = [];

  readonly commands: TimerCommandRequest[] = [];

  readonly savedSettings: SaveSettingsRequest[] = [];

  readonly windowActions: WindowAction[] = [];

  readonly exports: ExportFormat[] = [];

  readonly confirmed: string[] = [];

  deleteCalls = 0;

  exportResult: string | null = "/tmp/history.csv";

  commandError: unknown = null;

  saveError: unknown = null;

  listHistoryError: unknown = null;

  private readonly listeners = new Set<(snapshot: Snapshot) => void>();

  private readonly warningListeners = new Set<(error: AppError) => void>();

  constructor(options: FakeBridgeOptions = {}) {
    this.kind = options.kind ?? "native";
    this.snapshot = makeSnapshot(options.snapshot);
    this.settings = makeSettings(options.settings);
    this.capabilities = options.capabilities ?? {
      pin: { state: "available", reason: "" },
      tray: { state: "available", reason: "" },
      globalShortcut: { state: "available", reason: "" },
      notifications: { state: "available", reason: "" },
      autostart: { state: "available", reason: "" }
    };
    this.history = options.history ?? [];
  }

  async getSnapshot(): Promise<Snapshot> {
    this.calls.push("getSnapshot");
    return this.snapshot;
  }

  async timerCommand(request: TimerCommandRequest): Promise<Snapshot> {
    this.calls.push("timerCommand");
    this.commands.push(request);
    if (this.commandError) {
      const error = this.commandError;
      this.commandError = null;
      throw error;
    }
    this.snapshot = reduceSnapshot(this.snapshot, request.action);
    this.publish();
    return this.snapshot;
  }

  async getSettings(): Promise<Settings> {
    this.calls.push("getSettings");
    return this.settings;
  }

  async saveSettings(request: SaveSettingsRequest): Promise<Settings> {
    this.calls.push("saveSettings");
    this.savedSettings.push(request);
    if (this.saveError) {
      const error = this.saveError;
      this.saveError = null;
      throw error;
    }
    this.settings = { ...request.settings, revision: request.settings.revision + 1 };
    return this.settings;
  }

  async getCapabilities(): Promise<Capabilities> {
    this.calls.push("getCapabilities");
    return this.capabilities;
  }

  async getWarnings(): Promise<AppError[]> {
    this.calls.push("getWarnings");
    return this.warnings.map((warning) => ({ ...warning }));
  }

  async getRecovery(): Promise<RecoveryCheckpoint | null> {
    this.calls.push("getRecovery");
    return this.recovery ? { ...this.recovery } : null;
  }

  async windowAction(action: WindowAction): Promise<void> {
    this.windowActions.push(action);
  }

  async listHistory(): Promise<HistoryRecord[]> {
    if (this.listHistoryError) {
      throw this.listHistoryError;
    }
    return this.history;
  }

  async exportHistory(format: ExportFormat): Promise<string | null> {
    this.exports.push(format);
    return this.exportResult;
  }

  async deleteHistory(): Promise<void> {
    this.deleteCalls += 1;
    this.history = [];
  }

  async confirmHistory(phaseId: string): Promise<void> {
    this.confirmed.push(phaseId);
    const record = this.history.find((entry) => entry.phaseId === phaseId);
    if (record) {
      record.confirmed = true;
    }
  }

  async subscribeSnapshot(listener: (snapshot: Snapshot) => void): Promise<() => void> {
    this.calls.push("subscribeSnapshot");
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async subscribeWarning(listener: (error: AppError) => void): Promise<() => void> {
    this.calls.push("subscribeWarning");
    this.warningListeners.add(listener);
    return () => {
      this.warningListeners.delete(listener);
    };
  }

  /** Publish a snapshot to every subscriber, as the backend does. */
  publish(snapshot?: Snapshot): void {
    if (snapshot) {
      this.snapshot = snapshot;
    }
    for (const listener of Array.from(this.listeners)) {
      listener(this.snapshot);
    }
  }

  /** Report a warning to every subscriber, as the backend does. */
  publishWarning(error: AppError): void {
    this.warnings.push(error);
    for (const listener of Array.from(this.warningListeners)) {
      listener(error);
    }
  }
}
