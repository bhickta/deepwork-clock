// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDemoBridge } from "../../src/demo-bridge";

describe("development preview bridge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts idle with the configured duration", async () => {
    const bridge = createDemoBridge();
    const snapshot = await bridge.getSnapshot();
    expect(snapshot.status).toBe("idle");
    expect(snapshot.remainingMs).toBe(50 * 60 * 1000);
    expect(snapshot.mode).toBe("cycle");
  });

  it("runs, pauses and resumes", async () => {
    const bridge = createDemoBridge();
    const idle = await bridge.getSnapshot();

    const running = await bridge.timerCommand({
      requestId: "1",
      expectedRevision: idle.revision,
      action: { type: "start" }
    });
    expect(running.status).toBe("running");

    const paused = await bridge.timerCommand({
      requestId: "2",
      expectedRevision: running.revision,
      action: { type: "pause" }
    });
    expect(paused.status).toBe("paused");
    expect(paused.remainingMs).toBeLessThanOrEqual(idle.remainingMs);

    const resumed = await bridge.timerCommand({
      requestId: "3",
      expectedRevision: paused.revision,
      action: { type: "resume" }
    });
    expect(resumed.status).toBe("running");
  });

  it("refuses to reconfigure a running phase", async () => {
    const bridge = createDemoBridge();
    const idle = await bridge.getSnapshot();
    await bridge.timerCommand({
      requestId: "1",
      expectedRevision: idle.revision,
      action: { type: "start" }
    });

    await expect(
      bridge.timerCommand({
        requestId: "2",
        expectedRevision: idle.revision + 1,
        action: {
          type: "configure",
          config: {
            mode: "cycle",
            focusMs: 25 * 60_000,
            shortBreakMs: 5 * 60_000,
            longBreakMs: 30 * 60_000,
            longBreakInterval: 4,
            label: ""
          }
        }
      })
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("completes a phase and offers the next one", async () => {
    const bridge = createDemoBridge();
    const settings = await bridge.getSettings();
    await bridge.saveSettings({
      expectedSettingsRevision: settings.revision,
      settings: {
        ...settings,
        config: { ...settings.config, focusMs: 1_000 }
      }
    });

    const idle = await bridge.getSnapshot();
    const configured = await bridge.timerCommand({
      requestId: "1",
      expectedRevision: idle.revision,
      action: {
        type: "configure",
        config: { ...settings.config, focusMs: 1_000 }
      }
    });
    expect(configured.durationMs).toBe(1_000);

    const running = await bridge.timerCommand({
      requestId: "2",
      expectedRevision: configured.revision,
      action: { type: "start" }
    });

    vi.advanceTimersByTime(1_200);
    await vi.advanceTimersByTimeAsync(0);

    const completed = await bridge.getSnapshot();
    expect(completed.status).toBe("completed");
    expect(completed.completedFocusCount).toBe(1);

    const advanced = await bridge.timerCommand({
      requestId: "3",
      expectedRevision: running.revision + 1,
      action: { type: "advance" }
    });
    expect(advanced.status).toBe("idle");
    expect(advanced.phase).toBe("short_break");
  });

  it("has no checkpoint unless the preview simulates an interruption", async () => {
    const bridge = createDemoBridge();
    expect(await bridge.getRecovery()).toBeNull();
  });

  it("offers a deterministic session sync without a native picker", async () => {
    const bridge = createDemoBridge();
    const settings = await bridge.getSettings();
    expect(settings.syncDirectory).toBe("");

    expect(await bridge.chooseSyncDirectory()).toBeNull();
    expect(await bridge.syncSessions()).toEqual({
      directory: "",
      files: 0,
      written: 0,
      imported: 0,
      rejected: 0
    });
  });

  it("offers a redacted diagnostics document", async () => {
    const bridge = createDemoBridge();
    const settings = await bridge.getSettings();
    expect(settings.soundVolume).toBe(60);
    expect(settings.autoAdvance).toBe(false);

    const diagnostics = JSON.parse(await bridge.getDiagnostics()) as {
      features: { sound: boolean; autoAdvance: boolean };
      timer: { status: string };
    };
    expect(diagnostics.features.sound).toBe(false);
    expect(diagnostics.features.autoAdvance).toBe(false);
    expect(diagnostics.timer.status).toBe("idle");
  });

  it("reports the checkpoint when the preview simulates an interruption", async () => {
    const bridge = createDemoBridge({ recovery: true });
    const snapshot = await bridge.getSnapshot();
    expect(snapshot.status).toBe("recovery_pending");

    const recovery = await bridge.getRecovery();
    expect(recovery).not.toBeNull();
    expect(recovery?.ageMs).toBeGreaterThan(0);
    expect(recovery?.remainingMs).toBeGreaterThan(0);
  });

  it("forgets the checkpoint when the session is resumed", async () => {
    const bridge = createDemoBridge({ recovery: true });
    const snapshot = await bridge.getSnapshot();
    await bridge.timerCommand({
      requestId: "1",
      expectedRevision: snapshot.revision,
      action: { type: "accept_recovery" }
    });
    expect(await bridge.getRecovery()).toBeNull();
  });

  it("reports a warning when the settings cannot be used", async () => {    const bridge = createDemoBridge();
    const settings = await bridge.getSettings();
    const warnings: unknown[] = [];
    await bridge.subscribeWarning((error) => warnings.push(error));

    await expect(
      bridge.saveSettings({
        expectedSettingsRevision: settings.revision,
        settings: { ...settings, config: { ...settings.config, focusMs: 0 } }
      })
    ).rejects.toMatchObject({ code: "INVALID_DURATION" });

    expect(warnings).toHaveLength(1);
    expect(await bridge.getWarnings()).toHaveLength(1);
  });
});
