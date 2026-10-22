// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsView, isShortcutPattern } from "../../src/settings-view";
import type { Settings, SyncSummary, Theme } from "../../src/contract";
import { SHORTCUTS } from "../../src/shortcuts";
import { makeSettings } from "./helpers/fake-bridge";

interface Harness {
  view: SettingsView;
  saved: Settings[];
  saveError: string | null;
  previewed: Array<{ theme: Theme; textScale: number }>;
  previewedSounds: number[];
  /** What the folder picker returns; null stands for a cancelled picker. */
  chosenSyncDirectory: string | null;
  chooseSyncError: unknown;
  chooseSyncCalls: number;
  syncSummary: SyncSummary;
  syncError: unknown;
  syncCalls: number;
  /** When set, a sync request waits for this promise before it resolves. */
  syncGate: Promise<void> | null;
}

function build(capabilities: SettingsViewCapabilities = {}): Harness {
  const harness: Harness = {
    view: null as unknown as SettingsView,
    saved: [],
    saveError: null,
    previewed: [],
    previewedSounds: [],
    chosenSyncDirectory: null,
    chooseSyncError: null,
    chooseSyncCalls: 0,
    syncSummary: { directory: "", files: 0, written: 0, imported: 0, rejected: 0 },
    syncError: null,
    syncCalls: 0,
    syncGate: null
  };
  harness.view = new SettingsView(document, {
    capabilities,
    onSave: async (draft) => {
      if (harness.saveError) {
        return harness.saveError;
      }
      harness.saved.push(draft);
      return null;
    },
    onCancel: () => undefined,
    onPreview: (theme, textScale) => {
      harness.previewed.push({ theme, textScale });
    },
    onPreviewSound: (volumePercent) => {
      harness.previewedSounds.push(volumePercent);
    },
    onChooseSyncDirectory: async () => {
      harness.chooseSyncCalls += 1;
      if (harness.chooseSyncError) {
        throw harness.chooseSyncError;
      }
      return harness.chosenSyncDirectory;
    },
    onSyncSessions: async () => {
      harness.syncCalls += 1;
      if (harness.syncError) {
        throw harness.syncError;
      }
      if (harness.syncGate) {
        await harness.syncGate;
      }
      return { ...harness.syncSummary };
    },
    announce: () => undefined
  });
  return harness;
}

type SettingsViewCapabilities = Parameters<typeof SettingsView.prototype.updateCapabilities>[0];

function field<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) {
    throw new Error(`missing field ${selector}`);
  }
  return found;
}

beforeEach(() => {
  document.body.textContent = "";
});

describe("SettingsView", () => {
  it("fills the form from the settings and previews the theme", () => {
    const harness = build();
    harness.view.open(makeSettings({ theme: "dark", textScale: 1.5 }));

    expect(field<HTMLInputElement>("#focus-hours").value).toBe("0");
    expect(field<HTMLInputElement>("#focus-minutes").value).toBe("50");
    expect(field<HTMLInputElement>("#interval").value).toBe("4");
    expect(field<HTMLSelectElement>("#theme").value).toBe("dark");

    field<HTMLSelectElement>("#theme").value = "light";
    field<HTMLSelectElement>("#theme").dispatchEvent(new Event("change", { bubbles: true }));
    expect(harness.previewed.at(-1)?.theme).toBe("light");

    field<HTMLInputElement>("#text-scale").value = "1.5";
    field<HTMLInputElement>("#text-scale").dispatchEvent(new Event("input", { bubbles: true }));
    expect(harness.previewed.at(-1)?.textScale).toBe(1.5);
  });

  it("keeps the typed values when the dialog is reopened", () => {
    const harness = build();
    harness.view.open(makeSettings());
    const label = field<HTMLInputElement>("#label");
    label.value = "Deep work";
    label.dispatchEvent(new Event("input", { bubbles: true }));

    harness.view.open(makeSettings({ revision: 9 }));
    expect(field<HTMLInputElement>("#label").value).toBe("Deep work");
  });

  it("refuses a duration outside the accepted bounds and keeps the value", async () => {
    const harness = build();
    harness.view.open(makeSettings());

    const hours = field<HTMLInputElement>("#focus-hours");
    hours.value = "99";
    hours.dispatchEvent(new Event("input", { bubbles: true }));

    field<HTMLFormElement>(".settings-form").dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.saved).toHaveLength(0);
    expect(field<HTMLElement>("#focus-error").hasAttribute("hidden")).toBe(false);
    expect(field<HTMLElement>("#focus-error").textContent?.length).toBeGreaterThan(0);
    expect(hours.getAttribute("aria-invalid")).toBe("true");
    expect(hours.value).toBe("99");
  });

  it("saves a valid draft", async () => {
    const harness = build();
    harness.view.open(makeSettings());
    field<HTMLInputElement>("#focus-minutes").value = "25";
    field<HTMLInputElement>("#focus-minutes").dispatchEvent(new Event("input", { bubbles: true }));

    field<HTMLFormElement>(".settings-form").dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.saved).toHaveLength(1);
    expect(harness.saved[0]?.config.focusMs).toBe(25 * 60_000);
    expect(harness.saved[0]?.revision).toBe(3);
  });

  it("saves when the save button in the footer is pressed", async () => {
    const harness = build();
    harness.view.open(makeSettings());

    const save = document.querySelector<HTMLButtonElement>(".modal__footer .button--primary");
    expect(save).not.toBeNull();
    save?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.saved).toHaveLength(1);
    expect(harness.saved[0]?.config.focusMs).toBe(50 * 60_000);
  });

  it("shows the save failure and keeps the edits", async () => {
    const harness = build();
    harness.saveError = "the disk is read only";
    harness.view.open(makeSettings());

    const label = field<HTMLInputElement>("#label");
    label.value = "Deep work";
    label.dispatchEvent(new Event("input", { bubbles: true }));

    field<HTMLFormElement>(".settings-form").dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(field<HTMLElement>(".settings__error").textContent).toContain("the disk is read only");
    expect(field<HTMLInputElement>("#label").value).toBe("Deep work");
  });

  it("disables an option the desktop cannot support and explains why", () => {
    const harness = build({
      notifications: { state: "unavailable", reason: "There is no notification service." }
    });
    harness.view.open(makeSettings());

    const toggle = field<HTMLInputElement>("#notifications");
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute("aria-disabled")).toBe("true");
    expect(field<HTMLElement>("#notifications-note").textContent).toContain(
      "There is no notification service."
    );
  });

  it("keeps an option usable when the support is only unknown", () => {
    const harness = build({ sound: { state: "unknown", reason: "Not reported." } });
    harness.view.open(makeSettings());

    expect(field<HTMLInputElement>("#sound").disabled).toBe(false);
    expect(field<HTMLElement>("#sound-note").textContent).toContain("could not be verified");
  });

  it("asks before the unsaved edits are thrown away", async () => {
    const harness = build();
    harness.view.open(makeSettings());
    field<HTMLInputElement>("#label").value = "Deep work";
    field<HTMLInputElement>("#label").dispatchEvent(new Event("input", { bubbles: true }));

    const closing = harness.view.close();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.view.isDirty).toBe(true);
    const modals = document.querySelectorAll(".modal");
    expect(modals).toHaveLength(2);

    const guardButtons = modals[1]?.querySelectorAll<HTMLButtonElement>(".modal__footer button");
    guardButtons?.[1]?.click();
    await closing;
    expect(harness.view.isDirty).toBe(false);
  });
});

describe("local shortcut remapping", () => {
  function chord(init: KeyboardEventInit): KeyboardEvent {
    return new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  }

  async function submit(): Promise<void> {
    field<HTMLFormElement>(".settings-form").dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("lists every shortcut with its default binding", () => {
    const harness = build();
    harness.view.open(makeSettings());

    for (const spec of SHORTCUTS) {
      expect(document.querySelector(`#shortcut-${spec.id}`)).not.toBeNull();
    }
    expect(field<HTMLInputElement>("#shortcut-reset").value).toBe("Ctrl+Shift+R");
    expect(field<HTMLInputElement>("#shortcut-help").value).toBe("F1");
  });

  it("records a normalized chord and saves it with the settings", async () => {
    const harness = build();
    harness.view.open(makeSettings());

    const input = field<HTMLInputElement>("#shortcut-reset");
    input.dispatchEvent(chord({ key: "K", ctrlKey: true, shiftKey: true }));
    expect(input.value).toBe("Ctrl+Shift+K");
    expect(harness.view.isDirty).toBe(true);

    await submit();
    expect(harness.saved).toHaveLength(1);
    expect(harness.saved[0]?.localShortcuts).toEqual({ reset: "Ctrl+Shift+K" });
  });

  it("rejects a duplicate and keeps the previous binding", async () => {
    const harness = build();
    harness.view.open(makeSettings());

    const input = field<HTMLInputElement>("#shortcut-reset");
    input.dispatchEvent(chord({ key: "N", ctrlKey: true, shiftKey: true }));

    expect(input.value).toBe("Ctrl+Shift+R");
    const error = field<HTMLElement>("#shortcut-reset-error");
    expect(error.hasAttribute("hidden")).toBe(false);
    expect(error.textContent).toContain("already used");
    expect(input.getAttribute("aria-invalid")).toBe("true");

    await submit();
    expect(harness.saved[0]?.localShortcuts).toEqual({});
  });

  it("rejects a modifier-less letter and Escape clears the error", () => {
    const harness = build();
    harness.view.open(makeSettings());

    const input = field<HTMLInputElement>("#shortcut-reset");
    input.dispatchEvent(chord({ key: "M" }));
    expect(input.value).toBe("Ctrl+Shift+R");
    const error = field<HTMLElement>("#shortcut-reset-error");
    expect(error.textContent).toContain("Ctrl, Cmd or Alt");

    input.dispatchEvent(chord({ key: "Escape" }));
    expect(error.hasAttribute("hidden")).toBe(true);
    expect(input.getAttribute("aria-invalid")).toBeNull();
  });

  it("clears an override with Backspace and falls back to the default", async () => {
    const harness = build();
    harness.view.open(makeSettings({ localShortcuts: { next: "Ctrl+Alt+N" } }));

    const input = field<HTMLInputElement>("#shortcut-next");
    expect(input.value).toBe("Ctrl+Alt+N");

    input.dispatchEvent(chord({ key: "Backspace" }));
    expect(input.value).toBe("Ctrl+Shift+N");

    await submit();
    expect(harness.saved[0]?.localShortcuts).toEqual({});
  });

  it("resets one row and every row", async () => {
    const harness = build();
    harness.view.open(
      makeSettings({ localShortcuts: { reset: "Ctrl+Alt+R", next: "Ctrl+Alt+N" } })
    );

    field<HTMLElement>('[data-action="shortcut-reset-reset"]').click();
    expect(field<HTMLInputElement>("#shortcut-reset").value).toBe("Ctrl+Shift+R");
    expect(field<HTMLInputElement>("#shortcut-next").value).toBe("Ctrl+Alt+N");

    field<HTMLElement>('[data-action="shortcuts-reset-all"]').click();
    expect(field<HTMLInputElement>("#shortcut-next").value).toBe("Ctrl+Shift+N");

    await submit();
    expect(harness.saved[0]?.localShortcuts).toEqual({});
  });

  it("ignores an unreadable stored override and never drops the default", async () => {
    const harness = build();
    harness.view.open(makeSettings({ localShortcuts: { next: "N" } }));

    expect(field<HTMLInputElement>("#shortcut-next").value).toBe("Ctrl+Shift+N");

    await submit();
    expect(harness.saved[0]?.localShortcuts).toEqual({});
  });
});

describe("completion sound and auto-advance", () => {
  async function submit(): Promise<void> {
    field<HTMLFormElement>(".settings-form").dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("fills the volume and disables it while the sound is off", () => {
    const harness = build();
    harness.view.open(makeSettings({ sound: false, soundVolume: 40 }));

    expect(field<HTMLInputElement>("#sound-volume").value).toBe("40");
    expect(field<HTMLElement>("#sound-volume-output").textContent).toBe("40%");
    expect(field<HTMLInputElement>("#sound-volume").disabled).toBe(true);

    field<HTMLInputElement>("#sound").click();
    expect(field<HTMLInputElement>("#sound-volume").disabled).toBe(false);
  });

  it("previews the sound at the chosen volume even while the toggle is off", () => {
    const harness = build();
    harness.view.open(makeSettings({ sound: false, soundVolume: 60 }));

    const volume = field<HTMLInputElement>("#sound-volume");
    volume.value = "25";
    volume.dispatchEvent(new Event("input", { bubbles: true }));

    const preview = field<HTMLButtonElement>('[data-action="preview-sound"]');
    expect(preview.disabled).toBe(false);
    preview.click();

    expect(harness.previewedSounds).toEqual([25]);
    expect(field<HTMLElement>("#sound-volume-output").textContent).toBe("25%");
  });

  it("saves the volume and the auto-advance choice", async () => {
    const harness = build();
    harness.view.open(makeSettings());

    field<HTMLInputElement>("#sound").click();
    const volume = field<HTMLInputElement>("#sound-volume");
    volume.value = "35";
    volume.dispatchEvent(new Event("input", { bubbles: true }));
    field<HTMLInputElement>("#auto-advance").click();

    await submit();

    expect(harness.saved).toHaveLength(1);
    expect(harness.saved[0]?.sound).toBe(true);
    expect(harness.saved[0]?.soundVolume).toBe(35);
    expect(harness.saved[0]?.autoAdvance).toBe(true);
  });

  it("disables the volume and the preview when the desktop cannot play sound", () => {
    const harness = build({
      sound: { state: "unavailable", reason: "There is no audio device." }
    });
    harness.view.open(makeSettings({ sound: true }));

    expect(field<HTMLInputElement>("#sound-volume").disabled).toBe(true);
    expect(field<HTMLButtonElement>('[data-action="preview-sound"]').disabled).toBe(true);
  });
});

describe("session sync", () => {
  async function submit(): Promise<void> {
    field<HTMLFormElement>(".settings-form").dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("shows the saved folder and saves an edited one", async () => {
    const harness = build();
    harness.view.open(makeSettings({ syncDirectory: "/home/me/deepwork-log" }));

    const input = field<HTMLInputElement>("#sync-directory");
    expect(input.value).toBe("/home/me/deepwork-log");

    input.value = "/mnt/shared/deepwork";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await submit();

    expect(harness.saved).toHaveLength(1);
    expect(harness.saved[0]?.syncDirectory).toBe("/mnt/shared/deepwork");
  });

  it("refuses a relative folder inline and does not save", async () => {
    const harness = build();
    harness.view.open(makeSettings({ syncDirectory: "/home/me/deepwork-log" }));

    const input = field<HTMLInputElement>("#sync-directory");
    input.value = "relative/deepwork";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    const error = field<HTMLElement>("#sync-directory-error");
    expect(error.hasAttribute("hidden")).toBe(false);
    expect(error.textContent).toContain("absolute");
    expect(input.getAttribute("aria-invalid")).toBe("true");

    await submit();

    expect(harness.saved).toHaveLength(0);
    expect(input.value).toBe("relative/deepwork");
  });

  it("refuses a folder path that is too long", async () => {
    const harness = build();
    harness.view.open(makeSettings());

    const input = field<HTMLInputElement>("#sync-directory");
    input.value = `/${"x".repeat(4096)}`;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(field<HTMLElement>("#sync-directory-error").textContent).toContain("4096");

    await submit();
    expect(harness.saved).toHaveLength(0);
  });

  it("saves an empty folder, which switches sync off", async () => {
    const harness = build();
    harness.view.open(makeSettings({ syncDirectory: "/home/me/deepwork-log" }));

    const input = field<HTMLInputElement>("#sync-directory");
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await submit();

    expect(harness.saved).toHaveLength(1);
    expect(harness.saved[0]?.syncDirectory).toBe("");
  });

  it("fills the field from the picker and keeps it when the picker is cancelled", async () => {
    const harness = build();
    harness.view.open(makeSettings());
    const input = field<HTMLInputElement>("#sync-directory");
    const choose = field<HTMLButtonElement>('[data-action="choose-sync-directory"]');

    harness.chosenSyncDirectory = "/home/me/sync";
    choose.click();
    await settle();

    expect(harness.chooseSyncCalls).toBe(1);
    expect(input.value).toBe("/home/me/sync");
    expect(harness.view.isDirty).toBe(true);

    harness.chosenSyncDirectory = null;
    choose.click();
    await settle();

    expect(harness.chooseSyncCalls).toBe(2);
    expect(input.value).toBe("/home/me/sync");
  });

  it("syncs once and reports the written and imported counts", async () => {
    const harness = build();
    harness.syncSummary = {
      directory: "/home/me/sync",
      files: 5,
      written: 2,
      imported: 3,
      rejected: 0
    };
    harness.view.open(makeSettings({ syncDirectory: "/home/me/sync" }));

    field<HTMLButtonElement>('[data-action="sync-now"]').click();
    await settle();

    expect(harness.syncCalls).toBe(1);
    const status = field<HTMLElement>("#sync-status");
    expect(status.hasAttribute("hidden")).toBe(false);
    expect(status.textContent).toContain("Wrote 2 new files");
    expect(status.textContent).toContain("imported 3 sessions");
    expect(status.textContent).not.toContain("skipped");
  });

  it("mentions rejected files only when there are some", async () => {
    const harness = build();
    harness.syncSummary = {
      directory: "/home/me/sync",
      files: 4,
      written: 1,
      imported: 0,
      rejected: 2
    };
    harness.view.open(makeSettings({ syncDirectory: "/home/me/sync" }));

    field<HTMLButtonElement>('[data-action="sync-now"]').click();
    await settle();

    const status = field<HTMLElement>("#sync-status");
    expect(status.textContent).toContain("2 files were skipped");
  });

  it("shows a backend error and keeps the saved folder", async () => {
    const harness = build();
    harness.syncError = {
      code: "STORAGE_UNAVAILABLE",
      message: "The sync folder does not exist."
    };
    harness.view.open(makeSettings({ syncDirectory: "/home/me/sync" }));

    const button = field<HTMLButtonElement>('[data-action="sync-now"]');
    button.click();
    await settle();

    const error = field<HTMLElement>("#sync-error");
    expect(error.hasAttribute("hidden")).toBe(false);
    expect(error.textContent).toContain("The sync folder does not exist.");

    expect(field<HTMLInputElement>("#sync-directory").value).toBe("/home/me/sync");
    expect(button.disabled).toBe(false);
    expect(harness.view.isOpen).toBe(true);
    // The dialog still works: the folder is saved unchanged.
    await submit();
    expect(harness.saved).toHaveLength(1);
    expect(harness.saved[0]?.syncDirectory).toBe("/home/me/sync");
  });

  it("disables Sync now while the request is in flight", async () => {
    const harness = build();
    let release: () => void = () => undefined;
    harness.syncGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness.view.open(makeSettings({ syncDirectory: "/home/me/sync" }));

    const button = field<HTMLButtonElement>('[data-action="sync-now"]');
    button.click();
    await settle();

    expect(button.disabled).toBe(true);
    button.click();
    await settle();
    expect(harness.syncCalls).toBe(1);

    release();
    await settle();
    expect(button.disabled).toBe(false);
    expect(harness.syncCalls).toBe(1);
  });
});

describe("isShortcutPattern", () => {
  it("accepts a modifier combination and rejects a bare key", () => {
    expect(isShortcutPattern("CommandOrControl+Alt+Shift+Space")).toBe(true);
    expect(isShortcutPattern("Ctrl+K")).toBe(true);
    expect(isShortcutPattern("S")).toBe(false);
    expect(isShortcutPattern("")).toBe(false);
    expect(isShortcutPattern("Ctrl+")).toBe(false);
  });
});

describe("announce helper", () => {
  it("does not throw when a view is used without a live region", () => {
    const announce = vi.fn();
    const view = new SettingsView(document, {
      capabilities: {},
      onSave: async () => null,
      onCancel: () => undefined,
      onPreview: () => undefined,
      onPreviewSound: () => undefined,
      onChooseSyncDirectory: async () => null,
      onSyncSessions: async () => ({
        directory: "",
        files: 0,
        written: 0,
        imported: 0,
        rejected: 0
      }),
      announce
    });
    expect(view.isOpen).toBe(false);
    expect(announce).not.toHaveBeenCalled();
  });
});
