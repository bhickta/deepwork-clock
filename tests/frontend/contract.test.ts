import { describe, expect, it } from "vitest";

import {
  ContractError,
  isAppError,
  parseCapabilities,
  parseHistoryRecords,
  parseSettings,
  parseSnapshot
} from "../../src/contract";
import { makeHistoryRecord, makeSettings, makeSnapshot } from "./helpers/fake-bridge";

describe("parseSnapshot", () => {
  it("accepts a valid snapshot and ignores unknown fields", () => {
    const snapshot = parseSnapshot({ ...makeSnapshot(), somethingNew: true });
    expect(snapshot.revision).toBe(7);
    expect(snapshot.status).toBe("idle");
    expect(snapshot.mode).toBe("cycle");
  });

  it("refuses an unknown schema version", () => {
    expect(() => parseSnapshot({ ...makeSnapshot(), schemaVersion: 2 })).toThrow(ContractError);
    expect(() => parseSnapshot({ ...makeSnapshot(), schemaVersion: "1" })).toThrow(ContractError);
  });

  it("refuses values it cannot understand", () => {
    expect(() => parseSnapshot({ ...makeSnapshot(), status: "melting" })).toThrow(ContractError);
    expect(() => parseSnapshot({ ...makeSnapshot(), remainingMs: -1 })).toThrow(ContractError);
    expect(() => parseSnapshot({ ...makeSnapshot(), revision: 1.5 })).toThrow(ContractError);
    expect(() => parseSnapshot(null)).toThrow(ContractError);
  });

  it("keeps null identifiers as null", () => {
    const snapshot = parseSnapshot({ ...makeSnapshot(), sessionId: null, phaseId: null });
    expect(snapshot.sessionId).toBeNull();
    expect(snapshot.phaseId).toBeNull();
  });
});

describe("parseSettings", () => {
  it("accepts valid settings", () => {
    const settings = parseSettings(makeSettings());
    expect(settings.revision).toBe(3);
    expect(settings.config.focusMs).toBe(50 * 60_000);
    expect(settings.retentionDays).toBe(90);
  });

  it("refuses an unknown schema version", () => {
    expect(() => parseSettings({ ...makeSettings(), schemaVersion: 7 })).toThrow(ContractError);
  });

  it("refuses an unknown theme", () => {
    expect(() => parseSettings({ ...makeSettings(), theme: "neon" })).toThrow(ContractError);
  });

  it("reads the local shortcut overrides", () => {
    const settings = parseSettings(
      makeSettings({ localShortcuts: { next: "Ctrl+Alt+N" } })
    );
    expect(settings.localShortcuts).toEqual({ next: "Ctrl+Alt+N" });
  });

  it("treats a missing override map as no overrides", () => {
    const raw: Record<string, unknown> = { ...makeSettings() };
    delete raw["localShortcuts"];
    expect(parseSettings(raw).localShortcuts).toEqual({});
  });

  it("refuses an override that is not a string or is too long", () => {
    expect(() =>
      parseSettings({ ...makeSettings(), localShortcuts: { next: 3 } })
    ).toThrow(ContractError);
    expect(() =>
      parseSettings({ ...makeSettings(), localShortcuts: { next: "x".repeat(65) } })
    ).toThrow(ContractError);
  });
});

describe("parseCapabilities", () => {
  it("reads the capability map", () => {
    const capabilities = parseCapabilities({
      pin: { state: "unavailable", reason: "Wayland compositors own placement." },
      tray: { state: "available", reason: "" }
    });
    expect(capabilities["pin"]?.state).toBe("unavailable");
    expect(capabilities["tray"]?.state).toBe("available");
  });

  it("turns an unreadable entry into unknown instead of guessing", () => {
    const capabilities = parseCapabilities({ pin: { state: "maybe", reason: "" } });
    expect(capabilities["pin"]?.state).toBe("unknown");
    expect(capabilities["pin"]?.reason.length).toBeGreaterThan(0);
  });
});

describe("parseHistoryRecords", () => {
  it("parses a list of records", () => {
    const records = parseHistoryRecords([makeHistoryRecord()]);
    expect(records).toHaveLength(1);
    expect(records[0]?.phaseId).toBe("phase-1");
  });

  it("refuses anything that is not a list", () => {
    expect(() => parseHistoryRecords({})).toThrow(ContractError);
  });
});

describe("isAppError", () => {
  it("recognises structured bridge errors", () => {
    expect(isAppError({ code: "STALE_REVISION", message: "too old" })).toBe(true);
    expect(isAppError({ message: "no code" })).toBe(false);
    expect(isAppError(new Error("boom"))).toBe(false);
  });
});
