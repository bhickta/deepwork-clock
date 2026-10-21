/**
 * Local (in window) keyboard shortcuts.
 *
 * The rules come from the shortcut contract in the plan:
 *  - shortcuts are ignored while a text field has focus or during IME input;
 *  - key repeat is ignored so one press cannot pause and immediately resume;
 *  - Space keeps its native meaning on a focused button.
 */
export interface ShortcutSpec {
  readonly id: string;
  readonly label: string;
  /** Lower case key, or `space` / `f1` style names. */
  readonly key: string;
  /** Requires the primary modifier (Command on macOS, Ctrl elsewhere). */
  readonly primary?: boolean;
  readonly shift?: boolean;
  readonly alt?: boolean;
}

export const SHORTCUTS: readonly ShortcutSpec[] = [
  { id: "toggle-timer", label: "Start, pause or resume", key: "space" },
  { id: "reset", label: "Reset the current phase", key: "r", primary: true, shift: true },
  { id: "next", label: "Skip to the next phase", key: "n", primary: true, shift: true },
  { id: "compact", label: "Compact or expanded view", key: "m", primary: true, shift: true },
  { id: "pin", label: "Pin the window above others", key: "p", primary: true, shift: true },
  { id: "settings", label: "Open settings", key: ",", primary: true },
  { id: "help", label: "Show the keyboard shortcuts", key: "f1" },
  { id: "announce", label: "Announce the remaining time", key: "t", primary: true, shift: true }
];

export type ShortcutHandlerId =
  | "toggle-timer"
  | "reset"
  | "next"
  | "compact"
  | "pin"
  | "settings"
  | "help"
  | "announce";

export type ShortcutHandlers = Record<ShortcutHandlerId, () => void>;

/** True on macOS, where the primary modifier is Command. */
export function isMacPlatform(nav: Navigator | undefined = typeof navigator === "undefined" ? undefined : navigator): boolean {
  if (!nav) {
    return false;
  }
  const platform = nav.platform ?? "";
  const userAgent = nav.userAgent ?? "";
  return /Mac|iPhone|iPad|iPod/i.test(platform) || /Macintosh|Mac OS X/i.test(userAgent);
}

/** True when the element accepts typed text and shortcuts must not fire. */
export function isEditableTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element || typeof element.tagName !== "string") {
    return false;
  }
  const tag = element.tagName.toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
    return true;
  }
  if (element.isContentEditable === true) {
    return true;
  }
  const role = element.getAttribute("role");
  return role === "textbox" || role === "searchbox" || role === "combobox" || role === "spinbutton";
}

/**
 * True when the focused element handles Space itself.
 *
 * A focused button must activate once, so the timer shortcut stands down.
 */
export function isNativeSpaceActivator(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element || typeof element.tagName !== "string") {
    return false;
  }
  const tag = element.tagName.toUpperCase();
  if (tag === "BUTTON" || tag === "A" || tag === "SUMMARY") {
    return true;
  }
  if (tag === "INPUT") {
    const type = (element.getAttribute("type") ?? "text").toLowerCase();
    return type === "button" || type === "submit" || type === "reset" || type === "checkbox" || type === "radio";
  }
  const role = element.getAttribute("role");
  return role === "button" || role === "link" || role === "menuitem" || role === "checkbox" || role === "switch";
}

function keyMatches(event: KeyboardEvent, key: string): boolean {
  if (key === "space") {
    return event.code === "Space" || event.key === " " || event.key === "Spacebar";
  }
  if (key.length === 1) {
    return event.key.toLowerCase() === key;
  }
  return event.key.toLowerCase() === key;
}

/** True when the keyboard event matches the shortcut definition. */
export function matchShortcut(
  event: KeyboardEvent,
  spec: ShortcutSpec,
  isMac: boolean
): boolean {
  if (event.repeat || event.isComposing) {
    return false;
  }
  if (event.altKey !== Boolean(spec.alt)) {
    return false;
  }
  if (event.shiftKey !== Boolean(spec.shift)) {
    return false;
  }
  const primaryPressed = isMac ? event.metaKey : event.ctrlKey;
  const otherPressed = isMac ? event.ctrlKey : event.metaKey;
  if (spec.primary) {
    if (!primaryPressed || otherPressed) {
      return false;
    }
  } else if (primaryPressed || otherPressed) {
    return false;
  }
  return keyMatches(event, spec.key);
}

/** Human readable key combination, for tooltips and the help dialog. */
export function describeShortcut(spec: ShortcutSpec, isMac: boolean): string {
  const parts: string[] = [];
  if (spec.primary) {
    parts.push(isMac ? "⌘" : "Ctrl");
  }
  if (spec.alt) {
    parts.push(isMac ? "⌥" : "Alt");
  }
  if (spec.shift) {
    parts.push(isMac ? "⇧" : "Shift");
  }
  if (spec.key === "space") {
    parts.push("Space");
  } else if (spec.key.length === 1) {
    parts.push(spec.key.toUpperCase());
  } else {
    parts.push(spec.key.toUpperCase());
  }
  return parts.join(isMac ? "" : "+");
}

/**
 * Install the local shortcuts on a container element.
 *
 * Returns a function that removes the listener again.
 */
export function installShortcuts(
  target: HTMLElement,
  handlers: ShortcutHandlers,
  isMac: boolean = isMacPlatform()
): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented) {
      return;
    }
    if (event.isComposing) {
      return;
    }
    if (isEditableTarget(event.target)) {
      return;
    }
    for (const spec of SHORTCUTS) {
      if (!matchShortcut(event, spec, isMac)) {
        continue;
      }
      if (spec.id === "toggle-timer" && isNativeSpaceActivator(event.target)) {
        return;
      }
      event.preventDefault();
      const handler = handlers[spec.id as ShortcutHandlerId];
      handler?.();
      return;
    }
  };

  target.addEventListener("keydown", onKeyDown);
  return () => {
    target.removeEventListener("keydown", onKeyDown);
  };
}
