import type { HistoryRecord, Snapshot } from "./contract";

/** Smallest duration the timer accepts: one second. */
export const MIN_DURATION_MS = 1_000;

/** Largest duration the timer accepts: 24 hours. */
export const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

/** Maximum number of Unicode code points allowed in a session label. */
export const MAX_LABEL_LENGTH = 120;

/** Longest retention period the settings accept. */
export const MAX_RETENTION_DAYS = 3650;

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * Display representation of a remaining duration.
 *
 * Uses `ceil(remaining_ms / 1000)` clamped at zero, so a phase never shows a
 * negative value and 60 seconds reads `01:00`.
 */
export function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil((Number.isFinite(ms) ? ms : 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${pad2(minutes)}:${pad2(seconds)}`;
  }
  return `${pad2(minutes)}:${pad2(seconds)}`;
}

/** Human readable duration used for announcements and totals. */
export function formatDurationLong(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil((Number.isFinite(ms) ? ms : 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) {
    parts.push(plural(hours, "hour"));
  }
  if (minutes > 0) {
    parts.push(plural(minutes, "minute"));
  }
  if (seconds > 0 && hours === 0 && minutes === 0) {
    parts.push(plural(seconds, "second"));
  }
  if (parts.length === 0) {
    return plural(0, "second");
  }
  return parts.join(" ");
}

/** Compact duration used in totals, for example `2 h 05 min`. */
export function formatDurationTotal(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) {
    parts.push(`${hours} h`);
  }
  if (minutes > 0 || hours === 0) {
    parts.push(`${pad2(minutes)} min`);
  }
  if (seconds > 0 && hours === 0 && minutes === 0) {
    parts.push(`${seconds} s`);
  }
  return parts.join(" ");
}

function plural(value: number, unit: string): string {
  return `${value} ${unit}${value === 1 ? "" : "s"}`;
}

/** Number of Unicode code points, so labels are limited by characters not bytes. */
export function countCharacters(value: string): number {
  return Array.from(value).length;
}

export interface DurationParts {
  hours: number;
  minutes: number;
  seconds: number;
}

export interface DurationParseResult {
  ok: boolean;
  ms: number;
  message: string;
}

/** Split a duration into editable hour/minute/second parts. */
export function durationParts(ms: number): DurationParts {
  const safe = Math.max(0, Math.round(Number.isFinite(ms) ? ms : 0));
  const totalSeconds = Math.floor(safe / 1000);
  return {
    hours: Math.floor(totalSeconds / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60
  };
}

/** Parse editable hour/minute/second parts into milliseconds. */
export function parseDurationParts(
  hours: number,
  minutes: number,
  seconds: number
): DurationParseResult {
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || !Number.isInteger(seconds)) {
    return { ok: false, ms: 0, message: "incomplete" };
  }
  if (hours < 0 || minutes < 0 || seconds < 0) {
    return { ok: false, ms: 0, message: "negative" };
  }
  if (minutes > 59 || seconds > 59) {
    return { ok: false, ms: 0, message: "range" };
  }
  const ms = hours * 3_600_000 + minutes * 60_000 + seconds * 1_000;
  if (ms < MIN_DURATION_MS || ms > MAX_DURATION_MS) {
    return { ok: false, ms, message: "bounds" };
  }
  return { ok: true, ms, message: "" };
}

/** True when a duration in milliseconds is inside the accepted bounds. */
export function isValidDuration(ms: number): boolean {
  return (
    Number.isInteger(ms) && ms >= MIN_DURATION_MS && ms <= MAX_DURATION_MS
  );
}

/** True when a label is short enough and free of control characters. */
export function isValidLabel(label: string): boolean {
  if (countCharacters(label) > MAX_LABEL_LENGTH) {
    return false;
  }
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001F\u007F]/.test(label);
}

/**
 * Extrapolate the remaining time between two snapshots.
 *
 * The backend owns the authoritative countdown; the frontend only smooths the
 * display between published snapshots and never completes a session itself.
 */
export function interpolateRemaining(
  snapshot: Snapshot,
  receivedAt: number,
  now: number
): number {
  if (snapshot.status !== "running") {
    return Math.max(0, snapshot.remainingMs);
  }
  const elapsed = Math.max(0, now - receivedAt);
  return Math.max(0, snapshot.remainingMs - elapsed);
}

export interface DailyTotal {
  localDate: string;
  totalMs: number;
  sessions: number;
}

export interface FocusTotals {
  totalMs: number;
  sessions: number;
  byDay: DailyTotal[];
}

/**
 * A record counts as confirmed focus time when it is a focus phase that was
 * either not interrupted, or interrupted and explicitly confirmed.
 */
export function isConfirmedFocus(record: HistoryRecord): boolean {
  if (record.phase !== "focus") {
    return false;
  }
  return !record.interrupted || record.confirmed;
}

/** Sum confirmed focus milliseconds per local day. */
export function confirmedFocusTotals(records: readonly HistoryRecord[]): FocusTotals {
  const days = new Map<string, DailyTotal>();
  let totalMs = 0;
  let sessions = 0;
  for (const record of records) {
    if (!isConfirmedFocus(record)) {
      continue;
    }
    totalMs += Math.max(0, record.durationMs);
    sessions += 1;
    const key = record.localDate;
    const existing = days.get(key);
    if (existing) {
      existing.totalMs += Math.max(0, record.durationMs);
      existing.sessions += 1;
    } else {
      days.set(key, {
        localDate: key,
        totalMs: Math.max(0, record.durationMs),
        sessions: 1
      });
    }
  }
  const byDay = Array.from(days.values()).sort((a, b) =>
    a.localDate < b.localDate ? 1 : a.localDate > b.localDate ? -1 : 0
  );
  return { totalMs, sessions, byDay };
}

/** Format a UTC timestamp for display using the runtime locale. */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

/** Format the local day key stored with a history record. */
export function formatLocalDate(localDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!match) {
    return localDate;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.getTime())) {
    return localDate;
  }
  try {
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric"
    }).format(date);
  } catch {
    return localDate;
  }
}
