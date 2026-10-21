// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { Modal, confirmDialog } from "../../src/dialogs";
import { focusableWithin } from "../../src/dom";

function makeButton(label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  return button;
}

function escape(target: Element): void {
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
  );
}

describe("Modal", () => {
  it("moves focus into the dialog and gives it back on close", () => {
    document.body.textContent = "";
    const opener = makeButton("open");
    document.body.appendChild(opener);
    opener.focus();

    const modal = new Modal(document, { title: "Test dialog" });
    modal.body.appendChild(makeButton("inside"));
    modal.openDialog();

    expect(document.body.contains(modal.element)).toBe(true);
    expect(document.activeElement).not.toBe(opener);

    modal.close();
    expect(document.body.contains(modal.element)).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it("is labelled and marked as modal", () => {
    document.body.textContent = "";
    const modal = new Modal(document, { title: "Test dialog", description: "Some help" });
    modal.openDialog();
    const dialog = document.querySelector(".modal");
    expect(dialog?.getAttribute("role")).toBe("dialog");
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(dialog?.getAttribute("aria-labelledby")).toBe(modal.titleId);
    expect(dialog?.getAttribute("aria-describedby")).toBe(modal.descriptionId);
    expect(document.querySelector(".modal__description")?.textContent).toBe("Some help");
    modal.close();
  });

  it("keeps the keyboard focus inside the dialog", () => {
    document.body.textContent = "";
    const modal = new Modal(document, { title: "Test dialog" });
    const first = makeButton("first");
    const last = makeButton("last");
    modal.body.append(first, last);
    modal.openDialog(first);

    const focusable = focusableWithin(modal.element);
    const head = focusable[0];
    const tail = focusable[focusable.length - 1];
    expect(tail).toBe(last);
    expect(head).not.toBe(first);

    last.focus();
    last.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(head);

    (head as HTMLElement).focus();
    (head as HTMLElement).dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })
    );
    expect(document.activeElement).toBe(last);
    modal.close();
  });

  it("closes on Escape", () => {
    document.body.textContent = "";
    const modal = new Modal(document, { title: "Test dialog" });
    modal.openDialog();
    escape(document.querySelector(".modal") as Element);
    expect(modal.isOpen).toBe(false);
  });
});

describe("confirmDialog", () => {
  it("starts on the cancel button and resolves false when cancelled", async () => {
    document.body.textContent = "";
    const promise = confirmDialog(document, { title: "Reset the phase?" });
    const buttons = document.querySelectorAll<HTMLButtonElement>(".modal__footer button");
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.textContent).toBe("Cancel");
    expect(document.activeElement).toBe(buttons[0]);

    buttons[0]?.click();
    await expect(promise).resolves.toBe(false);
  });

  it("resolves true when the confirm button is pressed", async () => {
    document.body.textContent = "";
    const promise = confirmDialog(document, { title: "Reset the phase?", confirmLabel: "Reset" });
    const buttons = document.querySelectorAll<HTMLButtonElement>(".modal__footer button");
    buttons[1]?.click();
    await expect(promise).resolves.toBe(true);
  });

  it("resolves false when Escape is pressed", async () => {
    document.body.textContent = "";
    const promise = confirmDialog(document, { title: "Reset the phase?" });
    escape(document.querySelector(".modal") as Element);
    await expect(promise).resolves.toBe(false);
  });
});
