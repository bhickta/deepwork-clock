# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The first release is
a prerelease (`0.1.0-alpha.1`), so the `alpha.1` identifier is part of the
public version.

## [0.1.0-alpha.1] - unreleased

The first reviewable foundation. It is an alpha: the packages are unsigned and
the manual screen-reader matrix has not been completed.

### Added

- Countdown mode (1 second to 24 hours) and focus cycle mode (50/10 by
  default, long break after four completed focus phases).
- Timer actions: start, pause, resume, reset, skip, end, with confirmation
  dialogs for the destructive actions while a phase is active.
- A deterministic, platform-free timer engine crate (`deepwork-engine`) with
  integer millisecond arithmetic, revision checks and exactly-once phase
  completion.
- A desktop-free service crate (`deepwork-core`) with durable settings, history
  and recovery storage.
- Tauri 2 shell with a versioned command bridge: `get_snapshot`,
  `timer_command`, `get_settings`, `save_settings`, `get_capabilities`,
  `get_warnings`, `window_action`, `list_history`, `export_history`,
  `delete_history` and `confirm_history`.
- Frontend in vanilla TypeScript with a semantic main view, a compact view,
  settings, session history, help and about views.
- Themes (system, light, dark, high contrast), a text scale from 100% to 200%
  and a reduced-motion aware stylesheet.
- Keyboard shortcuts for every action, ignored while typing, during IME
  composition and on key repeat.
- Crash recovery: checkpoints are written during a running session and an
  interrupted session is offered as *Resume* or *Discard* after a restart.
- Local session history with retention, daily totals, CSV and JSON export and
  spreadsheet formula mitigation.
- Optional desktop integration: tray menu, opt-in global shortcut, completion
  notification, completion sound and launch at login, each reported through
  the capability report when the desktop does not support it.
- Original application icon and tray glyphs, with a generated native icon set
  (PNG, `.ico`, `.icns`) and the SVG sources.
- Root tooling: pinned Node and Rust versions, committed lockfiles, strict
  TypeScript, ESLint, Vitest, Playwright with axe, a version validator, an icon
  verifier and Node based release tooling with unit tests.
- GitHub Actions CI (lint, typecheck, unit tests, native build, Rust format,
  Clippy, tests, accessibility smoke test) and a native release matrix for
  Linux x64, Windows x64, macOS arm64 and macOS x64.

### Fixed

- Launching from a desktop application menu on Linux. The installed
  `.desktop` file is now named `deepwork-clock.desktop`; the previous name
  contained a space, which made GIO's systemd launcher look for an executable
  called `Clock.desktop_*.scope` and fail silently. The menu label is still
  "Deepwork Clock".

### Not included in this release

- Code signing and notarization.
- A completed screen-reader matrix per operating system.
- Automatic updates.
- Measured resource numbers for the published packages.

[0.1.0-alpha.1]: https://github.com/bhickta/deepwork-clock/releases/tag/v0.1.0-alpha.1
