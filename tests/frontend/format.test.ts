import { describe, expect, it } from "vitest";

import {
  MAX_LABEL_LENGTH,
  confirmedFocusTotals,
  countCharacters,
  durationParts,
  formatClock,
  formatDurationLong,
  formatDurationTotal,
  isConfirmedFocus,
  isValidDuration,
  isValidLabel,
  parseDurationParts
} from "../../src/format";
import { makeHistoryRecord } from "./helpers/fake-bridge";

describe("formatClock", () => {
  it("shows exact examples from the contract", () => {
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(1_000)).toBe("00:01");
    expect(formatClock(59_000)).toBe("00:59");
    expect(formatClock(60_000)).toBe("01:00");
    expect(formatClock(3_599_000)).toBe("59:59");
    expect(formatClock(3_600_000)).toBe("1:00:00");
    expect(formatClock(86_400_000)).toBe("24:00:00");
  });

  it("rounds up to whole seconds and never shows a negative value", () => {
    expect(formatClock(1)).toBe("00:01");
    expect(formatClock(1_500)).toBe("00:02");
    expect(formatClock(-5_000)).toBe("00:00");
    expect(formatClock(Number.NaN)).toBe("00:00");
  });
});

describe("formatDurationLong", () => {
  it("describes durations in words", () => {
    expect(formatDurationLong(0)).toBe("0 seconds");
    expect(formatDurationLong(1_000)).toBe("1 second");
    expect(formatDurationLong(60_000)).toBe("1 minute");
    expect(formatDurationLong(50 * 60_000)).toBe("50 minutes");
    expect(formatDurationLong(3_600_000)).toBe("1 hour");
    expect(formatDurationLong(3_660_000)).toBe("1 hour 1 minute");
  });
});

describe("formatDurationTotal", () => {
  it("sums milliseconds before formatting", () => {
    expect(formatDurationTotal(0)).toBe("00 min");
    expect(formatDurationTotal(90_000)).toBe("01 min");
    expect(formatDurationTotal(7_500_000)).toBe("2 h 05 min");
  });
});

describe("parseDurationParts", () => {
  it("accepts one second up to twenty four hours", () => {
    expect(parseDurationParts(0, 0, 1)).toEqual({ ok: true, ms: 1_000, message: "" });
    expect(parseDurationParts(1, 30, 0)).toEqual({ ok: true, ms: 5_400_000, message: "" });
    expect(parseDurationParts(24, 0, 0).ok).toBe(true);
  });

  it("rejects empty, negative, out of range and fractional input", () => {
    expect(parseDurationParts(0, 0, 0).ok).toBe(false);
    expect(parseDurationParts(-1, 0, 0).ok).toBe(false);
    expect(parseDurationParts(0, 60, 0).ok).toBe(false);
    expect(parseDurationParts(0, 0, 60).ok).toBe(false);
    expect(parseDurationParts(24, 0, 1).ok).toBe(false);
    expect(parseDurationParts(1.5, 0, 0).ok).toBe(false);
    expect(parseDurationParts(Number.NaN, 0, 0).ok).toBe(false);
  });
});

describe("durationParts", () => {
  it("splits a duration into editable parts", () => {
    expect(durationParts(3_599_000)).toEqual({ hours: 0, minutes: 59, seconds: 59 });
    expect(durationParts(3_661_000)).toEqual({ hours: 1, minutes: 1, seconds: 1 });
  });
});

describe("isValidDuration", () => {
  it("keeps the documented bounds", () => {
    expect(isValidDuration(1_000)).toBe(true);
    expect(isValidDuration(86_400_000)).toBe(true);
    expect(isValidDuration(999)).toBe(false);
    expect(isValidDuration(86_400_001)).toBe(false);
    expect(isValidDuration(1_500.5)).toBe(false);
  });
});

describe("labels", () => {
  it("counts characters instead of bytes", () => {
    expect(countCharacters("abc")).toBe(3);
    expect(countCharacters("😀")).toBe(1);
    expect(countCharacters("é")).toBe(1);
  });

  it("rejects labels that are too long or contain control characters", () => {
    expect(isValidLabel("a".repeat(MAX_LABEL_LENGTH))).toBe(true);
    expect(isValidLabel("a".repeat(MAX_LABEL_LENGTH + 1))).toBe(false);
    expect(isValidLabel("line\nbreak")).toBe(false);
    expect(isValidLabel("😀".repeat(MAX_LABEL_LENGTH))).toBe(true);
  });
});

describe("confirmedFocusTotals", () => {
  it("leaves interrupted sessions out until they are confirmed", () => {
    const records = [
      makeHistoryRecord({ phaseId: "a", durationMs: 25 * 60_000, interrupted: false }),
      makeHistoryRecord({ phaseId: "b", durationMs: 10 * 60_000, interrupted: true, confirmed: false }),
      makeHistoryRecord({ phaseId: "c", durationMs: 5 * 60_000, interrupted: true, confirmed: true }),
      makeHistoryRecord({ phaseId: "d", phase: "short_break", durationMs: 10 * 60_000 })
    ];

    expect(isConfirmedFocus(records[0] as never)).toBe(true);
    expect(isConfirmedFocus(records[1] as never)).toBe(false);
    expect(isConfirmedFocus(records[2] as never)).toBe(true);

    const totals = confirmedFocusTotals(records);
    expect(totals.sessions).toBe(2);
    expect(totals.totalMs).toBe(30 * 60_000);
    expect(totals.byDay).toHaveLength(1);
    expect(totals.byDay[0]?.localDate).toBe("2026-10-21");
    expect(totals.byDay[0]?.totalMs).toBe(30 * 60_000);
  });
});
