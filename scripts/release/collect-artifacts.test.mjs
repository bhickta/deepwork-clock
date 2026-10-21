#!/usr/bin/env node
/**
 * Tests for the release artifact collector.
 *
 * Run with: npm run test:scripts   (node --test scripts/)
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { detectArchitecture } from "./collect-artifacts.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const collector = join(scriptDir, "collect-artifacts.mjs");

function runCollector(args) {
  try {
    const output = execFileSync(process.execPath, [collector, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
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
  const directory = mkdtempSync(join(tmpdir(), "deepwork-collect-"));
  try {
    return body(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function writeElf(path, machine) {
  const buffer = Buffer.alloc(64);
  buffer.write("\x7fELF", 0, "ascii");
  buffer.writeUInt16LE(2, 16); // 64 bit
  buffer.writeUInt16LE(machine, 18);
  writeFileSync(path, buffer);
}

function writeMachO(path, cpuType) {
  const buffer = Buffer.alloc(64);
  buffer.writeUInt32LE(0xfeedfacf, 0);
  buffer.writeUInt32LE(cpuType, 4);
  writeFileSync(path, buffer);
}

function writePe(path, machine) {
  const buffer = Buffer.alloc(256);
  buffer.write("MZ", 0, "ascii");
  buffer.writeUInt32LE(0x80, 0x3c);
  buffer.write("PE\0\0", 0x80, "ascii");
  buffer.writeUInt16LE(machine, 0x84);
  writeFileSync(path, buffer);
}

test("detectArchitecture recognises an x86_64 ELF binary", () => {
  withTempDir((directory) => {
    const path = join(directory, "app");
    writeElf(path, 62);
    assert.deepEqual(detectArchitecture(path), { format: "elf", machine: 62, arch: "x86_64" });
  });
});

test("detectArchitecture recognises an arm64 Mach-O binary", () => {
  withTempDir((directory) => {
    const path = join(directory, "app");
    writeMachO(path, 0x0100000c);
    assert.equal(detectArchitecture(path).arch, "arm64");
  });
});

test("detectArchitecture recognises an x86_64 PE binary", () => {
  withTempDir((directory) => {
    const path = join(directory, "app.exe");
    writePe(path, 0x8664);
    assert.equal(detectArchitecture(path).arch, "x86_64");
  });
});

test("detectArchitecture reports unknown binaries instead of guessing", () => {
  withTempDir((directory) => {
    const path = join(directory, "notes.txt");
    writeFileSync(path, "not a binary");
    assert.equal(detectArchitecture(path).arch, "unknown");
  });
});

test("the collector fails when the bundle directory does not exist", () => {
  withTempDir((directory) => {
    const result = runCollector([
      "--target",
      "linux-x64",
      "--bundle-dir",
      join(directory, "missing"),
      "--stage",
      join(directory, "stage"),
      "--version",
      "0.1.0-alpha.1",
    ]);
    assert.equal(result.code, 1);
    assert.match(result.output, /bundle directory .* does not exist/);
  });
});

test("the collector fails when an expected package is missing", () => {
  withTempDir((directory) => {
    const bundle = join(directory, "bundle");
    mkdirSync(join(bundle, "deb"), { recursive: true });
    mkdirSync(join(bundle, "appimage"), { recursive: true });
    // Only the .deb exists; the AppImage is missing.
    writeFileSync(join(bundle, "deb", "deepwork-clock_0.1.0-alpha.1_amd64.deb"), "package");
    // The compiled binary next to the bundle directory proves the architecture.
    writeElf(join(directory, "deepwork-clock"), 62);

    const result = runCollector([
      "--target",
      "linux-x64",
      "--bundle-dir",
      bundle,
      "--stage",
      join(directory, "stage"),
      "--version",
      "0.1.0-alpha.1",
    ]);
    assert.equal(result.code, 1);
    assert.match(result.output, /expected at least 1 appimage package/);
  });
});

test("the collector fails when the binary architecture does not match", () => {
  withTempDir((directory) => {
    const bundle = join(directory, "bundle");
    mkdirSync(join(bundle, "deb"), { recursive: true });
    mkdirSync(join(bundle, "appimage"), { recursive: true });
    writeFileSync(join(bundle, "deb", "deepwork-clock_0.1.0-alpha.1_amd64.deb"), "package");
    writeFileSync(join(bundle, "appimage", "DeepworkClock.AppImage"), "package");
    // An arm64 binary in a linux-x64 build is a packaging mistake.
    writeElf(join(directory, "deepwork-clock"), 183);

    const result = runCollector([
      "--target",
      "linux-x64",
      "--bundle-dir",
      bundle,
      "--stage",
      join(directory, "stage"),
      "--version",
      "0.1.0-alpha.1",
    ]);
    assert.equal(result.code, 1);
    assert.match(result.output, /no x86_64 application binary was found/);
  });
});

test("the collector refuses an unknown target", () => {
  withTempDir((directory) => {
    const result = runCollector([
      "--target",
      "solaris-sparc",
      "--bundle-dir",
      directory,
      "--stage",
      join(directory, "stage"),
    ]);
    assert.equal(result.code, 1);
    assert.match(result.output, /unknown target/);
  });
});
