#!/usr/bin/env node
/**
 * Collect the native packages of one release target into a staging directory.
 *
 * The script is deliberately strict: every expected package for the target
 * must exist, the built binary must match the expected CPU architecture, and
 * nothing is copied "just in case". A missing package fails the build instead
 * of producing a release that only contains an icon.
 *
 * Usage:
 *   node scripts/release/collect-artifacts.mjs \
 *     --target linux-x64 \
 *     --bundle-dir src-tauri/target/x86_64-unknown-linux-gnu/release/bundle \
 *     --stage release/linux-x64 \
 *     --version 0.1.0-alpha.1 \
 *     --tag v0.1.0-alpha.1 \
 *     --commit <sha> \
 *     --runner-os ubuntu-24.04
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export const TARGETS = {
  "linux-x64": {
    triple: "x86_64-unknown-linux-gnu",
    arch: "x86_64",
    packages: [
      { kind: "deb", extension: ".deb", directory: "deb", minimum: 1 },
      { kind: "appimage", extension: ".AppImage", directory: "appimage", minimum: 1 },
    ],
  },
  "windows-x64": {
    triple: "x86_64-pc-windows-msvc",
    arch: "x86_64",
    packages: [
      { kind: "nsis", extension: ".exe", directory: "nsis", minimum: 1 },
    ],
  },
  "macos-arm64": {
    triple: "aarch64-apple-darwin",
    arch: "arm64",
    packages: [
      { kind: "dmg", extension: ".dmg", directory: "dmg", minimum: 1 },
      { kind: "app", extension: ".app.tar.gz", directory: "macos", minimum: 1 },
    ],
  },
  "macos-x64": {
    triple: "x86_64-apple-darwin",
    arch: "x86_64",
    packages: [
      { kind: "dmg", extension: ".dmg", directory: "dmg", minimum: 1 },
      { kind: "app", extension: ".app.tar.gz", directory: "macos", minimum: 1 },
    ],
  },
};

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const equals = argument.indexOf("=");
    const [flag, inlineValue] =
      argument.startsWith("--") && equals !== -1
        ? [argument.slice(0, equals), argument.slice(equals + 1)]
        : [argument, undefined];
    const value = inlineValue ?? argv[++index];
    options[flag.replace(/^--/, "")] = value;
  }
  return options;
}

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

/** Detect the CPU architecture of a Mach-O, ELF or PE binary. */
export function detectArchitecture(path) {
  const buffer = readFileSync(path);

  if (buffer.length > 20 && buffer[0] === 0x7f && buffer.toString("ascii", 1, 4) === "ELF") {
    const machine = buffer.readUInt16LE(18);
    return {
      format: "elf",
      machine,
      arch: machine === 62 ? "x86_64" : machine === 183 ? "arm64" : `unknown(${machine})`,
    };
  }

  const magic = buffer.readUInt32LE(0);
  if (magic === 0xfeedfacf || magic === 0xcffaedfe) {
    const cpuType = buffer.readUInt32LE(4);
    return {
      format: "mach-o",
      machine: cpuType,
      arch:
        cpuType === 0x01000007
          ? "x86_64"
          : cpuType === 0x0100000c
            ? "arm64"
            : `unknown(0x${cpuType.toString(16)})`,
    };
  }
  if (magic === 0xcafebabe || magic === 0xbebafeca) {
    const count = buffer.readUInt32BE(4);
    const arches = [];
    for (let index = 0; index < count; index += 1) {
      const cpuType = buffer.readUInt32BE(8 + index * 20);
      arches.push(
        cpuType === 0x01000007
          ? "x86_64"
          : cpuType === 0x0100000c
            ? "arm64"
            : `unknown(0x${cpuType.toString(16)})`,
      );
    }
    return { format: "fat", machine: 0, arch: arches.join("+") };
  }

  if (buffer.length > 64 && buffer.toString("ascii", 0, 2) === "MZ") {
    const peOffset = buffer.readUInt32LE(0x3c);
    if (buffer.toString("ascii", peOffset, peOffset + 4) === "PE\0\0") {
      const machine = buffer.readUInt16LE(peOffset + 4);
      return {
        format: "pe",
        machine,
        arch:
          machine === 0x8664 ? "x86_64" : machine === 0xaa64 ? "arm64" : `unknown(0x${machine.toString(16)})`,
      };
    }
  }

  return { format: "unknown", machine: 0, arch: "unknown" };
}

function commandOutput(command, args) {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

function main(argv) {
  const options = parseArguments(argv);
  const target = options.target;
  const specification = TARGETS[target];
  if (!specification) {
    fail(`unknown target "${target}". Known targets: ${Object.keys(TARGETS).join(", ")}`);
  }
  if (!options["bundle-dir"] || !options.stage) {
    fail("usage: collect-artifacts.mjs --target <target> --bundle-dir <dir> --stage <dir> --version <v>");
  }

  const bundleDir = resolve(options["bundle-dir"]);
  const stageDir = resolve(options.stage);
  const version = options.version ?? "0.0.0";
  const expectedTriple = options["expected-triple"] ?? specification.triple;

  if (!existsSync(bundleDir)) {
    fail(`bundle directory ${bundleDir} does not exist; the Tauri build produced no packages`);
  }

  // The compiler host triple proves which architecture was actually built.
  const rustcVerbose = commandOutput("rustc", ["-vV"]);
  const hostTriple = rustcVerbose ? (/^host: (.+)$/m.exec(rustcVerbose)?.[1] ?? null) : null;
  if (hostTriple && hostTriple !== expectedTriple) {
    fail(`the Rust host triple is ${hostTriple}, expected ${expectedTriple} for ${target}`);
  }

  // The runner architecture proves which machine produced the package.
  const runnerArch = commandOutput("uname", ["-m"]);
  if (runnerArch && runnerArch !== specification.arch) {
    fail(`the runner architecture is ${runnerArch}, expected ${specification.arch} for ${target}`);
  }

  // The compiled application binary must match the expected architecture.
  const binaryDirectory = resolve(bundleDir, "..");
  let detectedBinary = null;
  if (existsSync(binaryDirectory)) {
    for (const entry of readdirSync(binaryDirectory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const candidate = join(binaryDirectory, entry.name);
      let detected;
      try {
        detected = detectArchitecture(candidate);
      } catch {
        continue;
      }
      if (detected.format === "unknown") continue;
      if (detected.arch === specification.arch) {
        detectedBinary = { path: candidate, ...detected };
        break;
      }
    }
  }
  if (!detectedBinary) {
    fail(
      `no ${specification.arch} application binary was found in ${binaryDirectory}; the build did not produce a ${expectedTriple} binary`,
    );
  }

  mkdirSync(stageDir, { recursive: true });
  const collected = [];

  for (const expected of specification.packages) {
    const sourceDir = join(bundleDir, expected.directory);
    if (!existsSync(sourceDir)) {
      fail(`expected ${expected.kind} packages in ${sourceDir}, but the directory does not exist`);
    }

    if (expected.kind === "app") {
      const appDirectories = readdirSync(sourceDir).filter((entry) => entry.endsWith(".app"));
      if (appDirectories.length === 0) {
        fail(`no .app bundle was found in ${sourceDir}`);
      }
      for (const appDirectory of appDirectories) {
        const archiveName = `DeepworkClock-${version}-${target}.app.tar.gz`;
        const archivePath = join(stageDir, archiveName);
        rmSync(archivePath, { force: true });
        const created = commandOutput("tar", ["-czf", archivePath, "-C", sourceDir, appDirectory]);
        if (created === null || !existsSync(archivePath)) {
          fail(`failed to create ${archivePath}`);
        }
        collected.push({
          kind: expected.kind,
          file: archiveName,
          bytes: statSync(archivePath).size,
        });
      }
      continue;
    }

    const matches = readdirSync(sourceDir).filter((entry) => entry.endsWith(expected.extension));
    if (matches.length < expected.minimum) {
      fail(
        `expected at least ${expected.minimum} ${expected.kind} package(s) in ${sourceDir}, found ${matches.length}`,
      );
    }
    for (const match of matches) {
      const source = join(sourceDir, match);
      const destination = join(stageDir, match);
      copyFileSync(source, destination);
      collected.push({ kind: expected.kind, file: match, bytes: statSync(destination).size });
    }
  }

  if (collected.length === 0) {
    fail(`no release packages were collected for ${target}`);
  }

  const metadata = {
    product: "Deepwork Clock",
    version,
    tag: options.tag ?? `v${version}`,
    commit: options.commit ?? null,
    target,
    triple: expectedTriple,
    runner_arch: runnerArch,
    rust_host: hostTriple,
    binary: {
      file: basename(detectedBinary.path),
      format: detectedBinary.format,
      arch: detectedBinary.arch,
    },
    signed: false,
    notarized: false,
    rustc: commandOutput("rustc", ["--version"]),
    cargo: commandOutput("cargo", ["--version"]),
    node: process.version,
    npm: commandOutput("npm", ["--version"]),
    tauri_cli: (() => {
      try {
        return JSON.parse(readFileSync(resolve("node_modules/@tauri-apps/cli/package.json"), "utf8")).version;
      } catch {
        return null;
      }
    })(),
    runner_os: options["runner-os"] ?? process.platform,
    packages: collected,
  };

  const metadataPath = join(stageDir, "build-metadata.json");
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

  console.log(`Collected ${collected.length} package(s) for ${target} (${expectedTriple}):`);
  for (const entry of collected) console.log(`  ${entry.file} (${entry.bytes} bytes)`);
  console.log(`Wrote ${metadataPath}`);
}

if (process.argv[1] && process.argv[1].endsWith("collect-artifacts.mjs")) {
  main(process.argv.slice(2));
}
