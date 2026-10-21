/**
 * Small DOM helpers.
 *
 * The application builds its markup with these helpers instead of string
 * concatenation so no user supplied value is ever parsed as HTML.
 */

export type Child = Node | string | null | undefined;

export type AttrValue = string | number | boolean | null | undefined;

export interface ElementOptions {
  class?: string;
  id?: string;
  text?: string;
  title?: string;
  attrs?: Record<string, AttrValue>;
  data?: Record<string, string>;
  on?: Record<string, EventListenerOrEventListenerObject>;
}

/** Create an element with optional attributes, text and children. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
  children: Child[] = []
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.class !== undefined) {
    node.className = options.class;
  }
  if (options.id !== undefined) {
    node.id = options.id;
  }
  if (options.title !== undefined) {
    node.title = options.title;
  }
  if (options.attrs) {
    for (const [name, value] of Object.entries(options.attrs)) {
      if (value === undefined || value === null || value === false) {
        continue;
      }
      node.setAttribute(name, value === true ? "" : String(value));
    }
  }
  if (options.data) {
    for (const [name, value] of Object.entries(options.data)) {
      node.dataset[name] = value;
    }
  }
  if (options.on) {
    for (const [name, listener] of Object.entries(options.on)) {
      node.addEventListener(name, listener);
    }
  }
  if (options.text !== undefined) {
    node.textContent = options.text;
  }
  appendChildren(node, children);
  return node;
}

/** Append children, skipping empty values. */
export function appendChildren(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined) {
      continue;
    }
    parent.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
}

/** Replace the children of a node. */
export function replaceChildren(node: Element, children: Child[]): void {
  node.textContent = "";
  appendChildren(node, children);
}

/** Update the text of a node only when it changed, to avoid needless mutations. */
export function setText(node: Node, text: string): void {
  if (node.textContent !== text) {
    node.textContent = text;
  }
}

/** Toggle the `hidden` attribute of a node. */
export function setHidden(node: HTMLElement, hidden: boolean): void {
  if (hidden) {
    node.setAttribute("hidden", "");
  } else {
    node.removeAttribute("hidden");
  }
}

/** Create a visually hidden, screen reader only element. */
export function srOnly(text: string): HTMLSpanElement {
  return el("span", { class: "sr-only", text });
}

/** Query focusable descendants in document order. */
export function focusableWithin(root: ParentNode): HTMLElement[] {
  const selector = [
    "a[href]",
    "button:not([disabled])",
    "input:not([disabled]):not([type=hidden])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "[tabindex]:not([tabindex='-1'])"
  ].join(",");
  const nodes = Array.from(root.querySelectorAll<HTMLElement>(selector));
  return nodes.filter((node) => node.getAttribute("aria-hidden") !== "true");
}

/**
 * Make a scrollable region reachable with the keyboard.
 *
 * A region that scrolls but holds nothing focusable cannot be scrolled with
 * the keyboard, which is an accessibility failure.
 */
export function updateScrollableFocus(element: HTMLElement): void {
  const scrollable = element.scrollHeight > element.clientHeight + 1;
  if (scrollable) {
    element.setAttribute("tabindex", "0");
  } else {
    element.removeAttribute("tabindex");
  }
}
