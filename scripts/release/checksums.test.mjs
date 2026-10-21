#!/usr/bin/env node
/**
 * Tests for the release helper scripts.
 *
 * Run with: npm run test:scripts   (node --test scripts/)
 *
 * These cover the file-name handling that the shell based checksum pipelines
 * got wrong: installers contain spaces ("Deepwork Clock ...exe"), and a
 * manifest must never be able to point outside the release directory.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const checksums = join(scriptDir, "checksums.mjs");

function run(args, options = {}) {
  try {
    const output = execFileSync(process.execPath, [checksums, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    return { code: 0, output };
  } catch (error) {
    return {
      code: error.status ?? 1,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
    };
  }
}

function withTempDir(body) {
  const directory = mkdtempSync(join(tmpdir(), "deepwork-checksums-"));
  try {
    return body(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("generate hashes every file, including names with spaces", () => {
  withTempDir((directory) => {
    writeFileSync(join(directory, "Deepwork Clock 0.1.0-alpha.1.exe"), "installer");
    writeFileSync(join(directory, "checksums.txt"), "notes");

    const result = run(["generate", "--dir", directory]);
    assert.equal(result.code, 0, result.output);

    const manifest = readFileSync(join(directory, "SHA256SUMS"), "utf8");
    assert.equal(manifest.trim().split("\n").length, 2);
    assert.match(manifest, /Deepwork Clock 0\.1\.0-alpha\.1\.exe$/m);
    assert.match(manifest, /^[0-9a-f]{64} {2}/m);
  });
});

test("generate can exclude files from the manifest", () => {
  withTempDir((directory) => {
    writeFileSync(join(directory, "package.exe"), "a");
    writeFileSync(join(directory, "notes.txt"), "b");

    const result = run(["generate", "--dir", directory, "--exclude", "notes.txt"]);
    assert.equal(result.code, 0, result.output);

    const manifest = readFileSync(join(directory, "SHA256SUMS"), "utf8");
    assert.ok(!manifest.includes("notes.txt"));
    assert.ok(manifest.includes("package.exe"));
  });
});

test("verify accepts an unchanged directory", () => {
  withTempDir((directory) => {
    writeFileSync(join(directory, "package.exe"), "a");
    assert.equal(run(["generate", "--dir", directory]).code, 0);
    const result = run(["verify", "--dir", directory]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /Verified 1 files/);
  });
});

test("verify fails when a file was modified", () => {
  withTempDir((directory) => {
    writeFileSync(join(directory, "package.exe"), "a");
    assert.equal(run(["generate", "--dir", directory]).code, 0);
    writeFileSync(join(directory, "package.exe"), "tampered");

    const result = run(["verify", "--dir", directory]);
    assert.equal(result.code, 1);
    assert.match(result.output, /checksum mismatch: package\.exe/);
  });
});

test("verify fails when a listed file disappeared", () => {
  withTempDir((directory) => {
    writeFileSync(join(directory, "package.exe"), "a");
    assert.equal(run(["generate", "--dir", directory]).code, 0);
    rmSync(join(directory, "package.exe"));

    const result = run(["verify", "--dir", directory]);
    assert.equal(result.code, 1);
    assert.match(result.output, /missing file: package\.exe/);
  });
});

test("strict verify fails when a file is not covered by the manifest", () => {
  withTempDir((directory) => {
    writeFileSync(join(directory, "package.exe"), "a");
    assert.equal(run(["generate", "--dir", directory]).code, 0);
    writeFileSync(join(directory, "extra.txt"), "b");

    const lenient = run(["verify", "--dir", directory]);
    assert.equal(lenient.code, 0, lenient.output);

    const strict = run(["verify", "--dir", directory, "--strict"]);
    assert.equal(strict.code, 1);
    assert.match(strict.output, /file is not covered by the manifest: extra\.txt/);
  });
});

test("verify refuses manifest entries that escape the release directory", () => {
  withTempDir((directory) => {
    writeFileSync(
      join(directory, "SHA256SUMS"),
      `${"0".repeat(64)}  ../outside.txt\n`,
      "utf8",
    );
    const result = run(["verify", "--dir", directory]);
    assert.equal(result.code, 1);
    assert.match(result.output, /must be a plain file name/);
  });
});

test("generate fails on an empty directory instead of writing an empty manifest", () => {
  withTempDir((directory) => {
    const result = run(["generate", "--dir", directory]);
    assert.equal(result.code, 1);
    assert.match(result.output, /contains no files to hash/);
  });
});
