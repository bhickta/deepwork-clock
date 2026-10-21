import type { Theme } from "./contract";

export type ResolvedTheme = "light" | "dark" | "high-contrast";

/** True when the system asks for a dark colour scheme. */
export function prefersDark(doc: Document = document): boolean {
  const view = doc.defaultView;
  if (!view || typeof view.matchMedia !== "function") {
    return false;
  }
  try {
    return view.matchMedia("(prefers-color-scheme: dark)").matches === true;
  } catch {
    return false;
  }
}

/** Map the requested theme onto the theme that is actually shown. */
export function resolveTheme(theme: Theme, doc: Document = document): ResolvedTheme {
  if (theme === "system") {
    return prefersDark(doc) ? "dark" : "light";
  }
  return theme;
}

/** Apply a theme to the document root. */
export function applyTheme(theme: Theme, doc: Document = document): void {
  doc.documentElement.setAttribute("data-theme", resolveTheme(theme, doc));
}

/** Apply the text scale to the document root. */
export function applyTextScale(scale: number, doc: Document = document): void {
  const clamped = Math.min(2, Math.max(1, Number.isFinite(scale) ? scale : 1));
  doc.documentElement.style.setProperty("--text-scale", String(clamped));
}

/**
 * Watch for system colour scheme changes.
 *
 * Only used while the theme setting is `system`; the returned function stops
 * the watch.
 */
export function watchSystemTheme(
  callback: (dark: boolean) => void,
  doc: Document = document
): () => void {
  const view = doc.defaultView;
  if (!view || typeof view.matchMedia !== "function") {
    return () => undefined;
  }
  let query: MediaQueryList;
  try {
    query = view.matchMedia("(prefers-color-scheme: dark)");
  } catch {
    return () => undefined;
  }
  const onChange = (event: MediaQueryListEvent): void => {
    callback(event.matches === true);
  };
  if (typeof query.addEventListener === "function") {
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }
  // Older engines only expose the deprecated listener API.
  const legacy = query as MediaQueryList & {
    addListener?: (listener: (event: MediaQueryListEvent) => void) => void;
    removeListener?: (listener: (event: MediaQueryListEvent) => void) => void;
  };
  legacy.addListener?.(onChange);
  return () => legacy.removeListener?.(onChange);
}
