#!/usr/bin/env node
/**
 * Final gate for a release directory.
 *
 * Runs after the packages, the build metadata and the third-party notices have
 * been assembled, and before anything is published. It checks that:
 *
 *   - the checksum manifest exists and matches every file,
 *   - every file in the directory is covered by the manifest,
 *   - the notices, the checksum manifest and the per-target build metadata are
 *     present,
 *   - every expected target contributed its packages.
 *
 * Usage: node scripts/release/verify-release.mjs --dir <dir> [--targets linux-x64,windows-x64,...]
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const checksums = join(scriptDir, "checksums.mjs");

const EXPECTED_PACKAGES = {
  "linux-x64": [".deb", ".AppImage"],
  "windows-x64": [".exe"],
  "macos-arm64": [".dmg", ".app.tar.gz"],
  "macos-x64": [".dmg", ".app.tar.gz"],
};

function parseArguments(argv) {
  const options = { dir: null, targets: Object.keys(EXPECTED_PACKAGES) };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dir") {
      options.dir = argv[++index];
    } else if (argument.startsWith("--dir=")) {
      options.dir = argument.slice("--dir=".length);
    } else if (argument === "--targets") {
      options.targets = argv[++index].split(",").map((value) => value.trim()).filter(Boolean);
    } else if (argument.startsWith("--targets=")) {
      options.targets = argument
        .slice("--targets=".length)
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    }
  }
  return options;
}

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

const options = parseArguments(process.argv.slice(2));
if (!options.dir) {
  fail("usage: verify-release.mjs --dir <dir> [--targets a,b,c]");
}

const directory = resolve(options.dir);
if (!existsSync(directory)) {
  fail(`the release directory ${directory} does not exist`);
}

const files = readdirSync(directory).filter((name) => statSync(join(directory, name)).isFile());
const problems = [];

for (const required of ["SHA256SUMS", "THIRD_PARTY_NOTICES.md", "LICENSE"]) {
  if (!files.includes(required)) {
    problems.push(`missing ${required}`);
  }
}

for (const target of options.targets) {
  const metadata = files.find((name) => name === `build-metadata-${target}.json`);
  if (!metadata) {
    problems.push(`missing build-metadata-${target}.json`);
    continue;
  }
  try {
    const parsed = JSON.parse(readFileSync(join(directory, metadata), "utf8"));
    if (parsed.signed !== false || parsed.notarized !== false) {
      problems.push(`${metadata}: the signing flags must state that the build is unsigned`);
    }
    if (parsed.target !== target) {
      problems.push(`${metadata}: reports target ${parsed.target}`);
    }
  } catch (error) {
    problems.push(`${metadata}: invalid JSON (${error.message})`);
  }
}

// Every target must have contributed its packages.
for (const target of options.targets) {
  const extensions = EXPECTED_PACKAGES[target] ?? [];
  for (const extension of extensions) {
    const matches = files.filter((name) => name.endsWith(extension) && !name.endsWith(".json"));
    if (matches.length === 0) {
      problems.push(`no ${extension} package for ${target}`);
    }
  }
}

if (problems.length === 0) {
  // The checksum verification is the last step: it proves that the manifest
  // covers every file and that no file was changed on the way.
  try {
    const output = execFileSync(
      process.execPath,
      [checksums, "verify", "--dir", directory, "--manifest", "SHA256SUMS", "--strict"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    console.log(output.trim());
  } catch (error) {
    fail(`checksum verification failed:\n${error.stdout ?? ""}${error.stderr ?? ""}`);
  }
}

if (problems.length > 0) {
  fail(`the release directory is incomplete:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
}

console.log(
  `Release directory ${directory} is complete: ${files.length} files, ${options.targets.length} targets.`,
);
