import { el, setHidden } from "./dom";
import { t } from "./i18n";

/** Maximum length accepted by the engine for a session label. */
export const MAX_SESSION_NAME = 120;

/**
 * How well `query` matches `text` as a subsequence.
 *
 * Returns `null` when some characters of the query do not appear in order.
 * Consecutive matches and a match at the start score higher, so "wr" ranks
 * "Writing" above "Answering". The function is deliberately small and pure so
 * the ranking is deterministic in tests.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return 0;
  }
  const haystack = text.toLowerCase();
  let position = 0;
  let score = 0;
  let previous = -2;
  for (const character of needle) {
    const found = haystack.indexOf(character, position);
    if (found === -1) {
      return null;
    }
    score += 1;
    if (found === previous + 1) {
      score += 3;
    }
    if (found === 0) {
      score += 2;
    }
    previous = found;
    position = found + 1;
  }
  // Prefer the shorter of two equally good matches.
  return score - haystack.length / 100;
}

/** Distinct past names that match, best first. */
export function rankSessionNames(
  names: readonly string[],
  query: string,
  limit = 8
): string[] {
  const seen = new Set<string>();
  const scored: Array<{ name: string; score: number }> = [];
  for (const raw of names) {
    const name = raw.trim();
    const key = name.toLowerCase();
    if (name.length === 0 || seen.has(key)) {
      continue;
    }
    seen.add(key);
    const score = fuzzyScore(query, name);
    if (score !== null) {
      scored.push({ name, score });
    }
  }
  scored.sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));
  return scored.slice(0, limit).map((entry) => entry.name);
}

export interface SessionNameOptions {
  doc: Document;
  /** Called with the trimmed name when the user commits it. */
  onCommit(name: string): void;
}

/**
 * Optional session name with fuzzy suggestions from earlier sessions.
 *
 * The control follows the ARIA combobox pattern: the input owns focus, the
 * listbox is referenced through `aria-controls`, and the active option is
 * announced through `aria-activedescendant`. Typing filters, Up/Down move,
 * Enter accepts, Escape closes and a plain blur commits the typed value.
 */
export class SessionName {
  readonly element: HTMLElement;

  private readonly doc: Document;

  private readonly onCommit: (name: string) => void;

  private readonly input: HTMLInputElement;

  private readonly list: HTMLElement;

  private readonly hint: HTMLElement;

  private suggestions: string[] = [];

  private filtered: string[] = [];

  private active = -1;

  constructor(options: SessionNameOptions) {
    this.doc = options.doc;
    this.onCommit = options.onCommit;

    this.input = el("input", {
      class: "session-name__input",
      attrs: {
        id: "session-name",        type: "text",
        role: "combobox",
        "aria-autocomplete": "list",
        "aria-expanded": "false",
        "aria-controls": "session-name-list",
        "aria-describedby": "session-name-hint",
        autocomplete: "off",
        maxlength: String(MAX_SESSION_NAME),
        placeholder: t("session.name.placeholder")
      },
      on: {
        input: () => this.refilter(),
        keydown: (event) => this.onKeyDown(event as KeyboardEvent),
        blur: () => this.commit(),
        focus: () => this.refilter()
      }
    });

    this.list = el("ul", {
      class: "session-name__list",
      attrs: { id: "session-name-list", role: "listbox", "aria-label": t("session.name.suggestions") }
    });
    setHidden(this.list, true);

    this.hint = el("p", {
      class: "session-name__hint",
      attrs: { id: "session-name-hint" },
      text: t("session.name.hint")
    });

    this.element = el("div", { class: "session-name" }, [
      el("label", {
        class: "sr-only",
        attrs: { for: "session-name" },
        text: t("session.name.label")
      }),
      this.input,
      this.list,
      this.hint
    ]);
  }

  /** Show a stored name without committing it. */
  setValue(name: string): void {
    if (this.doc.activeElement === this.input) {
      return;
    }
    this.input.value = name;
    this.close();
  }

  /** Replace the pool of past names. */
  setSuggestions(names: readonly string[]): void {
    this.suggestions = [...names];
    if (this.doc.activeElement === this.input) {
      this.refilter();
    }
  }

  focus(): void {
    this.input.focus();
  }

  private refilter(): void {
    this.filtered = rankSessionNames(this.suggestions, this.input.value);
    this.active = -1;
    this.list.textContent = "";
    if (this.filtered.length === 0) {
      this.close();
      return;
    }
    this.filtered.forEach((name, index) => {
      const option = el("li", {
        class: "session-name__option",
        attrs: {
          id: `session-name-option-${index}`,
          role: "option",
          "aria-selected": "false"
        },
        text: name
      });
      // Keep the input focused so the blur handler cannot fire before the
      // click selects an option.
      option.addEventListener("mousedown", (event) => event.preventDefault());
      option.addEventListener("click", () => this.choose(name));
      this.list.appendChild(option);
    });
    setHidden(this.list, false);
    this.input.setAttribute("aria-expanded", "true");
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.isComposing) {
      return;
    }
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        this.move(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        this.move(-1);
        break;
      case "Enter":
        event.preventDefault();
        if (this.active >= 0 && this.filtered[this.active]) {
          this.choose(this.filtered[this.active]);
        } else {
          this.commit();
          this.close();
        }
        break;
      case "Escape":
        event.preventDefault();
        this.close();
        break;
      case "Tab":
        this.commit();
        this.close();
        break;
      default:
        break;
    }
  }

  private move(delta: number): void {
    if (this.filtered.length === 0) {
      return;
    }
    const count = this.filtered.length;
    this.active = (this.active + delta + count) % count;
    for (const option of Array.from(this.list.children)) {
      const selected = option.id === `session-name-option-${this.active}`;
      option.setAttribute("aria-selected", selected ? "true" : "false");
    }
    this.input.setAttribute(
      "aria-activedescendant",
      `session-name-option-${this.active}`
    );
    this.doc
      .getElementById(`session-name-option-${this.active}`)
      ?.scrollIntoView?.({ block: "nearest" });
  }

  private choose(name: string): void {
    this.input.value = name;
    this.close();
    this.commit();
  }

  private commit(): void {
    const name = this.input.value.trim().slice(0, MAX_SESSION_NAME);
    this.input.value = name;
    this.onCommit(name);
  }

  private close(): void {
    setHidden(this.list, true);
    this.list.textContent = "";
    this.filtered = [];
    this.active = -1;
    this.input.setAttribute("aria-expanded", "false");
    this.input.removeAttribute("aria-activedescendant");
  }
}
