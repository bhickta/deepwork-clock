/**
 * Shared DTO definitions and runtime validation for the bridge contract.
 *
 * The backend owns every value in here. The frontend validates what it
 * receives: unknown fields are ignored, unknown schema versions are rejected.
 */

export const SNAPSHOT_SCHEMA_VERSION = 1;
export const SETTINGS_SCHEMA_VERSION = 1;

/** The longest accepted value of one local shortcut override. */
export const MAX_LOCAL_SHORTCUT_LENGTH = 64;

export type Mode = "countdown" | "cycle";
export type Phase = "focus" | "short_break" | "long_break";
export type Status = "idle" | "running" | "paused" | "completed" | "recovery_pending";
export type Theme = "system" | "light" | "dark" | "high-contrast";
export type ViewMode = "normal" | "compact";
export type Outcome = "completed" | "skipped" | "ended";
export type CapabilityState = "available" | "unavailable" | "permission_required" | "unknown";
export type ExportFormat = "csv" | "json";
export type WindowAction =
  | "compact"
  | "normal"
  | "pin"
  | "unpin"
  | "float"
  | "unfloat"
  | "restore";

export const MODES: readonly Mode[] = ["countdown", "cycle"];
export const PHASES: readonly Phase[] = ["focus", "short_break", "long_break"];
export const STATUSES: readonly Status[] = [
  "idle",
  "running",
  "paused",
  "completed",
  "recovery_pending"
];
export const THEMES: readonly Theme[] = ["system", "light", "dark", "high-contrast"];
export const VIEW_MODES: readonly ViewMode[] = ["normal", "compact"];
export const OUTCOMES: readonly Outcome[] = ["completed", "skipped", "ended"];
export const CAPABILITY_STATES: readonly CapabilityState[] = [
  "available",
  "unavailable",
  "permission_required",
  "unknown"
];

/** The frozen configuration of one session. */
export interface TimerConfig {
  mode: Mode;
  focusMs: number;
  shortBreakMs: number;
  longBreakMs: number;
  longBreakInterval: number;
  label: string;
}

/** Actions the timer engine understands. */
export type Action =
  | { readonly type: "configure"; readonly config: TimerConfig }
  | { readonly type: "start" }
  | { readonly type: "pause" }
  | { readonly type: "resume" }
  | { readonly type: "reset" }
  | { readonly type: "skip" }
  | { readonly type: "advance" }
  | { readonly type: "end" }
  | { readonly type: "accept_recovery" }
  | { readonly type: "discard_recovery" };

export type ActionType = Action["type"];

export interface Snapshot {
  schemaVersion: 1;
  revision: number;
  sessionId: string | null;
  phaseId: string | null;
  mode: Mode;
  phase: Phase;
  status: Status;
  durationMs: number;
  remainingMs: number;
  completedFocusCount: number;
  label: string;
  interrupted: boolean;
}

export interface Settings {
  schemaVersion: 1;
  revision: number;
  theme: Theme;
  textScale: number;
  config: TimerConfig;
  notifications: boolean;
  sound: boolean;
  soundVolume: number;
  autoAdvance: boolean;
  globalShortcutEnabled: boolean;
  globalShortcut: string;
  launchAtLogin: boolean;
  closeToTray: boolean;
  historyEnabled: boolean;
  retentionDays: number;
  /** The window layout that was last in use. */
  viewMode: ViewMode;
  /** The compact window was also floating above other windows. */
  floating: boolean;
  /** Local shortcut overrides, keyed by shortcut id. Empty means defaults. */
  localShortcuts: Record<string, string>;
}

export interface Capability {
  state: CapabilityState;
  reason: string;
}

export type Capabilities = Readonly<Record<string, Capability>>;

export interface HistoryRecord {
  phaseId: string;
  phase: Phase;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  label: string;
  outcome: Outcome;
  interrupted: boolean;
  confirmed: boolean;
  localDate: string;
}

/**
 * The checkpoint of an interrupted session.
 *
 * The backend keeps the last saved point so a frontend can tell the user how
 * old the checkpoint is before they decide to resume or to discard it.
 */
export interface RecoveryCheckpoint {
  savedAt: string;
  ageMs: number;
  phaseId: string | null;
  remainingMs: number;
}

export type ErrorCode =
  | "INVALID_DURATION"
  | "INVALID_STATE"
  | "STALE_REVISION"
  | "STORAGE_UNAVAILABLE"
  | "UNSUPPORTED"
  | "SHORTCUT_CONFLICT"
  | "PERMISSION_DENIED"
  | "CORRUPT_DATA"
  | "INTERNAL";

export interface AppError {
  code: ErrorCode | string;
  message: string;
  snapshot?: Snapshot;
}

export interface TimerCommandRequest {
  requestId: string;
  expectedRevision: number;
  action: Action;
}

export interface SaveSettingsRequest {
  expectedSettingsRevision: number;
  settings: Settings;
}

/** Raised when the backend sends something the frontend cannot understand. */
export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractError";
  }
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ContractError(`Expected ${what} to be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new ContractError(`Expected "${key}" to be a string.`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new ContractError(`Expected "${key}" to be a string or null.`);
  }
  return value;
}

function requireBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new ContractError(`Expected "${key}" to be a boolean.`);
  }
  return value;
}

function requireNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ContractError(`Expected "${key}" to be a finite number.`);
  }
  return value;
}

function requireInteger(record: Record<string, unknown>, key: string): number {
  const value = requireNumber(record, key);
  if (!Number.isInteger(value)) {
    throw new ContractError(`Expected "${key}" to be an integer.`);
  }
  return value;
}

function requireNonNegativeInteger(record: Record<string, unknown>, key: string): number {
  const value = requireInteger(record, key);
  if (value < 0) {
    throw new ContractError(`Expected "${key}" to be zero or greater.`);
  }
  return value;
}

/** A whole number from 0 to 100, inclusive. */
function requirePercentage(record: Record<string, unknown>, key: string): number {
  const value = requireInteger(record, key);
  if (value < 0 || value > 100) {
    throw new ContractError(`Expected "${key}" to be between 0 and 100.`);
  }
  return value;
}

function requireEnum<T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly T[]
): T {
  const value = requireString(record, key);
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ContractError(`Unexpected "${key}" value: ${value}`);
  }
  return value as T;
}

/** Validate and narrow a snapshot received from the backend. */
export function parseSnapshot(raw: unknown): Snapshot {
  const record = asRecord(raw, "snapshot");
  const schemaVersion = record["schemaVersion"];
  if (schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new ContractError(
      `Unsupported snapshot schema version: ${String(schemaVersion)}`
    );
  }
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    revision: requireNonNegativeInteger(record, "revision"),
    sessionId: optionalString(record, "sessionId"),
    phaseId: optionalString(record, "phaseId"),
    mode: requireEnum(record, "mode", MODES),
    phase: requireEnum(record, "phase", PHASES),
    status: requireEnum(record, "status", STATUSES),
    durationMs: requireNonNegativeInteger(record, "durationMs"),
    remainingMs: requireNonNegativeInteger(record, "remainingMs"),
    completedFocusCount: requireNonNegativeInteger(record, "completedFocusCount"),
    label: requireString(record, "label"),
    interrupted: requireBoolean(record, "interrupted")
  };
}

/** Validate and narrow the timer configuration. */
export function parseConfig(raw: unknown): TimerConfig {
  const record = asRecord(raw, "config");
  return {
    mode: requireEnum(record, "mode", MODES),
    focusMs: requireNonNegativeInteger(record, "focusMs"),
    shortBreakMs: requireNonNegativeInteger(record, "shortBreakMs"),
    longBreakMs: requireNonNegativeInteger(record, "longBreakMs"),
    longBreakInterval: requireNonNegativeInteger(record, "longBreakInterval"),
    label: requireString(record, "label")
  };
}

/**
 * Validate the local shortcut overrides.
 *
 * A backend that does not send the field yet is treated as "no overrides", so
 * the default bindings stay available. A malformed value is refused instead of
 * silently changing how the application reacts to the keyboard.
 */
export function parseLocalShortcuts(raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null) {
    return {};
  }
  const record = asRecord(raw, "localShortcuts");
  const result: Record<string, string> = {};
  for (const [id, value] of Object.entries(record)) {
    if (typeof value !== "string") {
      throw new ContractError(`Expected the local shortcut "${id}" to be a string.`);
    }
    if (value.length > MAX_LOCAL_SHORTCUT_LENGTH) {
      throw new ContractError(`The local shortcut "${id}" is too long.`);
    }
    result[id] = value;
  }
  return result;
}

/** Validate and narrow the settings document. */
export function parseSettings(raw: unknown): Settings {
  const record = asRecord(raw, "settings");
  const schemaVersion = record["schemaVersion"];
  if (schemaVersion !== SETTINGS_SCHEMA_VERSION) {
    throw new ContractError(
      `Unsupported settings schema version: ${String(schemaVersion)}`
    );
  }
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    revision: requireNonNegativeInteger(record, "revision"),
    theme: requireEnum(record, "theme", THEMES),
    textScale: requireNumber(record, "textScale"),
    config: parseConfig(record["config"]),
    notifications: requireBoolean(record, "notifications"),
    sound: requireBoolean(record, "sound"),
    soundVolume: requirePercentage(record, "soundVolume"),
    autoAdvance: requireBoolean(record, "autoAdvance"),
    globalShortcutEnabled: requireBoolean(record, "globalShortcutEnabled"),
    globalShortcut: requireString(record, "globalShortcut"),
    launchAtLogin: requireBoolean(record, "launchAtLogin"),
    closeToTray: requireBoolean(record, "closeToTray"),
    historyEnabled: requireBoolean(record, "historyEnabled"),
    retentionDays: requireNonNegativeInteger(record, "retentionDays"),
    viewMode: requireEnum(record, "viewMode", VIEW_MODES),
    floating: requireBoolean(record, "floating"),
    localShortcuts: parseLocalShortcuts(record["localShortcuts"])
  };
}

/** Validate and narrow the capability map. */
export function parseCapabilities(raw: unknown): Capabilities {
  const record = asRecord(raw, "capabilities");
  const result: Record<string, Capability> = {};
  for (const [name, value] of Object.entries(record)) {
    if (typeof value !== "object" || value === null) {
      result[name] = { state: "unknown", reason: "Unreadable capability report." };
      continue;
    }
    const entry = value as Record<string, unknown>;
    const state = entry["state"];
    const reason = entry["reason"];
    if (typeof state === "string" && (CAPABILITY_STATES as readonly string[]).includes(state)) {
      result[name] = {
        state: state as CapabilityState,
        reason: typeof reason === "string" ? reason : ""
      };
    } else {
      result[name] = {
        state: "unknown",
        reason: "The desktop app reported an unreadable capability state."
      };
    }
  }
  return result;
}

/** Validate and narrow one history record. */
export function parseHistoryRecord(raw: unknown): HistoryRecord {  const record = asRecord(raw, "history record");
  return {
    phaseId: requireString(record, "phaseId"),
    phase: requireEnum(record, "phase", PHASES),
    startedAt: requireString(record, "startedAt"),
    endedAt: requireString(record, "endedAt"),
    durationMs: requireNonNegativeInteger(record, "durationMs"),
    label: requireString(record, "label"),
    outcome: requireEnum(record, "outcome", OUTCOMES),
    interrupted: requireBoolean(record, "interrupted"),
    confirmed: requireBoolean(record, "confirmed"),
    localDate: requireString(record, "localDate")
  };
}

/** Validate and narrow the checkpoint of an interrupted session. */
export function parseRecoveryCheckpoint(raw: unknown): RecoveryCheckpoint | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  const record = asRecord(raw, "recovery checkpoint");
  return {
    savedAt: requireString(record, "savedAt"),
    ageMs: requireNonNegativeInteger(record, "ageMs"),
    phaseId: optionalString(record, "phaseId"),
    remainingMs: requireNonNegativeInteger(record, "remainingMs")
  };
}

/** Validate and narrow a list of history records. */
export function parseHistoryRecords(raw: unknown): HistoryRecord[] {
  if (!Array.isArray(raw)) {
    throw new ContractError("Expected a list of history records.");
  }
  return raw.map((entry) => parseHistoryRecord(entry));
}

/** True when the value looks like a structured bridge error. */
export function isAppError(value: unknown): value is AppError {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record["code"] === "string" && typeof record["message"] === "string";
}

/** Validate and narrow a structured error or warning. */
export function parseAppError(raw: unknown): AppError {
  const record = asRecord(raw, "error");
  const code = record["code"];
  const message = record["message"];
  if (typeof code !== "string" || typeof message !== "string") {
    throw new ContractError("Expected an error with a code and a message.");
  }
  const snapshot = record["snapshot"];
  if (snapshot !== undefined && snapshot !== null) {
    return { code, message, snapshot: parseSnapshot(snapshot) };
  }
  return { code, message };
}

/** Validate and narrow a list of warnings. */
export function parseAppErrors(raw: unknown): AppError[] {
  if (!Array.isArray(raw)) {
    throw new ContractError("Expected a list of warnings.");
  }
  return raw.map((entry) => parseAppError(entry));
}

/** Build a structured error object. */
export function appError(
  code: ErrorCode | string,
  message: string,
  snapshot?: Snapshot
): AppError {
  if (snapshot) {
    return { code, message, snapshot };
  }
  return { code, message };
}
