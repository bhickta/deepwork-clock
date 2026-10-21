// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  SHORTCUTS,
  chordFromEvent,
  describeShortcut,
  effectiveShortcut,
  formatShortcut,
  installShortcuts,
  isEditableTarget,
  isMacPlatform,
  isNativeSpaceActivator,
  matchShortcut,
  normalizeLocalShortcuts,
  validateShortcutChord
} from "../../src/shortcuts";

function spec(id: string) {
  const found = SHORTCUTS.find((entry) => entry.id === id);
  if (!found) {
    throw new Error(`missing shortcut ${id}`);
  }
  return found;
}

function keyEvent(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
}

describe("matchShortcut", () => {
  it("matches the primary modifier of the platform", () => {
    const reset = spec("reset");
    expect(matchShortcut(keyEvent({ key: "R", ctrlKey: true, shiftKey: true }), reset, false)).toBe(true);
    expect(matchShortcut(keyEvent({ key: "R", metaKey: true, shiftKey: true }), reset, false)).toBe(false);
    expect(matchShortcut(keyEvent({ key: "R", metaKey: true, shiftKey: true }), reset, true)).toBe(true);
    expect(matchShortcut(keyEvent({ key: "R", ctrlKey: true, shiftKey: true }), reset, true)).toBe(false);
  });

  it("does not match without the expected modifiers", () => {
    const reset = spec("reset");
    expect(matchShortcut(keyEvent({ key: "r" }), reset, false)).toBe(false);
    expect(matchShortcut(keyEvent({ key: "r", ctrlKey: true }), reset, false)).toBe(false);
    expect(matchShortcut(keyEvent({ key: "r", ctrlKey: true, shiftKey: true, altKey: true }), reset, false)).toBe(
      false
    );
  });

  it("ignores key repeat and composition", () => {
    const reset = spec("reset");
    const repeated = keyEvent({ key: "r", ctrlKey: true, shiftKey: true, repeat: true });
    expect(matchShortcut(repeated, reset, false)).toBe(false);

    const composing = keyEvent({ key: "r", ctrlKey: true, shiftKey: true });
    Object.defineProperty(composing, "isComposing", { value: true });
    expect(matchShortcut(composing, reset, false)).toBe(false);
  });

  it("matches space and function keys", () => {
    expect(matchShortcut(keyEvent({ key: " ", code: "Space" }), spec("toggle-timer"), false)).toBe(true);
    expect(matchShortcut(keyEvent({ key: "F1" }), spec("help"), false)).toBe(true);
    expect(matchShortcut(keyEvent({ key: ",", ctrlKey: true }), spec("settings"), false)).toBe(true);
  });
});

describe("describeShortcut", () => {
  it("uses the platform modifier", () => {
    expect(describeShortcut(spec("reset"), false)).toBe("Ctrl+Shift+R");
    expect(describeShortcut(spec("toggle-timer"), false)).toBe("Space");
    expect(describeShortcut(spec("reset"), true)).toContain("R");
  });
});

describe("chordFromEvent", () => {
  it("normalizes modifiers, letters, Space and function keys", () => {
    expect(chordFromEvent(keyEvent({ key: "M", ctrlKey: true, shiftKey: true }), false)).toBe(
      "Ctrl+Shift+M"
    );
    expect(chordFromEvent(keyEvent({ key: "m", metaKey: true, shiftKey: true }), true)).toBe(
      "Cmd+Shift+M"
    );
    expect(chordFromEvent(keyEvent({ key: " ", code: "Space", ctrlKey: true }), false)).toBe(
      "Ctrl+Space"
    );
    expect(chordFromEvent(keyEvent({ key: "F1" }), false)).toBe("F1");
    expect(chordFromEvent(keyEvent({ key: "F12", altKey: true }), false)).toBe("Alt+F12");
  });

  it("ignores modifier-only presses, Tab and unrepresentable modifiers", () => {
    expect(chordFromEvent(keyEvent({ key: "Shift", shiftKey: true }), false)).toBeNull();
    expect(chordFromEvent(keyEvent({ key: "Control", ctrlKey: true }), false)).toBeNull();
    expect(chordFromEvent(keyEvent({ key: "Tab" }), false)).toBeNull();
    // The Windows key is not modelled by this frontend.
    expect(chordFromEvent(keyEvent({ key: "M", metaKey: true }), false)).toBeNull();
    // On macOS the primary modifier is Command, not Ctrl.
    expect(chordFromEvent(keyEvent({ key: "M", ctrlKey: true }), true)).toBeNull();
    expect(chordFromEvent(keyEvent({ key: "Enter" }), false)).toBeNull();
  });
});

describe("validateShortcutChord", () => {
  it("rejects duplicates of another action, including remaps", () => {
    expect(validateShortcutChord("Ctrl+Shift+R", "next", {})).toBe("duplicate");
    expect(
      validateShortcutChord("Ctrl+Alt+K", "next", { reset: "Ctrl+Alt+K" })
    ).toBe("duplicate");
  });

  it("rejects a bare key but accepts a function key", () => {
    expect(validateShortcutChord("M", "reset", {})).toBe("bare");
    expect(validateShortcutChord("Shift+M", "reset", {})).toBe("bare");
    expect(validateShortcutChord("F2", "reset", {})).toBeNull();
  });

  it("rejects reserved combinations and keys this app cannot record", () => {
    expect(validateShortcutChord("Alt+F4", "reset", {})).toBe("reserved");
    expect(validateShortcutChord("Ctrl+Alt+Delete", "reset", {})).toBe("reserved");
    expect(validateShortcutChord("Meta+M", "reset", {})).toBe("unsupported");
    expect(validateShortcutChord("nothing", "reset", {})).toBe("unsupported");
  });
});

describe("local shortcut overrides", () => {
  it("applies a valid override and falls back on an unreadable one", () => {
    const reset = spec("reset");
    const overridden = effectiveShortcut(reset, { reset: "Ctrl+Alt+K" });
    expect(overridden).toMatchObject({ key: "k", primary: true, shift: false, alt: true });
    expect(formatShortcut(overridden, false)).toBe("Ctrl+Alt+K");
    expect(formatShortcut(overridden, true)).toBe("Cmd+Alt+K");
    expect(effectiveShortcut(reset, { reset: "not a shortcut" })).toBe(reset);
    expect(effectiveShortcut(reset, { reset: "abcdefghij".repeat(7) })).toBe(reset);
  });

  it("keeps only valid overrides that differ from the default", () => {
    expect(
      normalizeLocalShortcuts(
        {
          reset: "Ctrl+Shift+R",
          next: "Ctrl+Alt+N",
          help: "Ctrl+Shift+R",
          compact: "M"
        },
        false
      )
    ).toEqual({ next: "Ctrl+Alt+N" });
  });
});

describe("isEditableTarget", () => {
  it("recognises text entry controls", () => {
    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    const select = document.createElement("select");
    const button = document.createElement("button");
    expect(isEditableTarget(input)).toBe(true);
    expect(isEditableTarget(textarea)).toBe(true);
    expect(isEditableTarget(select)).toBe(true);
    expect(isEditableTarget(button)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe("isNativeSpaceActivator", () => {
  it("recognises controls that use space themselves", () => {
    const button = document.createElement("button");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    const text = document.createElement("input");
    expect(isNativeSpaceActivator(button)).toBe(true);
    expect(isNativeSpaceActivator(checkbox)).toBe(true);
    expect(isNativeSpaceActivator(text)).toBe(false);
  });
});

describe("installShortcuts", () => {
  let container: HTMLElement;
  let handlers: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    document.body.textContent = "";
    container = document.createElement("div");
    document.body.appendChild(container);
    handlers = {
      "toggle-timer": vi.fn(),
      reset: vi.fn(),
      next: vi.fn(),
      compact: vi.fn(),
      float: vi.fn(),
      pin: vi.fn(),
      settings: vi.fn(),
      help: vi.fn(),
      announce: vi.fn()
    };
  });

  it("runs the handler for a matching shortcut", () => {
    installShortcuts(container, handlers as never, false);
    container.dispatchEvent(keyEvent({ key: "r", ctrlKey: true, shiftKey: true }));
    expect(handlers["reset"]).toHaveBeenCalledTimes(1);
  });

  it("ignores shortcuts while a text field has focus", () => {
    const input = document.createElement("input");
    container.appendChild(input);
    installShortcuts(container, handlers as never, false);
    input.focus();
    input.dispatchEvent(keyEvent({ key: "r", ctrlKey: true, shiftKey: true }));
    expect(handlers["reset"]).not.toHaveBeenCalled();
  });

  it("ignores key repeat", () => {
    installShortcuts(container, handlers as never, false);
    container.dispatchEvent(keyEvent({ key: " ", code: "Space", repeat: true }));
    expect(handlers["toggle-timer"]).not.toHaveBeenCalled();
  });

  it("does not trigger the timer when a button uses space itself", () => {
    const button = document.createElement("button");
    container.appendChild(button);
    installShortcuts(container, handlers as never, false);
    button.focus();
    button.dispatchEvent(keyEvent({ key: " ", code: "Space" }));
    expect(handlers["toggle-timer"]).not.toHaveBeenCalled();
  });

  it("triggers the timer from a plain surface", () => {
    installShortcuts(container, handlers as never, false);
    container.dispatchEvent(keyEvent({ key: " ", code: "Space" }));
    expect(handlers["toggle-timer"]).toHaveBeenCalledTimes(1);
  });

  it("removes the listener when disposed", () => {
    const dispose = installShortcuts(container, handlers as never, false);
    dispose();
    container.dispatchEvent(keyEvent({ key: "r", ctrlKey: true, shiftKey: true }));
    expect(handlers["reset"]).not.toHaveBeenCalled();
  });

  it("uses a remapped binding and stops using the default", () => {
    installShortcuts(container, handlers as never, false, { reset: "Ctrl+Alt+R" });
    container.dispatchEvent(keyEvent({ key: "R", ctrlKey: true, shiftKey: true }));
    expect(handlers["reset"]).not.toHaveBeenCalled();

    container.dispatchEvent(keyEvent({ key: "R", ctrlKey: true, altKey: true }));
    expect(handlers["reset"]).toHaveBeenCalledTimes(1);
  });

  it("reads a getter so a saved remap applies without reinstalling", () => {
    let overrides: Record<string, string> = {};
    installShortcuts(container, handlers as never, false, () => overrides);

    container.dispatchEvent(keyEvent({ key: "R", ctrlKey: true, shiftKey: true }));
    expect(handlers["reset"]).toHaveBeenCalledTimes(1);

    overrides = { reset: "Ctrl+Alt+R" };
    container.dispatchEvent(keyEvent({ key: "R", ctrlKey: true, shiftKey: true }));
    expect(handlers["reset"]).toHaveBeenCalledTimes(1);

    container.dispatchEvent(keyEvent({ key: "R", ctrlKey: true, altKey: true }));
    expect(handlers["reset"]).toHaveBeenCalledTimes(2);
  });
});

describe("isMacPlatform", () => {
  it("detects macOS from the navigator", () => {
    expect(isMacPlatform({ platform: "MacIntel", userAgent: "" } as Navigator)).toBe(true);
    expect(isMacPlatform({ platform: "Linux x86_64", userAgent: "" } as Navigator)).toBe(false);
  });
});
