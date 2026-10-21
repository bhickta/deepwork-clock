/**
 * Local (in window) keyboard shortcuts.
 *
 * The rules come from the shortcut contract in the plan:
 *  - shortcuts are ignored while a text field has focus or during IME input;
 *  - key repeat is ignored so one press cannot pause and immediately resume;
 *  - Space keeps its native meaning on a focused button.
 *
 * A user may remap a shortcut. Overrides are stored next to the settings as
 * `{ shortcutId: "Ctrl+Shift+M" }`; an unreadable or missing override always
 * falls back to the documented default, so the application is never left
 * without a working binding.
 */
import { MAX_LOCAL_SHORTCUT_LENGTH } from "./contract";
import { t, type StringKey } from "./i18n";

export interface ShortcutSpec {
  readonly id: string;
  /** The stable catalog key of the user facing label. */
  readonly labelKey: StringKey;
  /** Lower case key, or `space` / `f1` style names. */
  readonly key: string;
  /** Requires the primary modifier (Command on macOS, Ctrl elsewhere). */
  readonly primary?: boolean;
  readonly shift?: boolean;
  readonly alt?: boolean;
}

export const SHORTCUTS: readonly ShortcutSpec[] = [
  { id: "toggle-timer", labelKey: "shortcut.toggle_timer", key: "space" },
  { id: "reset", labelKey: "shortcut.reset", key: "r", primary: true, shift: true },
  { id: "next", labelKey: "shortcut.next", key: "n", primary: true, shift: true },
  { id: "compact", labelKey: "shortcut.compact", key: "m", primary: true, shift: true },
  { id: "float", labelKey: "shortcut.float", key: "f", primary: true, shift: true },
  { id: "pin", labelKey: "shortcut.pin", key: "p", primary: true, shift: true },
  { id: "settings", labelKey: "shortcut.settings", key: ",", primary: true },
  { id: "help", labelKey: "shortcut.help", key: "f1" },
  { id: "announce", labelKey: "shortcut.announce", key: "t", primary: true, shift: true }
];

/** The translated label of one shortcut. */
export function shortcutLabel(spec: ShortcutSpec): string {
  return t(spec.labelKey);
}

export type ShortcutHandlerId =
  | "toggle-timer"
  | "reset"
  | "next"
  | "compact"
  | "float"
  | "pin"
  | "settings"
  | "help"
  | "announce";

export type ShortcutHandlers = Record<ShortcutHandlerId, () => void>;

/** User supplied overrides, keyed by shortcut id. */
export type LocalShortcutMap = Readonly<Record<string, string>>;

/** A shortcut after parsing, independent of the display wording. */
export interface ShortcutChord {
  /** Lower case key name: a single character, `space`, `f1` or `delete`. */
  key: string;
  primary: boolean;
  shift: boolean;
  alt: boolean;
}

/** Why a recorded combination cannot be used. */
export type ShortcutIssue = "duplicate" | "bare" | "reserved" | "unsupported";

/** Keys that only change the state of a modifier. */
const MODIFIER_KEYS = new Set([
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "AltGraph",
  "CapsLock",
  "Fn",
  "FnLock",
  "Hyper",
  "Super",
  "Symbol",
  "SymbolLock",
  "OS"
]);

/** Platform tokens this frontend does not model, such as the Windows key. */
const FOREIGN_MODIFIER_TOKENS = new Set(["super", "meta", "win", "windows", "hyper", "os"]);

const PRIMARY_TOKENS = new Set(["ctrl", "control", "cmd", "command", "commandorcontrol", "commandorctrl"]);
const ALT_TOKENS = new Set(["alt", "option"]);
const SHIFT_TOKENS = new Set(["shift"]);

/** True when pressing the key only changes a modifier. */
export function isModifierOnlyKey(key: string): boolean {
  return MODIFIER_KEYS.has(key);
}

function normalizeKeyName(key: string): string | null {
  if (key === " " || key === "Spacebar" || key === "Space") {
    return "space";
  }
  if (/^F([1-9]|1[0-2])$/i.test(key)) {
    return key.toLowerCase();
  }
  if (key.length === 1) {
    return key.toLowerCase();
  }
  return null;
}

function normalizeChordKeyToken(token: string): string | null {
  const lower = token.toLowerCase();
  if (lower === "space" || lower === "spacebar") {
    return "space";
  }
  if (lower === "delete" || lower === "del") {
    return "delete";
  }
  if (/^f([1-9]|1[0-2])$/.test(lower)) {
    return lower;
  }
  if (token.length === 1) {
    return lower;
  }
  return null;
}

/** The key part of a combination as it is shown and stored. */
export function formatChordKey(key: string): string {
  if (key === "space") {
    return "Space";
  }
  if (key.length === 1) {
    return key.toUpperCase();
  }
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/** A combination in the stored wording, for example `Ctrl+Shift+M` or `Cmd+F1`. */
export function formatChord(chord: ShortcutChord, isMac: boolean): string {
  const parts: string[] = [];
  if (chord.primary) {
    parts.push(isMac ? "Cmd" : "Ctrl");
  }
  if (chord.alt) {
    parts.push("Alt");
  }
  if (chord.shift) {
    parts.push("Shift");
  }
  parts.push(formatChordKey(chord.key));
  return parts.join("+");
}

/** The combination of a spec as it is stored in the settings. */
export function formatShortcut(spec: ShortcutSpec, isMac: boolean): string {
  return formatChord(toChord(spec), isMac);
}

function toChord(spec: ShortcutSpec): ShortcutChord {
  return {
    key: spec.key,
    primary: Boolean(spec.primary),
    shift: Boolean(spec.shift),
    alt: Boolean(spec.alt)
  };
}

/**
 * Turn a keydown event into a stored combination.
 *
 * Returns `null` for modifier-only presses, Tab (which keeps moving the
 * focus) and keys this application does not model. On macOS the primary
 * modifier is Command; a Ctrl press there cannot be represented and is
 * refused instead of silently becoming a different shortcut.
 */
export function chordFromEvent(event: KeyboardEvent, isMac: boolean): string | null {
  if (event.isComposing) {
    return null;
  }
  if (isModifierOnlyKey(event.key) || event.key === "Tab") {
    return null;
  }
  const primary = isMac ? event.metaKey : event.ctrlKey;
  const foreign = isMac ? event.ctrlKey : event.metaKey;
  if (foreign) {
    return null;
  }
  const key = normalizeKeyName(event.key);
  if (key === null) {
    return null;
  }
  return formatChord(
    { key, primary, alt: event.altKey, shift: event.shiftKey },
    isMac
  );
}

/** Parse a stored combination, or `null` when it cannot be used. */
export function parseChord(value: string): ShortcutChord | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_LOCAL_SHORTCUT_LENGTH) {
    return null;
  }
  const parts = trimmed
    .split("+")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const keyToken = parts.pop();
  if (keyToken === undefined) {
    return null;
  }
  const key = normalizeChordKeyToken(keyToken);
  if (key === null) {
    return null;
  }
  let primary = false;
  let alt = false;
  let shift = false;
  for (const token of parts) {
    const lower = token.toLowerCase();
    if (PRIMARY_TOKENS.has(lower)) {
      if (primary) {
        return null;
      }
      primary = true;
    } else if (ALT_TOKENS.has(lower)) {
      if (alt) {
        return null;
      }
      alt = true;
    } else if (SHIFT_TOKENS.has(lower)) {
      if (shift) {
        return null;
      }
      shift = true;
    } else if (FOREIGN_MODIFIER_TOKENS.has(lower)) {
      // The Windows key and other platform modifiers are not modelled.
      return null;
    } else {
      return null;
    }
  }
  return { key, primary, shift, alt };
}

function chordSignature(chord: ShortcutChord): string {
  return `${chord.primary ? "1" : "0"}${chord.alt ? "1" : "0"}${chord.shift ? "1" : "0"}:${chord.key}`;
}

/**
 * True when a parsed combination is safe to use as an override.
 *
 * Bare keys, system reserved combinations and keys this application cannot
 * record are refused here as well as in the settings form, so a hand edited
 * settings file cannot take a shortcut away from its default.
 */
function chordIsUsable(chord: ShortcutChord): boolean {
  if (chord.alt && chord.key === "f4" && !chord.primary) {
    return false;
  }
  if (chord.primary && chord.alt && chord.key === "delete") {
    return false;
  }
  if (chord.key === "delete") {
    return false;
  }
  const isFunctionKey = /^f([1-9]|1[0-2])$/.test(chord.key);
  return chord.primary || chord.alt || isFunctionKey;
}

/**
 * The binding that is really used for a shortcut.
 *
 * A missing, unreadable, over-long or unsafe override is ignored, so the
 * documented default stays available.
 */
export function effectiveShortcut(spec: ShortcutSpec, overrides: LocalShortcutMap): ShortcutSpec {
  const raw = overrides[spec.id];
  if (typeof raw !== "string") {
    return spec;
  }
  const parsed = parseChord(raw);
  if (parsed === null || !chordIsUsable(parsed)) {
    return spec;
  }
  return {
    ...spec,
    key: parsed.key,
    primary: parsed.primary,
    shift: parsed.shift,
    alt: parsed.alt
  };
}

/**
 * Check a recorded combination against the other shortcuts and the system.
 *
 * Returns the reason it cannot be used, or `null` when it is fine.
 */
export function validateShortcutChord(
  chord: string,
  id: string,
  overrides: LocalShortcutMap
): ShortcutIssue | null {
  const parsed = parseChord(chord);
  if (parsed === null) {
    return "unsupported";
  }
  if (parsed.alt && parsed.key === "f4" && !parsed.primary) {
    // Alt+F4 closes the window on Windows and most Linux desktops.
    return "reserved";
  }
  if (parsed.primary && parsed.alt && parsed.key === "delete") {
    return "reserved";
  }
  if (parsed.key === "delete") {
    // Delete and Backspace clear an override; they are not recordable keys.
    return "unsupported";
  }
  const isFunctionKey = /^f([1-9]|1[0-2])$/.test(parsed.key);
  if (!parsed.primary && !parsed.alt && !isFunctionKey) {
    // A bare letter or Space is too easy to press by accident. Shift alone is
    // not enough either.
    return "bare";
  }
  const signature = chordSignature(parsed);
  for (const spec of SHORTCUTS) {
    if (spec.id === id) {
      continue;
    }
    if (chordSignature(toChord(effectiveShortcut(spec, overrides))) === signature) {
      return "duplicate";
    }
  }
  return null;
}

/**
 * Keep only the overrides that are valid and differ from the default.
 *
 * Saving a click that produced the default binding therefore stores nothing,
 * and the defaults survive every future version.
 */
export function normalizeLocalShortcuts(
  overrides: LocalShortcutMap,
  isMac: boolean
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const spec of SHORTCUTS) {
    const raw = overrides[spec.id];
    if (typeof raw !== "string") {
      continue;
    }
    const parsed = parseChord(raw);
    if (parsed === null) {
      continue;
    }
    if (validateShortcutChord(raw, spec.id, overrides) !== null) {
      continue;
    }
    if (chordSignature(parsed) === chordSignature(toChord(spec))) {
      continue;
    }
    result[spec.id] = formatChord(parsed, isMac);
  }
  return result;
}

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
 * `overrides` may be a plain map or a getter, so a settings change takes
 * effect without reinstalling the listener: every keydown resolves the
 * binding that is currently stored. Returns a function that removes the
 * listener again.
 */
export function installShortcuts(
  target: HTMLElement,
  handlers: ShortcutHandlers,
  isMac: boolean = isMacPlatform(),
  overrides: LocalShortcutMap | (() => LocalShortcutMap) = {}
): () => void {
  const readOverrides = typeof overrides === "function" ? overrides : (): LocalShortcutMap => overrides;
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
    const current = readOverrides();
    for (const spec of SHORTCUTS) {
      if (!matchShortcut(event, effectiveShortcut(spec, current), isMac)) {
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
