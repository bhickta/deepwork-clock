// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { applyDirection, pseudoCatalog, pseudoLocalize, t } from "../../src/i18n";

afterEach(() => {
  document.documentElement.removeAttribute("dir");
});

describe("pseudo-localization", () => {
  it("makes catalog text longer and accented while keeping placeholders", () => {
    const source = t("settings.interval", { count: "{count}" });
    const pseudo = pseudoLocalize(source);

    expect(pseudo).not.toBe(source);
    expect(pseudo.length).toBeGreaterThan(source.length);
    expect(pseudo).toMatch(/[áéíóúñçšž]/i);

    const sourcePlaceholders = source.match(/\{\w+\}/g) ?? [];
    const pseudoPlaceholders = pseudo.match(/\{\w+\}/g) ?? [];
    expect(pseudoPlaceholders).toEqual(sourcePlaceholders);
  });

  it("keeps several placeholders in place", () => {
    const source = t("announce.remaining", { phase: "{phase}", duration: "{duration}" });
    const pseudo = pseudoLocalize(source);

    expect(pseudo).toContain("{phase}");
    expect(pseudo).toContain("{duration}");
    expect((pseudo.match(/\{\w+\}/g) ?? []).length).toBe(2);
  });

  it("can expand every catalog value", () => {
    const pseudo = pseudoCatalog();
    const key = "settings.sound.preview";

    expect(pseudo[key].length).toBeGreaterThan(t(key).length);
    expect(pseudo[key]).toContain("\u27e6");
    expect(pseudo[key]).toContain("\u27e7");
  });
});

describe("text direction", () => {
  it("applies right-to-left and back without rebuilding the document", () => {
    applyDirection("rtl");
    expect(document.documentElement.getAttribute("dir")).toBe("rtl");

    applyDirection("ltr");
    expect(document.documentElement.getAttribute("dir")).toBe("ltr");
  });
});
