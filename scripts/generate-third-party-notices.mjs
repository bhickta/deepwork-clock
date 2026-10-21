#!/usr/bin/env node
/**
 * Generate the THIRD_PARTY_NOTICES file that is attached to every release.
 *
 * The file contains the actual licence texts, not only SPDX identifiers:
 *
 *   - the runtime inventory: the npm runtime dependencies and the Rust crates
 *     that end up in the shipped application,
 *   - the remaining resolved crates (other platforms, build and dev tooling),
 *     listed separately,
 *   - the dev dependency inventory (SPDX identifiers only),
 *   - the project licence and the attribution of the original assets.
 *
 * Every licence text is read from the resolved package source: the npm
 * package directory or the Cargo manifest path reported by `cargo metadata`.
 * Identical texts are printed once and the packages that share them are
 * listed. Packages without a licence file are listed explicitly.
 *
 * The script fails (exit code 1) when the required metadata cannot be
 * resolved or when the runtime inventory would be empty, so an incomplete
 * notices file can never be published silently.
 *
 * Usage: node scripts/generate-third-party-notices.mjs [--out <file>]
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

const outIndex = process.argv.findIndex(
  (argument) => argument === "--out" || argument.startsWith("--out="),
);
const outArgument =
  outIndex === -1
    ? null
    : process.argv[outIndex].startsWith("--out=")
      ? process.argv[outIndex]
      : `--out=${process.argv[outIndex + 1] ?? ""}`;
const outPath = outArgument
  ? resolve(outArgument.slice("--out=".length))
  : join(repoRoot, "THIRD_PARTY_NOTICES.md");

const LICENSE_FILE_PATTERN = /^(LICEN[CS]E|COPYING|NOTICE|COPYRIGHT)([.-].*)?$/i;

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function commandOutput(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (error) {
    const details = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
    throw new Error(
      `${command} ${args.join(" ")} failed: ${details.split("\n").slice(0, 3).join(" ")}`,
      { cause: error },
    );
  }
}

/** Find the licence files that ship with a package directory. */
function findLicenseFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LICENSE_FILE_PATTERN.test(entry.name))
    .map((entry) => join(directory, entry.name))
    .sort();
}

// ---------------------------------------------------------------------------
// npm runtime and development inventory
// ---------------------------------------------------------------------------
const packageJson = readJson(join(repoRoot, "package.json"));
if (!packageJson) {
  fail("package.json is missing or invalid; the npm inventory cannot be resolved");
}

const npmRuntimeNames = Object.keys(packageJson.dependencies ?? {});
const npmDevNames = Object.keys(packageJson.devDependencies ?? {});

function npmPackageDirectory(name) {
  const direct = join(repoRoot, "node_modules", name);
  if (existsSync(direct)) return direct;
  // Fall back to the lockfile location for nested installations.
  const lock = readJson(join(repoRoot, "package-lock.json"));
  const location = lock?.packages?.[`node_modules/${name}`];
  return location ? join(repoRoot, location) : null;
}

const npmRuntime = [];
for (const name of npmRuntimeNames) {
  const directory = npmPackageDirectory(name);
  if (!directory) {
    fail(`the runtime dependency ${name} is not installed; run npm ci before generating the notices`);
  }
  const manifest = readJson(join(directory, "package.json")) ?? {};
  npmRuntime.push({
    ecosystem: "npm",
    name,
    version: manifest.version ?? "unknown",
    identifier:
      typeof manifest.license === "string"
        ? manifest.license
        : (manifest.license?.type ?? "not declared"),
    copyright: manifest.author ?? manifest.contributors ?? null,
    directory,
  });
}

const npmDevelopment = [];
for (const name of npmDevNames) {
  const directory = npmPackageDirectory(name);
  const manifest = directory ? readJson(join(directory, "package.json")) : null;
  npmDevelopment.push({
    name,
    version: manifest?.version ?? "unknown",
    identifier:
      typeof manifest?.license === "string"
        ? manifest.license
        : (manifest?.license?.type ?? "not declared"),
  });
}

// ---------------------------------------------------------------------------
// Rust inventory
// ---------------------------------------------------------------------------
const appManifest = join(repoRoot, "src-tauri", "Cargo.toml");
if (!existsSync(appManifest)) {
  fail("src-tauri/Cargo.toml is missing; the Rust inventory cannot be resolved");
}

let metadata;
try {
  metadata = JSON.parse(
    commandOutput("cargo", ["metadata", "--locked", "--manifest-path", appManifest, "--format-version", "1"]),
  );
} catch (error) {
  fail(`cargo metadata failed, the Rust inventory cannot be resolved: ${error.message}`);
}

let runtimeCrateKeys = new Set();
try {
  const tree = commandOutput("cargo", [
    "tree",
    "--locked",
    "--manifest-path",
    appManifest,
    "--edges",
    "normal",
    "--prefix",
    "none",
    "--format",
    "{p}",
  ]);
  for (const line of tree.split(/\r?\n/)) {
    const match = /^(.+?) v(\S+)$/.exec(line.trim());
    if (match) runtimeCrateKeys.add(`${match[1]}@${match[2]}`);
  }
} catch (error) {
  fail(`cargo tree failed, the runtime inventory cannot be resolved: ${error.message}`);
}

const crateEntries = [];
for (const pkg of metadata.packages ?? []) {
  if (!pkg.source) continue; // local workspace member
  crateEntries.push({
    ecosystem: "cargo",
    name: pkg.name,
    version: pkg.version,
    identifier: pkg.license ?? (pkg.license_file ? `see ${pkg.license_file}` : "not declared"),
    copyright: (pkg.authors ?? []).join(", ") || null,
    directory: dirname(pkg.manifest_path),
  });
}
crateEntries.sort((left, right) => left.name.localeCompare(right.name));

const runtimeCrates = crateEntries.filter((entry) =>
  runtimeCrateKeys.has(`${entry.name}@${entry.version}`),
);
const otherCrates = crateEntries.filter((entry) => !runtimeCrateKeys.has(`${entry.name}@${entry.version}`));

if (runtimeCrates.length === 0 && npmRuntime.length === 0) {
  fail("the runtime inventory is empty; refusing to publish an incomplete notices file");
}

// ---------------------------------------------------------------------------
// Licence texts
// ---------------------------------------------------------------------------
const texts = new Map(); // digest -> { title, body, packages }
const withoutText = [];

function collectText(entry, files) {
  if (files.length === 0) {
    withoutText.push(entry);
    return;
  }
  for (const file of files) {
    let body;
    try {
      body = readFileSync(file, "utf8").replace(/\r\n/g, "\n").trim();
    } catch {
      continue;
    }
    if (body === "") continue;
    const digest = createHash("sha256").update(body).digest("hex");
    const title = `${entry.ecosystem}:${entry.name}@${entry.version} (${file.slice(entry.directory.length + 1)})`;
    if (!texts.has(digest)) {
      texts.set(digest, { title, body, packages: [] });
    }
    texts.get(digest).packages.push(`${entry.ecosystem}:${entry.name}@${entry.version}`);
  }
}

for (const entry of [...npmRuntime, ...runtimeCrates, ...otherCrates]) {
  collectText(entry, findLicenseFiles(entry.directory));
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
const lines = [];
lines.push("# Third-party notices");
lines.push("");
lines.push("Deepwork Clock is distributed under the MIT licence (see `LICENSE` in the source");
lines.push("repository and in this release). This file contains the licence texts of the");
lines.push("third-party components that are redistributed with, or used to build, the released");
lines.push("binaries.");
lines.push("");
lines.push("Generated by `npm run notices` from the committed lockfiles. The Rust inventory is");
lines.push("resolved with `cargo metadata --locked` and `cargo tree --locked`; the npm");
lines.push("inventory comes from `package-lock.json`.");
lines.push("");
lines.push("## Runtime inventory");
lines.push("");
lines.push("These components are part of the shipped application.");
lines.push("");
lines.push("| Component | Version | Licence |");
lines.push("| --- | --- | --- |");
for (const entry of [...npmRuntime, ...runtimeCrates]) {
  lines.push(`| ${entry.ecosystem}: ${entry.name} | ${entry.version} | ${entry.identifier} |`);
}
lines.push("");
lines.push("## Other resolved crates");
lines.push("");
lines.push("Crates that are resolved for other platforms, or that are only used while");
lines.push("building. They are listed for completeness and are not part of the runtime set");
lines.push("of the platform that produced this build.");
lines.push("");
lines.push("| Component | Version | Licence |");
lines.push("| --- | --- | --- |");
for (const entry of otherCrates) {
  lines.push(`| cargo: ${entry.name} | ${entry.version} | ${entry.identifier} |`);
}
lines.push("");
lines.push("## Development dependency inventory");
lines.push("");
lines.push("These packages are only used to build, lint and test the project. They are not");
lines.push("shipped with the application.");
lines.push("");
lines.push("| Package | Version | Licence |");
lines.push("| --- | --- | --- |");
for (const entry of npmDevelopment) {
  lines.push(`| npm: ${entry.name} | ${entry.version} | ${entry.identifier} |`);
}
lines.push("");
lines.push("## Licence texts");
lines.push("");
if (texts.size === 0) {
  lines.push("No licence text could be read from the resolved package sources.");
  lines.push("");
} else {
  for (const [, entry] of texts) {
    lines.push(`### ${entry.title}`);
    lines.push("");
    lines.push(
      `Applies to: ${[...new Set(entry.packages)].sort().join(", ")}`,
    );
    lines.push("");
    lines.push("```");
    lines.push(entry.body);
    lines.push("```");
    lines.push("");
  }
}

lines.push("### Components without a licence file in the resolved sources");
lines.push("");
if (withoutText.length === 0) {
  lines.push("None: every inventoried component ships its licence text.");
} else {
  for (const entry of withoutText) {
    lines.push(`- ${entry.ecosystem}: ${entry.name}@${entry.version} (${entry.identifier})`);
  }
}
lines.push("");

lines.push("## This project");
lines.push("");
lines.push("### Licence");
lines.push("");
const projectLicensePath = join(repoRoot, "LICENSE");
if (existsSync(projectLicensePath)) {
  lines.push("```");
  lines.push(readFileSync(projectLicensePath, "utf8").replace(/\r\n/g, "\n").trim());
  lines.push("```");
} else {
  lines.push("The project licence file (LICENSE) was not found in the repository.");
}
lines.push("");
lines.push("### Original assets");
lines.push("");
lines.push("The application icon (`src-tauri/icons/`) and the tray glyphs are original artwork");
lines.push("created for this project and are licensed under the repository MIT licence. The");
lines.push("SVG sources live in `src-tauri/icons/source/` and can be regenerated with");
lines.push("`npm run icons:generate`. No third-party icon, font, sound or image asset is");
lines.push("bundled with the application.");
lines.push("");

const content = lines.join("\n");
if (outArgument) {
  writeFileSync(outPath, content, "utf8");
  console.log(
    `Wrote ${outPath}: ${npmRuntime.length} runtime npm packages, ${runtimeCrates.length} runtime crates, ${otherCrates.length} other crates, ${texts.size} licence texts, ${withoutText.length} components without a licence file.`,
  );
} else {
  process.stdout.write(content);
}
