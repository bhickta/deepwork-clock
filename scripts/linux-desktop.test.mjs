#!/usr/bin/env node
/**
 * Regression guard for the Linux desktop entry.
 *
 * Tauri derives the installed .desktop file name from the Linux productName.
 * GIO's systemd launcher (used by Regolith ilia, GNOME and others) passes that
 * file name as a systemd scope unit. A space in the name splits the argument,
 * so the launcher reports "Failed to find executable ..." and the application
 * never starts. Keep the Linux product name a slug and put the display name in
 * the template instead.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = join(root, "src-tauri", "tauri.linux.conf.json");
const linuxConfig = JSON.parse(readFileSync(configPath, "utf8"));

test("the Linux product name is safe as a .desktop file name", () => {
  assert.equal(typeof linuxConfig.productName, "string");
  assert.equal(
    /\s/.test(linuxConfig.productName),
    false,
    "a space in productName breaks GIO's systemd launch path",
  );
  assert.match(linuxConfig.productName, /^[a-z0-9][a-z0-9._-]*$/);
});

test("the desktop template keeps the human readable name", () => {
  const relative = linuxConfig.bundle?.linux?.deb?.desktopTemplate;
  assert.equal(typeof relative, "string");
  const template = readFileSync(join(root, "src-tauri", relative), "utf8");
  assert.match(template, /^Name=Deepwork Clock$/m);
  assert.match(template, /^Exec=\{\{exec\}\}$/m);
  assert.match(template, /^StartupWMClass=deepwork-clock$/m);
  assert.equal(
    /\{\{name\}\}/.test(template),
    false,
    "the menu label must not be the slug used for the file name",
  );
});
