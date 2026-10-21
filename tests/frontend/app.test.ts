// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../../src/app";
import { FakeBridge, makeSnapshot } from "./helpers/fake-bridge";

let app: App | null = null;

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function mount(bridge: FakeBridge): Promise<HTMLElement> {
  document.body.textContent = "";
  const root = document.createElement("div");
  document.body.appendChild(root);
  app = new App({ root, bridge });
  await app.start();
  return root;
}

function query(root: HTMLElement, selector: string): HTMLElement {
  const found = root.querySelector<HTMLElement>(selector);
  if (!found) {
    throw new Error(`missing element ${selector}`);
  }
  return found;
}

/** Open the overflow menu and pick one of its items. */
async function openMenuItem(root: HTMLElement, id: string): Promise<void> {
  query(root, '[data-action="menu"]').click();
  await flush();
  const item = document.querySelector<HTMLElement>(`[data-menu-item="${id}"]`);
  if (!item) {
    throw new Error(`missing menu item ${id}`);
  }
  item.click();
  await flush();
}

afterEach(() => {
  app?.dispose();
  app = null;
  document.body.textContent = "";
});

describe("timer surface", () => {
  it("shows the phase, the remaining time and an off live timer", async () => {
    const root = await mount(new FakeBridge());
    expect(query(root, ".phase-badge__text").textContent).toBe("Focus");
    expect(query(root, "#timer-digits").textContent).toBe("50:00");
    const timer = query(root, '[role="timer"]');
    expect(timer.getAttribute("aria-live")).toBe("off");
    expect(timer.getAttribute("aria-label")).toBe("Remaining time");
  });

  it("starts the timer with the current revision and a request id", async () => {
    const bridge = new FakeBridge();
    const root = await mount(bridge);
    query(root, '[data-action="primary"]').click();
    await flush();

    expect(bridge.commands).toHaveLength(1);
    expect(bridge.commands[0]?.action.type).toBe("start");
    expect(bridge.commands[0]?.expectedRevision).toBe(7);
    expect(bridge.commands[0]?.requestId.length).toBeGreaterThan(0);
  });

  it("pauses and resumes from the same primary control", async () => {
    const bridge = new FakeBridge();
    const root = await mount(bridge);
    const primary = query(root, '[data-action="primary"]');

    primary.click();
    await flush();
    expect(bridge.commands[0]?.action.type).toBe("start");
    expect(primary.textContent).toContain("Pause");

    primary.click();
    await flush();
    expect(bridge.commands[1]?.action.type).toBe("pause");
    expect(primary.textContent).toContain("Resume");
  });

  it("keeps the focus on the control while snapshots arrive", async () => {
    const bridge = new FakeBridge();
    const root = await mount(bridge);
    const primary = query(root, '[data-action="primary"]');
    primary.focus();

    bridge.publish(makeSnapshot({ revision: 8, status: "running", remainingMs: 40 * 60_000 }));
    bridge.publish(makeSnapshot({ revision: 9, status: "running", remainingMs: 39 * 60_000 }));

    expect(document.activeElement).toBe(primary);
    expect(query(root, "#timer-digits").textContent).toBe("39:00");
  });

  it("does not announce every published second", async () => {
    const bridge = new FakeBridge();
    const root = await mount(bridge);
    const live = query(root, "#live-region");

    bridge.publish(makeSnapshot({ revision: 8, status: "running" }));
    const afterStart = live.textContent;
    expect(afterStart?.length).toBeGreaterThan(0);

    bridge.publish(makeSnapshot({ revision: 9, status: "running", remainingMs: 1000 }));
    bridge.publish(makeSnapshot({ revision: 10, status: "running", remainingMs: 500 }));
    expect(live.textContent).toBe(afterStart);
  });

  it("ignores a snapshot with an older revision", async () => {
    const bridge = new FakeBridge();
    const root = await mount(bridge);

    bridge.publish(makeSnapshot({ revision: 30, status: "paused" }));
    expect(app?.currentSnapshot?.status).toBe("paused");

    bridge.publish(makeSnapshot({ revision: 4, status: "running" }));
    expect(app?.currentSnapshot?.status).toBe("paused");
    expect(query(root, ".timer-status").textContent).toBe("Paused");
  });

  it("starts the next phase from the completed state", async () => {
    const bridge = new FakeBridge({ snapshot: { status: "completed" } });
    const root = await mount(bridge);
    query(root, '[data-action="primary"]').click();
    await flush();

    expect(bridge.commands.map((command) => command.action.type)).toEqual(["advance", "start"]);
  });
});

describe("destructive actions", () => {
  it("does not offer a next phase while the timer is idle", async () => {
    const root = await mount(new FakeBridge());
    expect(query(root, '[data-action="skip"]').hasAttribute("hidden")).toBe(true);
  });

  it("offers the next phase while the timer runs and asks before it skips", async () => {
    const bridge = new FakeBridge({ snapshot: { status: "running" } });
    const root = await mount(bridge);
    expect(query(root, '[data-action="skip"]').hasAttribute("hidden")).toBe(false);

    query(root, '[data-action="skip"]').click();
    await flush();

    expect(document.querySelector(".modal")).not.toBeNull();
    expect(bridge.commands).toHaveLength(0);
  });

  it("offers the next phase after the phase completed", async () => {
    const root = await mount(new FakeBridge({ snapshot: { status: "completed" } }));
    expect(query(root, '[data-action="skip"]').hasAttribute("hidden")).toBe(false);
  });

  it("never offers a next phase in countdown mode", async () => {
    const root = await mount(new FakeBridge({ snapshot: { mode: "countdown" } }));
    expect(query(root, '[data-action="skip"]').hasAttribute("hidden")).toBe(true);
  });

  it("asks before a reset while the timer runs and cancels with Escape", async () => {
    const bridge = new FakeBridge({ snapshot: { status: "running" } });
    const root = await mount(bridge);

    query(root, '[data-action="reset"]').click();
    await flush();

    const dialog = document.querySelector(".modal");
    expect(dialog).not.toBeNull();
    expect(document.activeElement?.textContent).toBe("Cancel");

    dialog?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    );
    await flush();
    expect(bridge.commands).toHaveLength(0);
  });

  it("resets directly when the timer is idle", async () => {
    const bridge = new FakeBridge();
    const root = await mount(bridge);
    query(root, '[data-action="reset"]').click();
    await flush();
    expect(bridge.commands[0]?.action.type).toBe("reset");
    expect(document.querySelector(".modal")).toBeNull();
  });

  it("does not offer a next phase in countdown mode", async () => {
    const root = await mount(new FakeBridge({ snapshot: { mode: "countdown" } }));
    expect(query(root, '[data-action="skip"]').hasAttribute("hidden")).toBe(true);
  });
});

describe("failures", () => {
  it("shows the connection problem and hides the timer when the backend is gone", async () => {
    const bridge = new FakeBridge();
    bridge.getSnapshot = async () => {
      throw { code: "INTERNAL", message: "the bridge is not available" };
    };
    const root = await mount(bridge);

    expect(query(root, ".panel--fatal").hasAttribute("hidden")).toBe(false);
    expect(query(root, ".timer-panel").hasAttribute("hidden")).toBe(true);
    expect(query(root, ".recovery").hasAttribute("hidden")).toBe(true);
    expect(query(root, "#app-error").textContent).toContain("the bridge is not available");
  });

  it("shows the backend message and keeps the native bridge", async () => {
    const bridge = new FakeBridge();
    bridge.commandError = { code: "INTERNAL", message: "the engine refused" };
    const root = await mount(bridge);

    query(root, '[data-action="primary"]').click();
    await flush();

    expect(query(root, "#app-error").textContent).toContain("the engine refused");
    expect(root.querySelector(".banner")).toBeNull();
  });

  it("explains a capability that is not available instead of pretending", async () => {
    const bridge = new FakeBridge({
      capabilities: { pin: { state: "unavailable", reason: "Wayland owns window placement." } }
    });
    const root = await mount(bridge);

    query(root, '[data-action="pin"]').click();
    await flush();

    expect(bridge.windowActions).toHaveLength(0);
    expect(query(root, "#app-notice").textContent).toContain("Wayland owns window placement.");
  });

  it("sends the pin request when the desktop does not know whether it works", async () => {
    const bridge = new FakeBridge({
      capabilities: { pin: { state: "unknown", reason: "The compositor owns the placement." } }
    });
    const root = await mount(bridge);

    query(root, '[data-action="pin"]').click();
    await flush();

    expect(bridge.windowActions).toEqual(["pin"]);
    const notice = query(root, "#app-notice").textContent ?? "";
    expect(notice).toContain("Your desktop decides");
    expect(notice).not.toContain("pinned above");
  });

  it("does not send the pin request when the desktop refuses it", async () => {
    const bridge = new FakeBridge({
      capabilities: { pin: { state: "permission_required", reason: "A permission is missing." } }
    });
    const root = await mount(bridge);

    query(root, '[data-action="pin"]').click();
    await flush();

    expect(bridge.windowActions).toHaveLength(0);
    expect(query(root, "#app-notice").textContent).toContain("A permission is missing.");
  });
});

describe("recovery", () => {
  it("shows how old the recovered checkpoint is", async () => {
    const bridge = new FakeBridge({
      snapshot: { status: "recovery_pending", remainingMs: 12 * 60_000 }
    });
    bridge.recovery = {
      savedAt: "2026-10-21T09:00:00.000Z",
      ageMs: 4 * 60_000 + 20_000,
      phaseId: "phase-1",
      remainingMs: 12 * 60_000
    };
    const root = await mount(bridge);
    await flush();

    const detail = query(root, ".recovery__detail");
    expect(detail.hasAttribute("hidden")).toBe(false);
    expect(detail.textContent).toContain("4 minutes");
    expect(detail.textContent).toContain("12 minutes");
  });

  it("hides the checkpoint detail when the backend does not know it", async () => {
    const root = await mount(
      new FakeBridge({ snapshot: { status: "recovery_pending", remainingMs: 12 * 60_000 } })
    );
    await flush();
    expect(query(root, ".recovery__detail").hasAttribute("hidden")).toBe(true);
  });

  it("resumes the session when the user accepts it", async () => {
    const bridge = new FakeBridge({ snapshot: { status: "recovery_pending" } });
    const root = await mount(bridge);

    query(root, '[data-action="recovery-accept"]').click();
    await flush();
    expect(bridge.commands[0]?.action.type).toBe("accept_recovery");
  });
});

describe("preview mode", () => {
  it("shows the preview banner", async () => {
    const root = await mount(new FakeBridge({ kind: "demo" }));
    expect(query(root, ".banner").textContent).toBe("Browser preview — changes are not saved");
  });
});

describe("settings dialog", () => {
  it("keeps the draft when a snapshot arrives", async () => {
    const bridge = new FakeBridge();
    const root = await mount(bridge);

    await openMenuItem(root, "settings");

    const label = document.querySelector<HTMLInputElement>("#label");
    expect(label).not.toBeNull();
    if (!label) {
      throw new Error("missing label field");
    }
    label.value = "Deep work";
    label.dispatchEvent(new Event("input", { bubbles: true }));

    bridge.publish(makeSnapshot({ revision: 40, status: "running" }));

    expect(label.value).toBe("Deep work");
  });

  it("saves the draft through the backend", async () => {
    const bridge = new FakeBridge();
    const root = await mount(bridge);

    await openMenuItem(root, "settings");

    const form = document.querySelector<HTMLFormElement>(".settings-form");
    form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();

    expect(bridge.savedSettings).toHaveLength(1);
    expect(bridge.savedSettings[0]?.expectedSettingsRevision).toBe(3);
    expect(bridge.savedSettings[0]?.settings.config.focusMs).toBe(50 * 60_000);
  });

  it("keeps the edits when saving fails", async () => {
    const bridge = new FakeBridge();
    bridge.saveError = { code: "STORAGE_UNAVAILABLE", message: "the disk is read only" };
    const root = await mount(bridge);

    await openMenuItem(root, "settings");

    const label = document.querySelector<HTMLInputElement>("#label");
    if (!label) {
      throw new Error("missing label field");
    }
    label.value = "Deep work";
    label.dispatchEvent(new Event("input", { bubbles: true }));

    const form = document.querySelector<HTMLFormElement>(".settings-form");
    form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();

    expect(document.querySelector(".settings__error")?.textContent).toContain("the disk is read only");
    expect(label.value).toBe("Deep work");
    expect(document.querySelector(".modal")).not.toBeNull();
  });
});

describe("warnings", () => {
  it("subscribes before it fetches the warnings", async () => {
    const bridge = new FakeBridge();
    await mount(bridge);

    const subscribe = bridge.calls.indexOf("subscribeWarning");
    const fetch = bridge.calls.indexOf("getWarnings");
    expect(subscribe).toBeGreaterThanOrEqual(0);
    expect(fetch).toBeGreaterThanOrEqual(0);
    expect(subscribe).toBeLessThan(fetch);
  });

  it("shows the warnings that were already known at startup", async () => {
    const bridge = new FakeBridge();
    bridge.warnings.push({
      code: "STORAGE_UNAVAILABLE",
      message: "The settings could not be written to disk."
    });
    const root = await mount(bridge);

    const region = query(root, ".warnings");
    expect(region.getAttribute("role")).toBe("status");
    expect(region.hasAttribute("hidden")).toBe(false);
    expect(region.textContent).toContain("The settings could not be written to disk.");
  });

  it("shows a warning that arrives while the app runs and keeps the timer usable", async () => {
    const bridge = new FakeBridge();
    const root = await mount(bridge);

    expect(query(root, ".warnings").hasAttribute("hidden")).toBe(true);

    bridge.publishWarning({
      code: "STORAGE_UNAVAILABLE",
      message: "The session could not be saved."
    });
    await flush();

    expect(query(root, ".warnings").hasAttribute("hidden")).toBe(false);
    expect(query(root, ".warning__text").textContent).toBe("The session could not be saved.");

    // The warning never blocks the timer.
    query(root, '[data-action="primary"]').click();
    await flush();
    expect(bridge.commands[0]?.action.type).toBe("start");
  });

  it("keeps a warning until it is dismissed", async () => {
    const bridge = new FakeBridge();
    const root = await mount(bridge);

    bridge.publishWarning({ code: "STORAGE_UNAVAILABLE", message: "The disk is full." });
    await flush();
    expect(query(root, ".warning__text")).toBeTruthy();

    const dismiss = root.querySelector<HTMLButtonElement>(".warning__dismiss");
    dismiss?.click();
    await flush();

    expect(root.querySelector(".warning__text")).toBeNull();
    expect(query(root, ".warnings").hasAttribute("hidden")).toBe(true);
  });

  it("does not show the same warning twice", async () => {
    const bridge = new FakeBridge();
    const root = await mount(bridge);

    bridge.publishWarning({ code: "STORAGE_UNAVAILABLE", message: "The disk is full." });
    bridge.publishWarning({ code: "STORAGE_UNAVAILABLE", message: "The disk is full." });
    await flush();

    expect(root.querySelectorAll(".warning")).toHaveLength(1);
  });

  it("keeps a warning reachable from the compact view", async () => {
    const bridge = new FakeBridge();
    const root = await mount(bridge);

    bridge.publishWarning({ code: "STORAGE_UNAVAILABLE", message: "The disk is full." });
    await flush();

    const indicator = query(root, '[data-action="warnings"]');
    expect(indicator.hasAttribute("hidden")).toBe(false);
    expect(indicator.textContent).toContain("1");
    expect(indicator.getAttribute("aria-label")).toContain("warning");

    indicator.click();
    await flush();
    expect(document.querySelector(".modal")).not.toBeNull();
    expect(document.body.textContent).toContain("The disk is full.");
  });

  it("opens the warning details in a dialog that holds a status region", async () => {
    const bridge = new FakeBridge();
    const root = await mount(bridge);

    bridge.publishWarning({ code: "STORAGE_UNAVAILABLE", message: "The disk is full." });
    await flush();
    query(root, '[data-action="warnings"]').click();
    await flush();

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    const status = dialog?.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    expect(status?.textContent).toContain("The disk is full.");
  });
});

describe("history", () => {
  it("exports through the backend and reports the saved path", async () => {
    const bridge = new FakeBridge();
    bridge.exportResult = "/home/user/history.csv";
    const root = await mount(bridge);

    await openMenuItem(root, "history");
    const exportButton = document.querySelector<HTMLElement>('[data-action="export-csv"]');
    if (!exportButton) {
      throw new Error("missing export button");
    }
    exportButton.click();
    await flush();

    expect(bridge.exports).toEqual(["csv"]);
    expect(query(root, "#app-notice").textContent).toContain("/home/user/history.csv");
  });

  it("asks before deleting every record", async () => {
    const bridge = new FakeBridge();
    const root = await mount(bridge);

    await openMenuItem(root, "history");
    const deleteButton = document.querySelector<HTMLElement>('[data-action="delete-all"]');
    if (!deleteButton) {
      throw new Error("missing delete button");
    }
    deleteButton.click();
    await flush();

    expect(document.querySelector(".modal")).not.toBeNull();
    expect(bridge.deleteCalls).toBe(0);

    const confirm = document.querySelectorAll<HTMLButtonElement>(".modal__footer button")[1];
    confirm?.click();
    await flush();
    expect(bridge.deleteCalls).toBe(1);
  });
});
