#!/usr/bin/env node
/**
 * File-safe SHA-256 checksum generation and verification.
 *
 * Why this exists: shell pipelines such as `sha256sum $(ls)` break on file
 * names that contain spaces (the Windows and macOS installers do), and GNU
 * coreutils are not guaranteed on every build host. This script only uses
 * Node's standard library, so it behaves identically on Linux, macOS and
 * Windows runners.
 *
 * Usage:
 *   node scripts/release/checksums.mjs generate --dir <dir> [--manifest <file>] [--exclude <name>]...
 *   node scripts/release/checksums.mjs verify   --dir <dir> [--manifest <file>] [--strict]
 *
 * The manifest format is the classic `<sha256>  <name>` layout, so a manifest
 * produced here can also be checked with `sha256sum --check` on GNU systems.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const options = { dir: null, manifest: "SHA256SUMS", exclude: [], strict: false };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--dir") {
      options.dir = rest[index + 1];
      index += 1;
    } else if (argument.startsWith("--dir=")) {
      options.dir = argument.slice("--dir=".length);
    } else if (argument === "--manifest") {
      options.manifest = rest[index + 1];
      index += 1;
    } else if (argument.startsWith("--manifest=")) {
      options.manifest = argument.slice("--manifest=".length);
    } else if (argument === "--exclude") {
      options.exclude.push(rest[index + 1]);
      index += 1;
    } else if (argument.startsWith("--exclude=")) {
      options.exclude.push(argument.slice("--exclude=".length));
    } else if (argument === "--strict") {
      options.strict = true;
    }
  }
  return { command, options };
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function hashFile(path) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", rejectPromise);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });
}

/** Reject manifest entries that would escape the release directory. */
function resolveInsideDirectory(directory, name) {
  if (name.includes("\0")) {
    throw new Error("manifest entry contains a null byte");
  }
  if (name.includes("/") || name.includes("\\")) {
    throw new Error(`manifest entry "${name}" must be a plain file name`);
  }
  if (name === "." || name === "..") {
    throw new Error(`manifest entry "${name}" is not a valid file name`);
  }
  const candidate = resolve(directory, name);
  const prefix = resolve(directory) + sep;
  if (!candidate.startsWith(prefix)) {
    throw new Error(`manifest entry "${name}" resolves outside the release directory`);
  }
  return candidate;
}

async function generate(options) {
  const directory = resolve(options.dir);
  if (!existsSync(directory)) {
    fail(`checksum generation failed: ${directory} does not exist`);
    return;
  }
  const manifestPath = join(directory, options.manifest);
  const excluded = new Set([options.manifest, ...options.exclude]);
  const names = readdirSync(directory)
    .filter((name) => !excluded.has(name))
    .filter((name) => statSync(join(directory, name)).isFile())
    .sort();

  if (names.length === 0) {
    fail(`checksum generation failed: ${directory} contains no files to hash`);
    return;
  }

  const lines = [];
  for (const name of names) {
    const digest = await hashFile(join(directory, name));
    lines.push(`${digest}  ${name}`);
  }
  writeFileSync(manifestPath, `${lines.join("\n")}\n`, "utf8");
  console.log(`Wrote ${manifestPath} with ${lines.length} entries.`);
  for (const line of lines) console.log(`  ${line}`);
}

async function verify(options) {
  const directory = resolve(options.dir);
  const manifestPath = join(directory, options.manifest);
  if (!existsSync(manifestPath)) {
    fail(`checksum verification failed: ${manifestPath} does not exist`);
    return;
  }
  const raw = readFileSync(manifestPath, "utf8");
  const entries = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const match = /^([0-9a-f]{64})[ \t]{1,2}(.+)$/.exec(line);
    if (!match) {
      fail(`checksum verification failed: malformed manifest line: ${line}`);
      return;
    }
    entries.push({ digest: match[1], name: match[2] });
  }
  if (entries.length === 0) {
    fail(`checksum verification failed: ${manifestPath} is empty`);
    return;
  }

  const problems = [];
  const seen = new Set();
  for (const entry of entries) {
    seen.add(entry.name);
    let path;
    try {
      path = resolveInsideDirectory(directory, entry.name);
    } catch (error) {
      problems.push(error.message);
      continue;
    }
    if (!existsSync(path)) {
      problems.push(`missing file: ${entry.name}`);
      continue;
    }
    const digest = await hashFile(path);
    if (digest !== entry.digest) {
      problems.push(`checksum mismatch: ${entry.name}`);
    }
  }

  if (options.strict) {
    for (const name of readdirSync(directory)) {
      if (name === options.manifest) continue;
      if (!statSync(join(directory, name)).isFile()) continue;
      if (!seen.has(name)) {
        problems.push(`file is not covered by the manifest: ${name}`);
      }
    }
  }

  if (problems.length > 0) {
    fail(`checksum verification failed:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    return;
  }
  console.log(`Verified ${entries.length} files against ${basename(manifestPath)}.`);
}

const { command, options } = parseArguments(process.argv.slice(2));

if (!options.dir) {
  fail("usage: checksums.mjs <generate|verify> --dir <dir> [--manifest <file>] [--exclude <name>] [--strict]");
} else if (command === "generate") {
  await generate(options);
} else if (command === "verify") {
  await verify(options);
} else {
  fail(`unknown command: ${command ?? "(none)"}`);
}
