#!/usr/bin/env node
/**
 * Inspect the committed native icon set and prove that every file is a real
 * image in the expected format and size (no placeholder or renamed files).
 *
 * Usage: node scripts/verify-icons.mjs [--json]
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const iconsDir = join(repoRoot, "src-tauri", "icons");
const sourceDir = join(iconsDir, "source");
const trayDir = join(iconsDir, "tray");

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const failures = [];
const report = [];

function fail(message) {
  failures.push(message);
}

function readPng(filePath) {
  const buffer = readFileSync(filePath);
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    fail(`${filePath}: not a PNG file`);
    return null;
  }
  if (buffer.subarray(12, 16).toString("ascii") !== "IHDR") {
    fail(`${filePath}: missing PNG IHDR chunk`);
    return null;
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const bitDepth = buffer.readUInt8(24);
  const colorType = buffer.readUInt8(25);
  const colorTypes = { 0: "grayscale", 2: "rgb", 3: "palette", 4: "gray+alpha", 6: "rgba" };
  return {
    width,
    height,
    bitDepth,
    colorType,
    colorTypeName: colorTypes[colorType] ?? `unknown(${colorType})`,
    hasAlpha: colorType === 4 || colorType === 6,
    bytes: buffer.length,
  };
}

function expectPng(filePath, expectedWidth, expectedHeight, { requireAlpha = true } = {}) {
  const relative = filePath.slice(repoRoot.length + 1);
  if (!existsSync(filePath)) {
    fail(`${relative}: missing`);
    return;
  }
  const info = readPng(filePath);
  if (!info) return;
  if (info.width !== expectedWidth || info.height !== expectedHeight) {
    fail(`${relative}: expected ${expectedWidth}x${expectedHeight}, found ${info.width}x${info.height}`);
  }
  if (requireAlpha && !info.hasAlpha) {
    fail(`${relative}: expected an alpha channel, found ${info.colorTypeName}`);
  }
  report.push({
    file: relative,
    kind: "png",
    dimensions: `${info.width}x${info.height}`,
    color: `${info.colorTypeName}/${info.bitDepth}-bit`,
    bytes: info.bytes,
  });
}

function expectIco(filePath) {
  const relative = filePath.slice(repoRoot.length + 1);
  if (!existsSync(filePath)) {
    fail(`${relative}: missing`);
    return;
  }
  const buffer = readFileSync(filePath);
  if (buffer.length < 6) {
    fail(`${relative}: too small to be an ICO file`);
    return;
  }
  const reserved = buffer.readUInt16LE(0);
  const type = buffer.readUInt16LE(2);
  const count = buffer.readUInt16LE(4);
  if (reserved !== 0 || type !== 1) {
    fail(`${relative}: not an ICO file (reserved=${reserved}, type=${type})`);
    return;
  }
  const entries = [];
  let offset = 6;
  for (let index = 0; index < count; index += 1) {
    if (offset + 16 > buffer.length) {
      fail(`${relative}: truncated ICO directory`);
      return;
    }
    const width = buffer.readUInt8(offset) || 256;
    const height = buffer.readUInt8(offset + 1) || 256;
    const bytes = buffer.readUInt32LE(offset + 8);
    const dataOffset = buffer.readUInt32LE(offset + 12);
    const isPng = buffer.subarray(dataOffset, dataOffset + 8).equals(PNG_SIGNATURE);
    if (dataOffset + bytes > buffer.length) {
      fail(`${relative}: ICO entry ${index} points outside the file`);
      return;
    }
    entries.push({ size: `${width}x${height}`, encoding: isPng ? "png" : "bmp", bytes });
    offset += 16;
  }
  const required = ["16x16", "32x32", "256x256"];
  for (const size of required) {
    if (!entries.some((entry) => entry.size === size)) {
      fail(`${relative}: missing ${size} entry`);
    }
  }
  report.push({
    file: relative,
    kind: "ico",
    dimensions: entries.map((entry) => entry.size).join(", "),
    color: "32bpp",
    bytes: buffer.length,
  });
}

function expectIcns(filePath) {
  const relative = filePath.slice(repoRoot.length + 1);
  if (!existsSync(filePath)) {
    fail(`${relative}: missing`);
    return;
  }
  const buffer = readFileSync(filePath);
  if (buffer.length < 8 || buffer.subarray(0, 4).toString("ascii") !== "icns") {
    fail(`${relative}: not an ICNS file`);
    return;
  }
  const declaredSize = buffer.readUInt32BE(4);
  if (declaredSize !== buffer.length) {
    fail(`${relative}: ICNS header declares ${declaredSize} bytes, file holds ${buffer.length}`);
  }
  const types = [];
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const type = buffer.subarray(offset, offset + 4).toString("ascii");
    const size = buffer.readUInt32BE(offset + 4);
    if (size < 8 || offset + size > buffer.length) {
      fail(`${relative}: invalid ICNS entry ${type} at offset ${offset}`);
      break;
    }
    types.push(type);
    offset += size;
  }
  for (const required of ["ic07", "ic08", "ic09"]) {
    if (!types.includes(required)) {
      fail(`${relative}: missing ${required} (128/256/512 px) entry`);
    }
  }
  report.push({
    file: relative,
    kind: "icns",
    dimensions: types.join(", "),
    color: "rgba",
    bytes: buffer.length,
  });
}

function expectSvg(filePath) {
  const relative = filePath.slice(repoRoot.length + 1);
  if (!existsSync(filePath)) {
    fail(`${relative}: missing`);
    return;
  }
  const content = readFileSync(filePath, "utf8");
  if (!content.includes("<svg")) {
    fail(`${relative}: does not contain an <svg> element`);
    return;
  }
  const viewBox = /viewBox="([^"]+)"/.exec(content);
  if (!viewBox) {
    fail(`${relative}: missing viewBox`);
    return;
  }
  report.push({
    file: relative,
    kind: "svg",
    dimensions: viewBox[1],
    color: "vector",
    bytes: Buffer.byteLength(content),
  });
}

expectPng(join(iconsDir, "icon.png"), 512, 512);
expectPng(join(iconsDir, "32x32.png"), 32, 32);
expectPng(join(iconsDir, "128x128.png"), 128, 128);
expectPng(join(iconsDir, "128x128@2x.png"), 256, 256);
expectIco(join(iconsDir, "icon.ico"));
expectIcns(join(iconsDir, "icon.icns"));
expectSvg(join(sourceDir, "deepwork-clock.svg"));
expectPng(join(trayDir, "deepwork-clock-tray-on-dark.png"), 64, 64);
expectPng(join(trayDir, "deepwork-clock-tray-on-light.png"), 64, 64);

if (existsSync(iconsDir)) {
  const unexpected = readdirSync(iconsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !["source", "tray"].includes(name));
  if (unexpected.length > 0) {
    fail(`unexpected directories in src-tauri/icons: ${unexpected.join(", ")}`);
  }
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ report, failures }, null, 2));
} else {
  for (const entry of report) {
    console.log(`${entry.file.padEnd(58)} ${entry.kind.padEnd(5)} ${String(entry.dimensions).padEnd(46)} ${entry.color}`);
  }
  if (failures.length > 0) {
    console.error("\nicon verification FAILED:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`\nicon verification passed: ${report.length} files inspected.`);
}
