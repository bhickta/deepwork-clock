// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../../src/app";
import { FakeBridge } from "./helpers/fake-bridge";

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

function key(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
}

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

describe("floating view", () => {
  it("sends one float request and mirrors the compact and pinned state", async () => {
    const bridge = new FakeBridge();
    const root = await mount(bridge);
    const floatButton = query(root, '[data-action="float"]');
    const compactButton = query(root, '[data-action="compact"]');
    const pinButton = query(root, '[data-action="pin"]');

    expect(floatButton.getAttribute("aria-pressed")).toBe("false");
    expect(floatButton.title).toBe("Floating compact view");

    floatButton.click();
    await flush();

    expect(bridge.windowActions).toEqual(["float"]);
    expect(root.getAttribute("data-view")).toBe("compact");
    expect(pinButton.getAttribute("aria-pressed")).toBe("true");
    expect(floatButton.getAttribute("aria-pressed")).toBe("true");
    expect(floatButton.title).toBe("Leave the floating view");
    expect(compactButton.title).toBe("Expanded view");

    floatButton.click();
    await flush();

    expect(bridge.windowActions).toEqual(["float", "unfloat"]);
    expect(root.getAttribute("data-view")).toBe("normal");
    expect(pinButton.getAttribute("aria-pressed")).toBe("false");
    expect(floatButton.getAttribute("aria-pressed")).toBe("false");
    expect(floatButton.title).toBe("Floating compact view");
    expect(compactButton.title).toBe("Compact view");
  });

  it("derives the floating state from the compact and pin controls", async () => {
    const bridge = new FakeBridge();
    const root = await mount(bridge);
    const floatButton = query(root, '[data-action="float"]');

    query(root, '[data-action="pin"]').click();
    await flush();
    expect(bridge.windowActions).toEqual(["pin"]);
    // Pinned but expanded is not the floating view.
    expect(floatButton.getAttribute("aria-pressed")).toBe("false");

    query(root, '[data-action="compact"]').click();
    await flush();
    // A compact click sends exactly one window request, never two.
    expect(bridge.windowActions).toEqual(["pin", "compact"]);
    expect(floatButton.getAttribute("aria-pressed")).toBe("true");

    query(root, '[data-action="pin"]').click();
    await flush();
    expect(bridge.windowActions).toEqual(["pin", "compact", "unpin"]);
    expect(floatButton.getAttribute("aria-pressed")).toBe("false");
  });

  it("does not request the floating view when pin support is missing", async () => {
    const bridge = new FakeBridge({
      capabilities: {
        pin: { state: "permission_required", reason: "A permission is missing." }
      }
    });
    const root = await mount(bridge);
    const floatButton = query(root, '[data-action="float"]');

    floatButton.click();
    await flush();

    expect(bridge.windowActions).toHaveLength(0);
    expect(root.getAttribute("data-view")).toBe("normal");
    expect(floatButton.getAttribute("aria-pressed")).toBe("false");
    expect(floatButton.getAttribute("aria-disabled")).toBe("true");
    expect(query(root, "#app-notice").textContent).toContain("A permission is missing.");
  });

  it("does not request the floating view on a desktop without pinning", async () => {
    const bridge = new FakeBridge({
      capabilities: {
        pin: { state: "unavailable", reason: "Wayland owns window placement." }
      }
    });
    const root = await mount(bridge);

    query(root, '[data-action="float"]').click();
    await flush();

    expect(bridge.windowActions).toHaveLength(0);
    expect(root.getAttribute("data-view")).toBe("normal");
    expect(query(root, "#app-notice").textContent).toContain("Wayland owns window placement.");
  });

  it("toggles the floating view from the keyboard shortcut", async () => {
    const bridge = new FakeBridge();
    const root = await mount(bridge);

    root.dispatchEvent(key({ key: "f", ctrlKey: true, shiftKey: true }));
    await flush();
    expect(bridge.windowActions).toEqual(["float"]);
    expect(root.getAttribute("data-view")).toBe("compact");

    root.dispatchEvent(key({ key: "f", ctrlKey: true, shiftKey: true }));
    await flush();
    expect(bridge.windowActions).toEqual(["float", "unfloat"]);
    expect(root.getAttribute("data-view")).toBe("normal");
  });

  it("resets the window position from the application menu", async () => {
    const bridge = new FakeBridge();
    const root = await mount(bridge);

    await openMenuItem(root, "restore-window");

    expect(bridge.windowActions).toEqual(["restore"]);
    expect(query(root, "#app-notice").textContent).toContain("restored");
  });
});
