# Local verification, 2026-10-21

These checks describe the implementation during integration. Final commit/package verification is recorded separately when available.

Environment: Ubuntu 24.04.4 host; isolated Ubuntu 24.04 Docker environment with GTK 3.24.41 and WebKitGTK 2.52.6; Rust/Cargo 1.95.0; Node 24.11.1; npm 11.6.2.

| Check | Observed result | Scope |
|---|---|---|
| Engine `cargo test` | 66 unit tests and 1 documentation example passed | Deterministic Rust engine, no desktop |
| Engine Clippy/format | Passed in worker handoff | Engine subtree |
| Core `cargo test --manifest-path src-tauri/src/core/Cargo.toml` | 52 tests passed against the actual engine | Settings/storage/history/export/service |
| Frontend production build | Passed | TypeScript and Vite |
| Frontend compressed assets | JS 22.08 kB gzip, CSS 4.03 kB gzip | An intermediate production build; build output may change with fixes |
| Browser preview idle | Zero page errors and zero axe violations | Chromium preview, not native reader compatibility |
| Native `cargo check` | Passed after desktop API/dependency corrections | Linux compile check |
| Native `cargo build --features custom-protocol` | Passed | Linux debug executable with embedded production assets |
| Native executable launch | Stayed running until the 8-second test timeout | Headless Xvfb/D-Bus in Docker; AT-SPI bus unavailable in that container |

The first browser review found CSS overriding `[hidden]`, and source review found missing periodic snapshot publication and persistence ordering problems. These were sent back to the implementing workers for correction and regression tests. A first native compile found 17 errors; the later check/build above succeeded. Failures are not represented as passing evidence.

Not covered by these results: physical Windows/macOS execution, packaged screen readers, manual sleep/resume and multi-monitor behavior, installer upgrade/uninstall, signing/notarization, whole-process memory/CPU measurements or an eight-hour soak. See PLAN.md for the production gates.

## Final local gate

Executed after the review fixes, against the source committed as `b19c997` and its engine baseline `58e5498`:

- `npm run lint`, `npm run typecheck`, `npm test -- --run`, `npm run build`: passed, 115 frontend tests.
- `npm run test:a11y`: 9 browser checks passed. The separate frontend browser suite passed 14 checks, including compact storage-warning access, recovery age and 200% text reflow.
- Rust formatting and Clippy with `--all-targets --locked -- -D warnings`: passed for application, core and engine crates.
- Rust unit tests: 51 application/service tests, 54 desktop-free core tests, 66 engine tests; one additional engine documentation example passed.
- Release-tool Node tests: 16 passed, including filenames with spaces, missing artifacts, wrong architecture, modified hashes and path traversal.
- Version verifier: 14 locations agree at `0.1.0-alpha.1`. Native icon verifier: 9 required files pass format/dimension checks.
- `actionlint` passed both workflow files; Python syntax check passed the native smoke script.
- Native debug build with embedded final frontend assets passed. The real WebKitGTK WebDriver run (stable `tauri-driver 2.1.0`) passed 22 steps in 6,726ms. It covered actual invokes/events, visible countdown, pause/resume, completion/history deduplication, stale commands, settings save/read, DOM controls and focus. It used isolated temporary XDG data paths and did not touch the user's app data.
- `images/native-light.png` is a direct screenshot of that native Linux application, not a design mockup or the browser demo.

The first full gate exposed an MSRV-dependent Clippy warning and an ambiguous browser-test selector; both were fixed and the full relevant checks rerun. The native driver was pinned to stable 2.1.0 after an incompatible 3.0 alpha opened a blank browser. A separate smoke-harness client/session wiring error was fixed before recording the successful native result. These checks do not substitute for the production-only manual gates.

## Window, sound and diagnostics wave (2026-10-21)

This section covers the floating view, placement persistence, local shortcut
remapping, completion chime, auto-advance and About diagnostics. It is Linux
and X11 only. It is not evidence for Windows, macOS or Wayland, and it is not a
manual screen-reader or audio-device test.

Environment: same Ubuntu 24.04 host as above; frontend checks run on the host;
Rust checks run in the isolated Ubuntu 24.04 Docker image; native window checks
run on a virtual X display with no window manager.

| Command | Observed result | Scope |
|---|---|---|
| `npm run typecheck` | Passed | Strict TypeScript |
| `npm run lint` | Passed | ESLint |
| `npm test -- --run` | 12 files, 168 tests passed | Vitest unit and DOM tests |
| `npm run build` | Passed; JS 28.09 kB gzip, CSS 4.54 kB gzip, WAV 61.78 kB | Production frontend bundle |
| `cargo test --manifest-path src-tauri/Cargo.toml --all-targets` | 71 passed | Application, service and platform adapters in Docker |
| `cargo test --manifest-path src-tauri/src/core/Cargo.toml` | 62 passed | Settings, storage, history, export and service in Docker |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | Clean | Docker; no warnings promoted to errors |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | Clean | Docker |
| `cargo build --manifest-path src-tauri/Cargo.toml --features custom-protocol` | Passed | Debug Linux executable with embedded production assets |

### Xvfb method

The native checks used `xvfb-run -a` with **no window manager**. The
application was launched in that display, then driven through its real commands
and window actions. Window geometry and layout were observed on the X server
after each action. A display without a window manager can show that the
application requested a size or an always-on-top state; it cannot show how a
real window manager would honour the stacking request.

Observed:

- Normal launch: 420×440 logical pixels.
- Compact action: the window shrank to 320×200 and rendered the compact layout,
  not the normal layout in a smaller window.
- Floating action: the window shrank to 320×200 and the backend issued the
  always-on-top request. Whether a window manager honours it was not observable.
- Restart: the window reopened at 320×200 **and** rendered the compact layout.
  The first run of this check exposed a bug: placement restored the saved size
  while the stored view mode was not applied. The view mode is now persisted as
  `viewMode` in settings and applied after placement; the frontend tests cover
  the restore and save paths.
- `window-placement.json` was written to the isolated application data
  directory with finite, clamped logical bounds.

Also on the same day, the installed `.deb` was launched from the Regolith ilia
launcher (`Super`+`Space`) after the desktop-entry fix. The process and a
viewable window were confirmed, and `WM_CLASS` was `deepwork-clock`. This is a
launch check only; it is not a tray, always-on-top, notification, audio or
window-manager-rule test.

### Not verified in this wave

- Whether i3 or another real window manager honours the always-on-top request
  (the Xvfb session had no window manager).
- Playback of `src/assets/completion.wav` on a physical audio device, including
  muted, missing or denied devices.
- Tray click behaviour and notification delivery on a real desktop.
- Recording a remapped shortcut on non-US layouts, AltGr or during IME input.
- Any screen reader (Orca, NVDA, Narrator, VoiceOver).
- Any Windows or macOS runtime behaviour.
- T40–T47 production gates; see `production-readiness.md`.

### Final automated gate after the documentation wave

- `npm run typecheck`, `npm run lint`: clean.
- `npm test -- --run`: 12 files, 168 tests passed.
- `npm run test:scripts`: 18 tests passed.
- `npm run test:a11y`: 9 browser checks passed. One selector became ambiguous
  after the new floating button ("Compact view" also matched "Floating compact
  view"); the check now uses an exact accessible name.
- `npm run build`: passed; the completion chime is emitted as a same-origin
  asset.
- Docker: `cargo test --manifest-path src-tauri/Cargo.toml --all-targets` ->
  71 passed; the desktop-free core -> 62 passed; Clippy `-D warnings` and
  `cargo fmt --check` clean.
- `npm run tauri -- build --bundles deb` produced
  `deepwork-clock_0.1.0-alpha.1_amd64.deb` (2.5 MB) containing
  `deepwork-clock.desktop` with no space in the file name. It was **not**
  installed during this wave.

### i3 floating verification (installed build, 2026-10-22)

The installed release package was exercised on the owner's i3/Regolith X11
session without a test harness. The window starts in the saved layout, then
the Floating button was used:

- Before: `i3-msg -t get_tree` reported `floating: auto_off`, rect 953×1045
  (tiled), because i3 ignores a size request for a tiled window.
- After Floating: `floating: user_on`, rect 324×204, and the settings file
  recorded `viewMode: compact`, `floating: true`.
- Restart: the window reopened `user_on` at 324×204, i.e. the saved floating
  compact layout was restored.
- Unfloat: `floating: user_off`, rect 953×1045, settings reset to
  `viewMode: normal`, `floating: false`.
- `_NET_WM_STATE` contained only `_NET_WM_STATE_FOCUSED`; i3 did not report
  the always-on-top request as `_NET_WM_STATE_ABOVE`. "Above other windows" is
  therefore still window-manager dependent and is not claimed as verified.

The app now asks i3/sway over the IPC socket (`I3SOCK`/`SWAYSOCK`) to float the
window before applying the compact size. The desktop rule in the README is only
needed for an always-floating preference.

### Session naming and Markdown sync (2026-10-22)

- Frontend: `npm test -- --run` -> 13 files, 190 tests passed, including fuzzy
  ranking, keyboard selection, commit-on-blur, name persistence, folder
  selection, relative-path rejection and sync summaries.
- Rust: 73 application/service tests (one new sync round trip: write from one
  profile, import into a second profile), 69 desktop-free core tests (Markdown
  render/parse round trip, unsafe ids, malformed files, missing folder).
- Clippy `-D warnings`, rustfmt and `npm run build` clean.
- The native folder picker and a real sync against a git checkout were not
  exercised in this wave. The file behaviour is unit-tested against temporary
  directories only.
