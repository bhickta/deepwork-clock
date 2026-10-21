#!/usr/bin/env node
/**
 * Regenerate every native icon from the original SVG sources in
 * src-tauri/icons/source/.
 *
 * Pipeline:
 *   1. Rasterise the 1024x1024 application SVG to a square PNG
 *      (rsvg-convert when available, otherwise ImageMagick's internal SVG
 *      renderer, otherwise a clear failure - no silent fallbacks).
 *   2. Hand that PNG to the Tauri CLI (`tauri icon`), which writes the
 *      platform icon set (PNG set, .ico, .icns, StoreLogo, Square logos).
 *   3. Rasterise the two tray glyphs to 64x64 RGBA PNGs for the system tray.
 *
 * Usage: node scripts/icons/generate-icons.mjs [--check]
 *   --check  Only report what would change; do not write files.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..", "..");
const iconsDir = join(repoRoot, "src-tauri", "icons");
const sourceDir = join(iconsDir, "source");
const trayDir = join(iconsDir, "tray");

const appSvg = join(sourceDir, "deepwork-clock.svg");
const traySvgs = [
  { svg: join(sourceDir, "tray-on-dark.svg"), png: join(trayDir, "deepwork-clock-tray-on-dark.png") },
  { svg: join(sourceDir, "tray-on-light.svg"), png: join(trayDir, "deepwork-clock-tray-on-light.png") },
];

const checkOnly = process.argv.includes("--check");

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
}

function hasCommand(command) {
  try {
    execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Rasterise an SVG to a PNG of the requested square size. */
function rasterize(svgPath, pngPath, size) {
  if (hasCommand("rsvg-convert")) {
    run("rsvg-convert", ["-w", String(size), "-h", String(size), "-o", pngPath, svgPath]);
    return "rsvg-convert";
  }
  if (hasCommand("convert")) {
    // PNG32: forces a real 32-bit RGBA output instead of ImageMagick's default
    // palette optimisation, which some platform tray APIs reject.
    run("convert", [
      "-background",
      "none",
      "-density",
      "384",
      svgPath,
      "-resize",
      `${size}x${size}`,
      "-depth",
      "8",
      `PNG32:${pngPath}`,
    ]);
    return "ImageMagick convert (internal SVG renderer)";
  }
  throw new Error(
    "No SVG rasteriser found. Install librsvg2-bin (rsvg-convert) or ImageMagick, then re-run.",
  );
}

function pngSize(pngPath) {
  const buffer = readFileSync(pngPath);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buffer.subarray(0, 8).equals(signature)) {
    throw new Error(`${pngPath} is not a PNG file`);
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function main() {
  if (!existsSync(appSvg)) {
    throw new Error(`Missing source artwork: ${appSvg}`);
  }

  const staging = join(tmpdir(), "deepwork-clock-icons");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  const sourcePng = join(staging, "deepwork-clock-1024.png");
  const rasteriser = rasterize(appSvg, sourcePng, 1024);
  const size = pngSize(sourcePng);
  if (size.width !== 1024 || size.height !== 1024) {
    throw new Error(`Rasterised source is ${size.width}x${size.height}, expected 1024x1024`);
  }
  console.log(`Rasterised ${appSvg} -> ${sourcePng} (1024x1024) with ${rasteriser}`);

  // The Tauri CLI writes the full platform icon set.
  const tauriCli = join(repoRoot, "node_modules", "@tauri-apps", "cli", "tauri.js");
  if (!existsSync(tauriCli)) {
    throw new Error("Tauri CLI not installed. Run `npm install` first.");
  }
  const tauriArgs = ["icon", sourcePng, "--output", iconsDir];
  if (checkOnly) {
    console.log(`Would run: npx tauri ${tauriArgs.join(" ")}`);
  } else {
    run(process.execPath, [tauriCli, ...tauriArgs]);
    console.log(`Generated native icon set in ${iconsDir}`);
    // The Tauri CLI also emits mobile assets. This project is desktop only,
    // so they are removed to keep the icon tree honest and reviewable.
    for (const mobile of ["android", "ios"]) {
      const mobileDir = join(iconsDir, mobile);
      if (existsSync(mobileDir)) {
        rmSync(mobileDir, { recursive: true, force: true });
        console.log(`Removed unused mobile icon directory ${mobileDir}`);
      }
    }
  }

  mkdirSync(trayDir, { recursive: true });
  for (const tray of traySvgs) {
    if (checkOnly) {
      console.log(`Would render ${tray.svg} -> ${tray.png} (64x64)`);
      continue;
    }
    rasterize(tray.svg, tray.png, 64);
    const traySize = pngSize(tray.png);
    if (traySize.width !== 64 || traySize.height !== 64) {
      throw new Error(`Tray icon ${tray.png} is ${traySize.width}x${traySize.height}, expected 64x64`);
    }
    console.log(`Rendered ${tray.png} (64x64)`);
  }
}

try {
  main();
} catch (error) {
  console.error(`icon generation failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
