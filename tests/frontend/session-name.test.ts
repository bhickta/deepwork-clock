// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../../src/app";
import { fuzzyScore, rankSessionNames, SessionName } from "../../src/session-name";
import { FakeBridge, makeHistoryRecord } from "./helpers/fake-bridge";

let app: App | null = null;

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

afterEach(() => {
  app?.dispose();
  app = null;
  document.body.textContent = "";
});

function mountName(commits: string[]): SessionName {
  document.body.textContent = "";
  const name = new SessionName({
    doc: document,
    onCommit: (value) => commits.push(value)
  });
  document.body.appendChild(name.element);
  return name;
}

function input(): HTMLInputElement {
  return document.getElementById("session-name") as HTMLInputElement;
}

describe("fuzzy session names", () => {
  it("matches subsequences and rejects unrelated text", () => {
    expect(fuzzyScore("wr", "Writing")).not.toBeNull();
    expect(fuzzyScore("zz", "Writing")).toBeNull();
    expect(fuzzyScore("", "Writing")).toBe(0);
  });

  it("ranks a prefix and consecutive matches first, without duplicates", () => {
    const ranked = rankSessionNames(
      ["Answering email", "Writing", "writing", "Weekly review"],
      "wr"
    );
    expect(ranked[0]).toBe("Writing");
    expect(ranked.filter((name) => name.toLowerCase() === "writing")).toHaveLength(1);
  });

  it("limits the suggestion list", () => {
    const names = Array.from({ length: 20 }, (_, index) => `writing ${index}`);
    expect(rankSessionNames(names, "wr", 5)).toHaveLength(5);
  });
});

describe("session name control", () => {
  it("filters past names and commits the active option with the keyboard", () => {
    const commits: string[] = [];
    const name = mountName(commits);
    name.setSuggestions(["Writing", "Reading", "Weekly review"]);

    input().focus();
    input().value = "wr";
    input().dispatchEvent(new Event("input", { bubbles: true }));

    expect(input().getAttribute("aria-expanded")).toBe("true");
    const options = Array.from(document.querySelectorAll(".session-name__option"));
    expect(options.length).toBeGreaterThan(0);
    expect(options[0]?.textContent).toBe("Writing");

    input().dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })
    );
    input().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
    );

    expect(commits).toEqual(["Writing"]);
    expect(input().value).toBe("Writing");
    expect(input().getAttribute("aria-expanded")).toBe("false");
  });

  it("closes the list on Escape and keeps the typed text", () => {
    const commits: string[] = [];
    const name = mountName(commits);
    name.setSuggestions(["Writing"]);

    input().focus();
    input().value = "w";
    input().dispatchEvent(new Event("input", { bubbles: true }));
    input().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    );

    expect(input().getAttribute("aria-expanded")).toBe("false");
    expect(input().value).toBe("w");
    expect(commits).toEqual([]);
  });

  it("commits a typed name on blur", () => {
    const commits: string[] = [];
    mountName(commits);

    input().focus();
    input().value = "  Deep work  ";
    input().dispatchEvent(new Event("blur"));

    expect(commits).toEqual(["Deep work"]);
    expect(input().value).toBe("Deep work");
  });
});

describe("session name in the app", () => {
  async function mountApp(bridge: FakeBridge): Promise<HTMLElement> {
    document.body.textContent = "";
    const root = document.createElement("div");
    document.body.appendChild(root);
    app = new App({ root, bridge });
    await app.start();
    return root;
  }

  it("offers labels from the history and saves a chosen name", async () => {
    const bridge = new FakeBridge({
      history: [
        makeHistoryRecord({ phaseId: "a", label: "Deep work" }),
        makeHistoryRecord({ phaseId: "b", label: "Reading" })
      ]
    });
    await mountApp(bridge);

    input().focus();
    input().value = "de";
    input().dispatchEvent(new Event("input", { bubbles: true }));
    const options = Array.from(document.querySelectorAll(".session-name__option")).map(
      (option) => option.textContent
    );
    expect(options).toContain("Deep work");

    input().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
    );
    await flush();
    await flush();

    expect(bridge.savedSettings.at(-1)?.settings.config.label).toBe("de");
  });
});
