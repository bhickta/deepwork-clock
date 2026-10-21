# Deepwork Clock

A calm, accessible desktop focus timer. One window, one timer, no account, no
network, no tracking. The timer keeps running in the Rust backend, so it stays
correct even when the window is hidden or the WebView is throttled.

![Deepwork Clock running in its native Linux WebKit window](docs/images/native-light.png)

> **Status: `0.1.0-alpha.1` — an alpha, not a production release.**
> The packages are unsigned, the manual screen-reader matrix has not been
> completed, and several platforms have not been exercised by hand yet. See
> [Known limitations](#known-limitations) before you rely on it.

---

## What it does

- **Countdown and focus cycles.** A single countdown (1 second to 24 hours) or
  a focus/break cycle (50/10 by default, long break after four focus phases).
- **Start, pause, resume, reset, skip, end.** Reset and end ask for
  confirmation while a phase is active; the next phase waits for an explicit
  start.
- **Main and compact views.** The compact view reuses the same window and the
  same timer, so switching never pauses or resets a session.
- **Settings that survive a restart.** Theme (system, light, dark, high
  contrast), text scale (100–200%), durations, session label, notifications,
  global shortcut, launch at login and history retention. Completion sound is
  shown as unavailable in this alpha.
- **Crash recovery.** A running session is checkpointed; after a restart the app
  offers *Resume* or *Discard* and never silently continues.
- **Local session history.** Completed, skipped and ended phases are stored
  locally with their durations, and can be exported as CSV or JSON.
- **Keyboard first.** Every action has a shortcut and every control is a real
  button or form field.
- **Offline.** No account, no analytics, no remote assets, no update check.

## What it does not do yet

Global shortcuts, tray control, notifications, sound and launch at login are
implemented in the backend and are exposed through the settings, but their
behaviour differs per desktop environment and has **not** been verified on
every platform. Automatic updates are deliberately not implemented.

---

## Keyboard shortcuts

`Primary` is <kbd>Command</kbd> on macOS and <kbd>Ctrl</kbd> elsewhere.

| Action | Shortcut |
| --- | --- |
| Start, pause or resume | <kbd>Space</kbd> |
| Reset the current phase | <kbd>Primary</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd> |
| Skip to the next phase | <kbd>Primary</kbd>+<kbd>Shift</kbd>+<kbd>N</kbd> |
| Compact or expanded view | <kbd>Primary</kbd>+<kbd>Shift</kbd>+<kbd>M</kbd> |
| Pin the window above others | <kbd>Primary</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> |
| Open settings | <kbd>Primary</kbd>+<kbd>,</kbd> |
| Show the keyboard shortcuts | <kbd>F1</kbd> |
| Announce the remaining time | <kbd>Primary</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd> |

Shortcuts do not fire while a text field has focus, during IME composition, or
while a key is held down. <kbd>Space</kbd> keeps its native meaning on a
focused button.

---

## Requirements

### To run a released package

| Platform | Requirement |
| --- | --- |
| Windows 11 x64 | WebView2 runtime (preinstalled on current Windows 11) |
| macOS 13 or newer (arm64 and x64) | The system WebKit, preinstalled with macOS |
| Linux x64 | GTK 3, WebKitGTK 4.1, `libayatana-appindicator3`, `librsvg2` |

The Linux packages declare their dependencies; the `.deb` is built against an
Ubuntu 24.04 baseline. The AppImage bundles most of them, but an AppImage is
not proof of compatibility with every distribution.

### To build from source

- Rust `1.95.0` (pinned in `rust-toolchain.toml`)
- Node.js `24.11.1` and npm `11.6.2`
- Linux build dependencies: `libgtk-3-dev`, `libwebkit2gtk-4.1-dev`,
  `libayatana-appindicator3-dev`, `librsvg2-dev`, `patchelf`, `libxdo-dev`
- Tauri 2 prerequisites for your platform, see
  <https://v2.tauri.app/start/prerequisites/>

---

## Build, test and run

```bash
npm ci                 # install the pinned JavaScript dependencies
npm run typecheck      # strict TypeScript check
npm run lint           # ESLint
npm test -- --run      # Vitest unit and DOM tests
npm run test:scripts   # Node tests for the release tooling
npm run build          # typecheck + production frontend bundle
npm run tauri dev      # run the desktop app with hot reload
npm run tauri build    # produce native packages in src-tauri/target/release/bundle
```

Useful extras:

```bash
npm run verify:versions   # every version field must agree
npm run verify:icons      # the native icon set must be valid and correctly sized
npm run icons:generate    # regenerate the icons from src-tauri/icons/source/*.svg
npm run notices           # generate THIRD_PARTY_NOTICES.md from the lockfiles
npm run test:a11y         # Playwright + axe checks against the development preview
```

Rust checks (run from the repository root):

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/src/core/Cargo.toml
cargo test --manifest-path src-tauri/src/engine/Cargo.toml
```

The `core` and `engine` crates are independent of the desktop shell, so they
can be built and tested without a windowing system.

### Install and uninstall

- **Windows (NSIS `.exe`):** run the installer, then uninstall from
  *Settings → Apps → Deepwork Clock*. The installer is unsigned, so
  SmartScreen may ask for confirmation.
- **macOS (`.dmg`):** open the disk image and drag the app to *Applications*.
  Remove it by dragging it to the Trash. The packages are not notarized, so
  Gatekeeper may block the first start.
- **Linux (`.deb`):** `sudo apt install ./deepwork-clock_*.deb`. Uninstall with
  `sudo apt remove deepwork-clock`.
- **Linux (AppImage):** make it executable (`chmod +x`) and run it. Delete the
  file to uninstall.

Your settings, history and recovery data are written to the platform
application data directory and are **not** removed by the uninstaller. Delete
that directory manually if you want a clean slate; the exact path is shown in
the app.

---

## Privacy

Deepwork Clock works entirely offline.

- No account, no telemetry, no analytics and no crash reporting.
- No network requests at runtime; the frontend loads no remote assets or fonts.
- Session labels and history stay on your machine and are only exported when you
  ask for it.
- The optional global shortcut is registered with the operating system, not
  with a remote service. The app never captures the keyboard outside its own
  window.

---

## Repository layout

```
src/                     frontend (vanilla TypeScript, no framework)
src-tauri/src/engine/    pure timer engine crate (no Tauri, no I/O)
src-tauri/src/core/      storage, history and service logic crate
src-tauri/src/           Tauri shell: commands, platform adapters
src-tauri/icons/         generated native icons and their SVG sources
scripts/                 versioning, icon and release tooling
tests/frontend/          frontend tests
.github/workflows/       CI and release pipelines
docs/                    plan, task cards, handoff and evidence
```

## Accessibility

The interface targets WCAG 2.2 AA and WCAG2ICT for the desktop behaviour: a
single `role="timer"` element with `aria-live="off"`, one polite live region
for state changes, real buttons and labelled fields, visible focus, a 44 px
minimum target size and a text scale up to 200%.

Automated axe runs in CI are a supplement only. The screen-reader matrix
(NVDA, Narrator, VoiceOver, Orca) is still open work and is listed as a known
limitation.

## Licence

[MIT](LICENSE). The application icon and the tray glyphs are original artwork
created for this project and are covered by the same licence; no third-party
icon, font or sound asset is bundled. The licences of the bundled
dependencies are listed in the `THIRD_PARTY_NOTICES.md` file that is attached
to every release.

## Known limitations

- **Unsigned packages.** No Windows Authenticode signature, no Apple Developer
  ID signature and no notarization. Signature and notarization require
  maintainer-held credentials and are still open work.
- **No manual screen-reader verification yet.** The automated axe run does not
  replace the per-OS reader script (NVDA, Narrator, VoiceOver, Orca) that the
  project plan requires before a 1.0 release.
- **Advertised is not verified.** The plan targets Windows 11 x64, macOS arm64
  and x64 and Linux x64. The toolkit supports more platforms than that; this
  project only claims the targets above, and only the builds produced by the
  release pipeline have been exercised at all.
- **Completion sound is not implemented in this alpha.** The setting is
  disabled and the backend refuses to enable it.
- **Global shortcuts, tray, notifications and launch at login** behave
  differently per desktop and are not yet verified on every platform. The
  settings report what the current desktop supports.
- **Wayland** has no general keep-above and global hotkey support. The app
  reports the capability as unavailable instead of pretending it works.
- **Resource budgets** in the plan (memory, CPU, startup time) are targets;
  no measured numbers are published for this alpha.
- **No automatic updates.** Updating means downloading a new package.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Please read
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) and report security problems
according to [SECURITY.md](SECURITY.md).

## Release history

See [CHANGELOG.md](CHANGELOG.md).
