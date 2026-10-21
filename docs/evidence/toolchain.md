# Toolchain and support matrix evidence

Recorded for Deepwork Clock `0.1.0-alpha.1`.

This file records what was **actually observed** while preparing the build,
release and documentation tooling. It separates facts from intentions: a
version that is merely *advertised* by a toolkit is not a version this project
has tested.

## 1. Host used for the local checks

| Tool | Observed version | Source |
| --- | --- | --- |
| Operating system | Ubuntu 24.04.4 LTS, x86_64 | `cat /etc/os-release` |
| Kernel | 5.15.0-generic | `uname -a` |
| Node.js | v24.11.1 | `node --version` |
| npm | 11.6.2 | `npm --version` |
| Rust | 1.95.0 (59807616e 2026-04-14) | `rustc --version` |
| Cargo | 1.95.0 (f2d3ce0bd 2026-03-21) | `cargo --version` |
| rustup | 1.29.0 | `rustup --version` |
| Git | 2.43.0 | `git --version` |
| ImageMagick | 6.9.12-98 Q16 | `convert --version` |
| Playwright CLI | 1.64.1 | `npx playwright --version` |
| CPUs / RAM | 12 cores / 31 GiB | `nproc`, `free -h` |

### Native build environment

The desktop crate needs GTK and WebKitGTK development headers, which are not
installed on the host above. The native checks were therefore executed inside
the provisioned container `deepwork-clock-build:local`
(`/tmp/deepwork-native-build/run.py`), built from `ubuntu:24.04` with
`build-essential`, `pkg-config`, `libgtk-3-dev`, `libwebkit2gtk-4.1-dev`,
`libayatana-appindicator3-dev`, `librsvg2-dev`, `libxdo-dev`, `patchelf`,
`file`, `python3`, `xvfb` and `xauth`.

Inside that container:

| Tool | Observed version |
| --- | --- |
| rustc | 1.95.0 (59807616e 2026-04-14) |
| cargo | 1.95.0 (f2d3ce0bd 2026-03-21) |
| Node.js | v24.11.1 |
| npm | 11.6.2 |
| webkit2gtk-4.1 | 2.52.6 (`pkg-config --modversion webkit2gtk-4.1`) |

`rsvg-convert` is **not** available on the host, so the icon pipeline falls
back to ImageMagick's internal SVG renderer (see section 5).

## 2. Pinned versions in the repository

### JavaScript (exact versions, no ranges)

| Package | Version | Why this version |
| --- | --- | --- |
| `@tauri-apps/api` | 2.12.4 | Matches the `@tauri-apps/cli` 2.12.4 below |
| `@tauri-apps/cli` | 2.12.4 | Latest stable CLI (`npm view @tauri-apps/cli version`) |
| `typescript` | 6.0.3 | Newest release that satisfies `typescript-eslint@8.72.0` (`typescript >=4.8.4 <6.1.0`) |
| `typescript-eslint` | 8.72.0 | Latest stable; supports ESLint 10 (`peer eslint ^8.57 || ^9 || ^10`) |
| `eslint` | 10.13.0 | Latest stable; `engines.node >=20.19 || ^22.13 || >=24` |
| `@eslint/js` | 10.0.1 | The rule set that ships with ESLint 10 |
| `globals` | 17.13.0 | Latest stable; provides the browser and node globals |
| `vite` | 8.3.5 | Latest stable; `engines.node ^20.19 || ^22.12 || >=24` |
| `vitest` | 5.0.5 | Requires `vite ^6.4 || ^7 || ^8` and `node ^22.12 || ^24 || >=26` |
| `jsdom` | 29.1.1 | **Not** 30.x: jsdom 30 requires `node ^24.15.0` and the pinned Node is 24.11.1 |
| `@playwright/test` | 1.64.1 | Latest stable |
| `@axe-core/playwright` | 4.14.0 | Latest stable |
| `@types/node` | 24.19.2 | Matches the Node 24 major version |

The lockfile (`package-lock.json`, `lockfileVersion` 3) is committed and CI
installs with `npm ci`.

### Rust

`rust-toolchain.toml` pins `channel = "1.95.0"` with the `clippy` and
`rustfmt` components and the `minimal` profile. The pinned version is the one
that is installed locally and in the native container; it was **not** upgraded
beyond it, because there is no evidence that a newer stable release is needed.

Three crates are separate Cargo workspace roots and keep one lockfile each:

| Crate | Manifest | Lockfile |
| --- | --- | --- |
| desktop application | `src-tauri/Cargo.toml` | `src-tauri/Cargo.lock` |
| service, storage, history | `src-tauri/src/core/Cargo.toml` | `src-tauri/src/core/Cargo.lock` |
| pure timer engine | `src-tauri/src/engine/Cargo.toml` | `src-tauri/src/engine/Cargo.lock` |

All three are committed, and CI builds and tests with `--locked`.

## 3. Version agreement

`npm run verify:versions` checks `package.json`, `package-lock.json`,
`src-tauri/Cargo.toml`, `src-tauri/src/core/Cargo.toml`,
`src-tauri/src/engine/Cargo.toml`, `src-tauri/tauri.conf.json`, the three
Cargo lock files and the fallback version literal in `src/version.ts`. The
About view receives the version at build time through the Vite `define`
`__APP_VERSION__`, which is read from `package.json`, so the displayed version
cannot drift from the released one.

## 4. GitHub Actions pins

Every action is pinned to an immutable commit SHA that was resolved from the
official repository (`git ls-remote`), never guessed:

| Action | SHA | Tag it points at |
| --- | --- | --- |
| `actions/checkout` | `3d3c42e5aac5ba805825da76410c181273ba90b1` | `v7.0.1` |
| `actions/setup-node` | `949feb2413d6458794dcd2491c4babbbce0c15c1` | `v7.1.0` |
| `actions/upload-artifact` | `cf430e030ddbb5b0abf93d22962f4752f3646cd9` | `v7.0.2` |
| `actions/download-artifact` | `9000827ccba6bdab643e8b6fd33ac0654aef8333` | `v8.0.2` |

No third-party action is used. The Rust toolchain comes from
`rust-toolchain.toml`, the Tauri packages are built with the pinned
`@tauri-apps/cli` (`npm run tauri build`), and the release is published with
the `gh` CLI that is preinstalled on the hosted runners. Workflow permissions
are `contents: read` everywhere; only the publishing job of the release
workflow requests `contents: write`.

## 5. Hosted runner matrix

| Target | Runner label | Rust target triple | Packages |
| --- | --- | --- | --- |
| Linux x86_64 | `ubuntu-24.04` | `x86_64-unknown-linux-gnu` | `.deb`, `.AppImage` |
| Windows x86_64 | `windows-2025` | `x86_64-pc-windows-msvc` | NSIS `.exe` |
| macOS arm64 | `macos-15` | `aarch64-apple-darwin` | `.dmg`, `.app.tar.gz` |
| macOS x86_64 | `macos-15-intel` | `x86_64-apple-darwin` | `.dmg`, `.app.tar.gz` |

The runner labels come from the official `actions/runner-images` README. The
architecture of every build is verified inside the job: the release tooling
compares the Rust host triple, `uname -m` and the CPU architecture recorded in
the produced Mach-O/ELF/PE binary, and fails the build on a mismatch. A runner
label alone is not treated as proof.

Linux build dependencies installed in CI: `libgtk-3-dev`,
`libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`,
`patchelf`, `libxdo-dev`, `file`.

## 6. Icon generation

| Item | Value |
| --- | --- |
| Source artwork | `src-tauri/icons/source/deepwork-clock.svg` (original, 1024x1024 viewBox) |
| Tray sources | `src-tauri/icons/source/tray-on-dark.svg`, `tray-on-light.svg` |
| Rasteriser | ImageMagick `convert` (internal SVG renderer); `rsvg-convert` is used when present |
| Native formats | `npm run icons:generate` → `npx tauri icon <1024px png> --output src-tauri/icons` |
| Command | `node scripts/icons/generate-icons.mjs` |

Generated and verified files (`npm run verify:icons`):

| File | Measured |
| --- | --- |
| `icon.png` | 512x512, 8-bit RGBA |
| `32x32.png` | 32x32, 8-bit RGBA |
| `128x128.png` | 128x128, 8-bit RGBA |
| `128x128@2x.png` | 256x256, 8-bit RGBA |
| `icon.ico` | 6 entries: 16, 24, 32, 48, 64, 256 px, all 32 bpp PNG encoded |
| `icon.icns` | `icns` container with `ic07` (128), `ic08` (256), `ic09` (512), `ic10` (1024), `ic11`–`ic14` and the legacy `is32`/`il32`/`s8mk`/`l8mk` maps |
| `tray/deepwork-clock-tray-on-dark.png` | 64x64, 8-bit RGBA |
| `tray/deepwork-clock-tray-on-light.png` | 64x64, 8-bit RGBA |

The mobile icon directories that the Tauri CLI also generates are removed by
the generation script; this project is desktop only.

## 7. Checks that were executed

| Check | Command | Result |
| --- | --- | --- |
| Version agreement | `node scripts/verify-versions.mjs` | passed (14 locations agree) |
| Version agreement, strict | `node scripts/verify-versions.mjs --strict` | passed once all three Cargo lock files existed |
| Icon inspection | `node scripts/verify-icons.mjs` | passed, 9 files inspected |
| Release tooling tests | `npm run test:scripts` | 16 tests passed |
| Frontend lint | `npm run lint` | passed |
| Frontend typecheck | `npm run typecheck` | passed at the time of the run |
| Frontend unit tests | `npm test -- --run` | 101 tests passed |
| Frontend production build | `npm run build` | passed, about 26.4 kB gzip of JavaScript and CSS |
| Browser accessibility checks | `npm run test:a11y` | 9 Playwright tests passed, no serious or critical axe violation |
| Rust format check | `cargo fmt --check` (app, core, engine) | passed in the native container |
| Rust clippy (engine) | `cargo clippy --locked --manifest-path src-tauri/src/engine/Cargo.toml --all-targets -- -D warnings` | passed in the native container |
| Rust clippy (core) | `cargo clippy --locked --manifest-path src-tauri/src/core/Cargo.toml --all-targets -- -D warnings` | passed in the native container |
| Rust tests (engine) | `cargo test --locked --manifest-path src-tauri/src/engine/Cargo.toml` | 66 tests plus 1 doc test passed |
| Rust tests (core) | `cargo test --locked --manifest-path src-tauri/src/core/Cargo.toml` | 52 tests passed |

## 8. Checks that are **not** verified yet

- The GitHub Actions workflows have **not** been executed on GitHub. The YAML
  was parsed locally and the individual commands were run by hand, but no
  hosted job has run yet. The first push must be monitored.
- No native package (`.deb`, `.AppImage`, `.exe`, `.dmg`) has been produced or
  installed yet, so the release path is unproven. The release tooling itself
  was exercised against a simulated staging directory (checksums and the final
  release gate, including the failure cases).
- The desktop crate (`src-tauri`) did not compile at the end of this session
  while the backend worker was editing `src-tauri/src/service.rs`; its Clippy
  and test run has to be repeated once that crate builds again.
- The screen-reader matrix (NVDA, Narrator, VoiceOver, Orca) has not been
  executed. The automated axe run in `scripts/e2e` is a supplement only.
- No code signing and no notarization have been performed.

## 9. Support matrix: intended versus verified

The plan targets Windows 11 x64, macOS arm64 and x64, and Linux x64 on an
Ubuntu 24.04 baseline. The Tauri toolkit advertises more platforms; this
project does not claim them. Nothing in this file should be read as a
statement that a platform was tested.
