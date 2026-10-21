#!/usr/bin/env node
/**
 * Verify that every version field in the repository agrees.
 *
 * Checked locations:
 *   - package.json                -> "version"
 *   - package-lock.json           -> "version" and packages[""].version
 *   - src-tauri/Cargo.toml        -> [package] version
 *   - src-tauri/tauri.conf.json   -> "version"
 *   - src-tauri/src/engine/Cargo.toml -> [package] version
 *   - src-tauri/Cargo.lock        -> the local package entries (when present)
 *
 * Usage:
 *   node scripts/verify-versions.mjs [--strict] [--json]
 *
 *   --strict  Treat a missing Cargo.lock as an error (release builds) and
 *             require every file to exist.
 *   --json    Print machine readable output.
 *
 * Exit code is 0 when every required check passes.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootArgument = process.argv.find((argument) => argument.startsWith("--root="));
const repoRoot = rootArgument
  ? resolve(rootArgument.slice("--root=".length))
  : resolve(scriptDir, "..");
const strict = process.argv.includes("--strict");
const asJson = process.argv.includes("--json");

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

const errors = [];
const warnings = [];
const checked = [];

function rel(path) {
  return relative(repoRoot, path);
}

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    errors.push(`${rel(path)}: invalid JSON (${error.message})`);
    return null;
  }
}

/** Extract the version from the [package] table of a Cargo manifest. */
function readCargoPackageVersion(path) {
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  let inPackage = false;
  for (const line of lines) {
    const section = /^\s*\[([^\]]+)\]/.exec(line);
    if (section) {
      inPackage = section[1].trim() === "package";
      continue;
    }
    if (!inPackage) continue;
    const versionMatch = /^\s*version\s*=\s*"([^"]+)"/.exec(line);
    if (versionMatch) return versionMatch[1];
  }
  errors.push(`${rel(path)}: [package] table has no version field`);
  return null;
}

function checkVersion(source, version) {
  if (version === null || version === undefined) {
    if (strict) {
      errors.push(`${source}: file or version field is missing`);
    } else {
      warnings.push(`${source}: file or version field is missing (not fatal outside --strict)`);
    }
    return;
  }
  if (!SEMVER.test(version)) {
    errors.push(`${source}: "${version}" is not a valid semantic version`);
    return;
  }
  checked.push({ source, version });
}

// package.json
const packageJsonPath = join(repoRoot, "package.json");
const packageJson = readJson(packageJsonPath);
const packageVersion = packageJson?.version ?? null;
checkVersion("package.json", packageVersion);

// package-lock.json
const packageLockPath = join(repoRoot, "package-lock.json");
const packageLock = readJson(packageLockPath);
checkVersion("package-lock.json", packageLock?.version ?? null);
checkVersion(
  "package-lock.json (packages[\"\"])",
  packageLock?.packages?.[""]?.version ?? null,
);

// Cargo manifests and the Tauri configuration.
const cargoVersion = readCargoPackageVersion(join(repoRoot, "src-tauri", "Cargo.toml"));
checkVersion("src-tauri/Cargo.toml [package]", cargoVersion);

const engineVersion = readCargoPackageVersion(
  join(repoRoot, "src-tauri", "src", "engine", "Cargo.toml"),
);
checkVersion("src-tauri/src/engine/Cargo.toml [package]", engineVersion);

const coreVersion = readCargoPackageVersion(
  join(repoRoot, "src-tauri", "src", "core", "Cargo.toml"),
);
checkVersion("src-tauri/src/core/Cargo.toml [package]", coreVersion);

const tauriConfPath = join(repoRoot, "src-tauri", "tauri.conf.json");
const tauriConf = readJson(tauriConfPath);
checkVersion("src-tauri/tauri.conf.json", tauriConf?.version ?? null);

// The About view falls back to a literal when the injected build constant is
// unavailable; a stale fallback would show the wrong version in a release.
const uiVersionPath = join(repoRoot, "src", "version.ts");
if (existsSync(uiVersionPath)) {
  const uiSource = readFileSync(uiVersionPath, "utf8");
  const fallback = /FALLBACK_VERSION\s*=\s*"([^"]+)"/.exec(uiSource);
  if (!fallback) {
    warnings.push("src/version.ts: no FALLBACK_VERSION literal found to cross-check");
  } else {
    checkVersion("src/version.ts (FALLBACK_VERSION)", fallback[1]);
  }
} else {
  warnings.push("src/version.ts: missing, cannot cross-check the About view version");
}

// Cargo.lock: the app, core and engine crates are separate workspace roots and
// therefore keep one lockfile each. All of them are committed for reproducible
// builds.
for (const lockPath of [
  join(repoRoot, "src-tauri", "Cargo.lock"),
  join(repoRoot, "src-tauri", "src", "core", "Cargo.lock"),
  join(repoRoot, "src-tauri", "src", "engine", "Cargo.lock"),
]) {
  const lockRelative = rel(lockPath);
  if (!existsSync(lockPath)) {
    if (strict) {
      errors.push(`${lockRelative}: missing (required for reproducible release builds)`);
    } else {
      warnings.push(`${lockRelative}: missing (run cargo build once in that crate to generate it)`);
    }
    continue;
  }
  const lockText = readFileSync(lockPath, "utf8");
  const entries = [
    ...lockText.matchAll(/^\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"/gm),
  ];
  const localNames = new Set(
    entries.map(([, name]) => name).filter((name) => name.startsWith("deepwork")),
  );
  for (const [, name, version] of entries) {
    if (localNames.has(name)) {
      checkVersion(`${lockRelative} (${name})`, version);
    }
  }
  if (localNames.size === 0) {
    warnings.push(`${lockRelative}: no entry for a local package (expected a package named deepwork*)`);
  }
}

// Cross-check: every recorded version must be identical.
if (checked.length > 0) {
  const distinct = [...new Set(checked.map((entry) => entry.version))];
  if (distinct.length > 1) {
    errors.push(
      `version mismatch:\n${checked
        .filter((entry) => entry.version !== packageVersion)
        .map((entry) => `      ${entry.source} = ${entry.version} (expected ${packageVersion})`)
        .join("\n")}`,
    );
  }
}

if (packageVersion && SEMVER.test(packageVersion)) {
  const [, major, minor, patch, prerelease] = SEMVER.exec(packageVersion);
  console.log(
    `version ${packageVersion} (${major}.${minor}.${patch}${
      prerelease ? `, prerelease "${prerelease}"` : ", stable"
    })`,
  );
  console.log(`expected release tag: v${packageVersion}`);
}

if (asJson) {
  console.log(JSON.stringify({ checked, errors, warnings }, null, 2));
} else {
  for (const warning of warnings) console.warn(`warning: ${warning}`);
  if (errors.length > 0) {
    console.error("version verification FAILED:");
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log(`version verification passed: ${checked.length} locations agree.`);
}
