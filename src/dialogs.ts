/**
 * Accessible modal dialogs.
 *
 * The dialog follows the ARIA authoring practices for modal dialogs: it is
 * labelled, focus is contained while it is open, Escape cancels it and focus
 * returns to the control that opened it.
 */
import { el, focusableWithin, setText, updateScrollableFocus } from "./dom";
import { createIcon } from "./icons";

let dialogCounter = 0;

export interface ModalOptions {
  title: string;
  description?: string;
  /** Extra class on the dialog panel, used for sizing. */
  size?: "small" | "medium" | "large";
  /** Called whenever the dialog is closed, whatever the reason. */
  onClose?: () => void;
  /**
   * Asked before the dialog closes. Returning `false` keeps the dialog open.
   * Used by the settings dialog so unsaved edits are not lost silently.
   */
  confirmClose?: () => Promise<boolean>;
}

export class Modal {
  readonly element: HTMLElement;

  readonly titleId: string;

  readonly descriptionId: string;

  readonly body: HTMLElement;

  readonly footer: HTMLElement;

  readonly title: HTMLHeadingElement;

  private readonly doc: Document;

  private readonly options: ModalOptions;

  private readonly dialog: HTMLElement;

  private readonly backdrop: HTMLElement;

  private previousFocus: Element | null = null;

  private open = false;

  constructor(doc: Document, options: ModalOptions) {
    this.doc = doc;
    this.options = options;
    dialogCounter += 1;
    this.titleId = `modal-title-${dialogCounter}`;
    this.descriptionId = `modal-description-${dialogCounter}`;

    this.title = el("h2", { class: "modal__title", id: this.titleId, text: options.title });
    this.body = el("div", { class: "modal__body" });
    this.footer = el("div", { class: "modal__footer" });

    const closeButton = el(
      "button",
      {
        class: "icon-button modal__close",
        attrs: { type: "button", "aria-label": "Close dialog" },
        on: { click: () => void this.requestClose() }
      },
      [createIcon("close", 18)]
    );

    this.dialog = el(
      "div",
      {
        class: "modal",
        attrs: {
          role: "dialog",
          "aria-modal": "true",
          "aria-labelledby": this.titleId,
          tabindex: "-1"
        }
      },
      [el("header", { class: "modal__header" }, [this.title, closeButton]), this.body, this.footer]
    );

    if (options.description) {
      this.dialog.setAttribute("aria-describedby", this.descriptionId);
      const description = el("p", {
        class: "modal__description",
        id: this.descriptionId,
        text: options.description
      });
      this.dialog.insertBefore(description, this.body);
    }
    if (options.size) {
      this.dialog.classList.add(`modal--${options.size}`);
    }

    this.backdrop = el("div", { class: "modal-backdrop" }, [this.dialog]);
    this.backdrop.addEventListener("mousedown", (event) => {
      if (event.target === this.backdrop) {
        void this.requestClose();
      }
    });
    this.dialog.addEventListener("keydown", (event) => this.onKeyDown(event));

    this.element = this.backdrop;
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** Close the dialog, asking the owner first when a guard is configured. */
  async requestClose(): Promise<void> {
    if (!this.open) {
      return;
    }
    if (this.options.confirmClose) {
      const allowed = await this.options.confirmClose();
      if (!allowed) {
        return;
      }
    }
    this.close();
  }

  /** Open the dialog and move focus into it. */
  openDialog(preferredFocus?: HTMLElement): void {
    if (this.open) {
      return;
    }
    this.open = true;
    this.previousFocus = this.doc.activeElement;
    this.doc.body.appendChild(this.backdrop);
    this.doc.body.classList.add("has-modal");
    const target = preferredFocus ?? this.firstFocusable() ?? this.dialog;
    target.focus();
    // A body that scrolls has to be reachable with the keyboard.
    updateScrollableFocus(this.body);
  }

  /** Close the dialog and restore focus to the invoking control. */
  close(): void {
    if (!this.open) {
      return;
    }
    this.open = false;
    this.backdrop.remove();
    this.doc.body.classList.remove("has-modal");
    const previous = this.previousFocus;
    this.previousFocus = null;
    if (previous instanceof HTMLElement && previous.isConnected) {
      previous.focus();
    }
    this.options.onClose?.();
  }

  /** Update the dialog heading text. */
  setTitle(text: string): void {
    setText(this.title, text);
  }

  /** Set the description paragraph shown under the heading. */
  setDescription(text: string | null): void {
    const description = this.dialog.querySelector<HTMLElement>(".modal__description");
    if (!text) {
      description?.remove();
      this.dialog.removeAttribute("aria-describedby");
      return;
    }
    if (!description) {
      const created = el("p", { class: "modal__description", id: this.descriptionId });
      this.dialog.insertBefore(created, this.body);
      this.dialog.setAttribute("aria-describedby", this.descriptionId);
    } else {
      setText(description, text);
    }
  }

  private firstFocusable(): HTMLElement | null {
    const focusable = focusableWithin(this.dialog);
    return focusable.length > 0 ? (focusable[0] ?? null) : null;
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      void this.requestClose();
      return;
    }
    if (event.key !== "Tab") {
      return;
    }
    const focusable = focusableWithin(this.dialog);
    if (focusable.length === 0) {
      event.preventDefault();
      this.dialog.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) {
      return;
    }
    const active = this.doc.activeElement;
    if (!this.dialog.contains(active)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
      return;
    }
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }
}

export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
  /** `cancel` keeps the destructive action from being the first stop. */
  initialFocus?: "confirm" | "cancel";
}

/**
 * Ask a yes/no question in a modal dialog.
 *
 * Resolves `true` when the confirm button was pressed and `false` when the
 * dialog was cancelled with Escape or the cancel button.
 */
export function confirmDialog(doc: Document, options: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (result: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    const modal = new Modal(doc, {
      title: options.title,
      description: options.description,
      size: "small",
      onClose: () => finish(false)
    });

    const confirmButton = el("button", {
      class: options.tone === "danger" ? "button button--danger" : "button button--primary",
      attrs: { type: "button" },
      text: options.confirmLabel ?? "Confirm",
      on: {
        click: () => {
          finish(true);
          modal.close();
        }
      }
    });

    const cancelButton = el("button", {
      class: "button",
      attrs: { type: "button" },
      text: options.cancelLabel ?? "Cancel",
      on: {
        click: () => {
          finish(false);
          modal.close();
        }
      }
    });

    modal.footer.appendChild(cancelButton);
    modal.footer.appendChild(confirmButton);

    modal.openDialog(options.initialFocus === "confirm" ? confirmButton : cancelButton);
  });
}
