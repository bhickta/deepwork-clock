/**
 * A small overflow menu.
 *
 * The menu follows the ARIA authoring practices for a menu button: the button
 * reports its state, the menu is a list of menu items, the arrow keys move
 * between them and Escape closes the menu and returns the focus.
 */
import { el } from "./dom";

export interface MenuItem {
  id: string;
  label: string;
  /** Short hint shown on the right hand side of the item. */
  hint?: string;
  onSelect(): void;
}

export interface MenuOptions {
  doc: Document;
  /** The button that opens the menu. */
  button: HTMLButtonElement;
  /** Accessible name of the menu. */
  label: string;
  items: MenuItem[];
}

export class Menu {
  private readonly doc: Document;

  private readonly button: HTMLButtonElement;

  private readonly items: MenuItem[];

  private readonly label: string;

  private readonly menuId: string;

  private element: HTMLElement | null = null;

  private open = false;

  private readonly onDocumentPointerDown = (event: Event): void => {
    const target = event.target as Node | null;
    if (!target) {
      return;
    }
    if (this.element?.contains(target) || this.button.contains(target)) {
      return;
    }
    this.closeMenu(false);
  };

  constructor(options: MenuOptions) {
    this.doc = options.doc;
    this.button = options.button;
    this.items = options.items;
    this.label = options.label;
    this.menuId = `menu-${Math.random().toString(36).slice(2, 9)}`;
    this.button.setAttribute("aria-haspopup", "menu");
    this.button.setAttribute("aria-expanded", "false");
    this.button.setAttribute("aria-controls", this.menuId);
    this.button.addEventListener("click", () => this.toggle());
    this.button.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        this.openMenu();
      }
    });
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** Open the menu and move the focus to the first item. */
  openMenu(): void {
    if (this.open) {
      return;
    }
    this.open = true;
    this.element = this.build();
    this.doc.body.appendChild(this.element);
    this.position();
    this.button.setAttribute("aria-expanded", "true");
    this.doc.addEventListener("mousedown", this.onDocumentPointerDown);
    const first = this.element.querySelector<HTMLElement>('[role="menuitem"]');
    first?.focus();
  }

  /** Place the menu next to the button, above it when there is no room below. */
  private position(): void {
    const element = this.element;
    if (!element) {
      return;
    }
    const rect = this.button.getBoundingClientRect();
    const view = this.doc.defaultView;
    const height = element.offsetHeight || 0;
    const width = element.offsetWidth || 0;
    const gap = 4;
    let top = rect.bottom + gap;
    if (view && height > 0 && top + height > view.innerHeight - gap) {
      const above = rect.top - gap - height;
      if (above >= gap) {
        top = above;
      }
    }
    element.style.position = "fixed";
    element.style.top = `${Math.round(top)}px`;
    const rtl = this.doc.documentElement.getAttribute("dir") === "rtl";
    if (rtl && view) {
      // Anchor the menu to the inline start (the right edge) and let it grow
      // towards the start, while staying inside the viewport.
      const maxRight = Math.max(gap, view.innerWidth - width - gap);
      const right = Math.min(Math.max(gap, view.innerWidth - rect.right), maxRight);
      element.style.right = `${Math.round(right)}px`;
      element.style.left = "auto";
      return;
    }
    element.style.left = `${Math.round(Math.max(gap, rect.right - width))}px`;
    element.style.right = "auto";
  }

  /** Close the menu. */
  closeMenu(focusButton = true): void {
    if (!this.open) {
      return;
    }
    this.open = false;
    this.element?.remove();
    this.element = null;
    this.button.setAttribute("aria-expanded", "false");
    this.doc.removeEventListener("mousedown", this.onDocumentPointerDown);
    if (focusButton) {
      this.button.focus();
    }
  }

  /** Open the menu when it is closed, close it when it is open. */
  toggle(): void {
    if (this.open) {
      this.closeMenu();
      return;
    }
    this.openMenu();
  }

  private build(): HTMLElement {
    const element = el("div", {
      class: "menu",
      attrs: { role: "menu", id: this.menuId, "aria-label": this.label }    });

    const buttons: HTMLButtonElement[] = [];
    for (const item of this.items) {
      const button = el("button", {
        class: "menu__item",
        attrs: { type: "button", role: "menuitem", tabindex: "-1", "data-menu-item": item.id },
        text: item.label,
        on: {
          click: () => {
            this.closeMenu();
            item.onSelect();
          }
        }
      });
      if (item.hint) {
        button.appendChild(el("span", { class: "menu__hint", text: item.hint }));
      }
      buttons.push(button);
      element.appendChild(button);
    }

    element.addEventListener("keydown", (event) => this.onKeyDown(event, buttons));
    return element;
  }

  private onKeyDown(event: KeyboardEvent, buttons: HTMLButtonElement[]): void {    const active = this.doc.activeElement;
    const index = buttons.findIndex((button) => button === active);
    switch (event.key) {
      case "ArrowDown": {
        event.preventDefault();
        const next = buttons[(index + 1 + buttons.length) % buttons.length];
        next?.focus();
        break;
      }
      case "ArrowUp": {
        event.preventDefault();
        const previous = buttons[(index - 1 + buttons.length) % buttons.length];
        previous?.focus();
        break;
      }
      case "Home": {
        event.preventDefault();
        buttons[0]?.focus();
        break;
      }
      case "End": {
        event.preventDefault();
        buttons[buttons.length - 1]?.focus();
        break;
      }
      case "Escape": {
        event.preventDefault();
        this.closeMenu();
        break;
      }
      case "Tab": {
        this.closeMenu(false);
        break;
      }
      default:
        break;
    }
  }
}
