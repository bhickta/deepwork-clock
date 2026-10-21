// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Menu } from "../../src/menu";

interface Harness {
  menu: Menu;
  button: HTMLButtonElement;
  selected: string[];
}

function build(): Harness {
  document.body.textContent = "";
  const harness: Harness = {
    menu: null as unknown as Menu,
    button: null as unknown as HTMLButtonElement,
    selected: []
  };
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "More";
  document.body.appendChild(button);
  harness.button = button;
  harness.menu = new Menu({
    doc: document,
    button,
    label: "More options",
    items: [
      { id: "settings", label: "Settings", onSelect: () => harness.selected.push("settings") },
      {
        id: "shortcuts",
        label: "Keyboard shortcuts",
        hint: "F1",
        onSelect: () => harness.selected.push("shortcuts")
      },
      { id: "about", label: "About", onSelect: () => harness.selected.push("about") }
    ]
  });
  return harness;
}

function items(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
}

beforeEach(() => {
  document.body.textContent = "";
});

describe("Menu", () => {
  it("marks the button as a menu button", () => {
    const harness = build();
    expect(harness.button.getAttribute("aria-haspopup")).toBe("menu");
    expect(harness.button.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens on click and focuses the first item", () => {
    const harness = build();
    harness.button.click();

    expect(harness.menu.isOpen).toBe(true);
    expect(harness.button.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(items()[0]);
  });

  it("moves between the items with the arrow keys", () => {
    const harness = build();
    harness.button.click();
    const list = items();

    list[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(list[1]);

    list[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(document.activeElement).toBe(list[2]);

    list[2]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(list[0]);
  });

  it("closes on Escape and gives the focus back to the button", () => {
    const harness = build();
    harness.button.click();
    document.querySelector(".menu")?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    );

    expect(harness.menu.isOpen).toBe(false);
    expect(document.querySelector(".menu")).toBeNull();
    expect(document.activeElement).toBe(harness.button);
  });

  it("runs the action of the chosen item and closes", () => {
    const harness = build();
    harness.button.click();
    items()[1]?.click();

    expect(harness.selected).toEqual(["shortcuts"]);
    expect(harness.menu.isOpen).toBe(false);
    expect(harness.button.getAttribute("aria-expanded")).toBe("false");
  });

  it("closes when the pointer goes somewhere else", () => {
    const harness = build();
    harness.button.click();
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(harness.menu.isOpen).toBe(false);
  });

  it("shows the hint of an item", () => {
    const harness = build();
    harness.button.click();
    expect(items()[1]?.querySelector(".menu__hint")?.textContent).toBe("F1");
  });

  it("can be opened with the arrow key on the button", () => {
    const harness = build();
    harness.button.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(harness.menu.isOpen).toBe(true);
  });

  it("does nothing when it is closed and asked to close", () => {
    const harness = build();
    const focus = vi.fn();
    harness.button.focus();
    harness.menu.closeMenu();
    expect(harness.menu.isOpen).toBe(false);
    expect(focus).not.toHaveBeenCalled();
  });
});
