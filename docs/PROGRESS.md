# Progress and verification ledger

## Initial state

- 2026-10-21: workspace empty, not yet a git checkout; remote URL supplied by owner.
- Tools observed: Go 1.26.2, Rust/Cargo 1.95.0, Node 24.11.1, npm 11.6.2, OpenCode available.
- GTK3/WebKitGTK development packages absent locally; xvfb-run available.
- OpenCode advertises `opencode/minimax-m3.1-flash-free`; actual inference/tool use not yet verified.
- T01 specification written. All implementation/OS verification tasks pending.

## Implementation run

- Planning commit: `5cb7f25`; pushed to the previously empty owner-supplied repository on `main`.
- Direct `opencode/minimax-m3.1-flash-free` probe failed with expired Console API key; no credentials changed.
- Alternate `opencode-go/minimax-m3.1-flash-free` successfully used a read-only shell tool. OpenCode reported zero cost.
- Four parallel OpenCode workers started using that explicitly free model:
  - Engine: `ses_ea131b485ffehCYBgypGJBsH1M`.
  - Frontend: `ses_ea131affeffehCvjMUHVAjtfjP`.
  - Backend: `ses_ea131ab76ffe75HHQ3LA3kQouR`.
  - Tooling: `ses_ea131a6e0ffehRVC0Y77Tzr8jy`.
- Engine will be an independent path crate inside the engine subtree so pure tests do not require GTK.
- Local native build environment is being prepared in a Docker container, without installing host system packages.
- Repository currently has no GitHub signing secrets configured. First packages must be identified as unsigned prerelease assets.

## Evidence policy

Record task ID, implementation status, executed checks and missing checks separately. A successful build does not establish screen-reader accessibility, signing, runtime performance or correct native behavior on another OS. Raw model logs stay outside source control.

## Implementation status before first release

`Implemented` describes source behavior, not universal platform certification. Local Linux verification is recorded in `evidence/local-verification.md`; hosted build results will be added after execution.

| Cards | Status | Evidence / remaining work |
|---|---|---|
| T01, T02, T04, T05 | Implemented | Product/specification, pinned toolchain, real application and versioned DTOs |
| T03 | Partial | Native prototype builds/launches; browser bundle measured. Native reader/resource gates remain |
| T06–T09 | Implemented | Engine transition/property tests; semantic revision boundaries; native round trip |
| T10–T12 | Implemented, Linux exercised | Suspend-inclusive adapters, serial service, real invoke/event boundary; Windows/macOS runtime checks pending |
| T13–T20 | Implemented | Themes, timer, settings, dialogs/shortcuts, compact/pin requests, durable settings/recovery and native icons |
| T21 | Local checks run | Unit, browser/axe and native WebDriver tests; final gate results recorded separately |
| T22 | In progress | CI/release workflow source complete; first hosted run pending |
| T23 | Not released | Version remains `0.1.0-alpha.1`; no tag, package publication or install authorization yet |
| T24–T26 | Implemented, partial native verification | Capability reporting, tray/single-instance/close handling; physical desktop scripts pending |
| T27 | Implemented, Linux/X11 headless verified | Logical bounds in `window-placement.json` (app data), clamped to a monitor work area; losing the remembered monitor falls back to the primary monitor (unit tested). *Reset window position* restores 420×440 and asks to centre where a position request is honoured. Xvfb: a restart restored the saved 320×200 bounds. Reset itself and monitor hot-plug were not separately exercised in that run. i3/Regolith still tile unless a floating rule is added; Wayland placement is a hint only |
| T28 | Implemented, automated tests only | Record/validate/reset local chords in Settings; stored as `localShortcuts`; invalid, duplicate or reserved chords never replace a working default; the help dialog shows the effective bindings. Recording on physical keyboard layouts, AltGr and IME is not manually verified |
| T29 | Implemented, not fully OS tested | Opt-in native global shortcuts, repeat/conflict handling |
| T30 | Not implemented; explicit unsupported | On Wayland the capability reports unavailable; there is no GlobalShortcuts portal adapter and no GNOME/KDE portal test. The card is satisfied only as an explicit unsupported status |
| T31 | Implemented, delivery not manually verified | Optional native notification after durable completion |
| T32 | Implemented, audio playback unverified | Original 0.7 s mono WAV (`src/assets/completion.wav`), off by default, 0–100 volume, explicit preview, no loop; playback failures are swallowed. Tests stub the audio element; no physical audio device was exercised |
| T33 | Implemented, native sleep/resume unverified | Opt-in `autoAdvance` advances once only after a completion observed within a 3 s sampling gap in cycle mode. A long gap or suspend leaves the phase completed and waits for an explicit action; a restart offers the checkpoint as recovery and never resumes by itself. Gap logic is unit tested; OS sleep/resume was not manually exercised |
| T34, T35 | Implemented | Bounded history, interruption confirmation, totals and safe CSV/JSON export; native save-dialog interaction still manual |
| T36 | Implemented, OS verification pending | Opt-in launch at login |
| T37 | Implemented (English only) | Complete English catalog with stable keys, pseudo-localization and RTL direction helpers, and logical CSS properties. No translations, no locale switcher and no native RTL layout or screen-reader audit |
| T38 | Implemented, clipboard unverified on desktop | About shows the redacted `get_diagnostics` JSON with copy-to-clipboard and a selection fallback. It contains version, OS/architecture, feature flags, timer state, capabilities, warning codes and history count — no labels, session IDs, absolute paths or settings text; the version has no build hash. A Rust test asserts paths, session/phase IDs and a label do not leak. Clipboard interaction was not manually verified; notices are generated at release time |
| T39 | Pending | Beta completeness/validation and beta release not started; this wave is not a released beta |
| T40–T42 | Pending | Manual screen-reader matrix, visual/alternate-input audit and 8-hour soak/process-tree measurements not executed. See `evidence/production-readiness.md` |
| T43–T47 | Pending | Dependency/licence review, clean-machine installer matrix, signing (no credentials configured), maintenance walkthrough and stable decision not verified. `1.0.0` must not be tagged |

## Implementation wave 2 (2026-10-21)

Window, sound and diagnostics work on top of commit `097483e`, reviewed in the
working tree. Documentation edits in this step are uncommitted.

- Frontend: `npm run typecheck`, `npm run lint`, `npm test -- --run` and
  `npm run build` passed. Vitest ran 12 files and 168 tests. The production
  bundle was 28.09 kB gzip JavaScript and 4.54 kB gzip CSS, plus a 61.78 kB WAV
  asset.
- Rust in the isolated Ubuntu 24.04 Docker environment:
  `cargo test --manifest-path src-tauri/Cargo.toml --all-targets` → 71 passed;
  `cargo test --manifest-path src-tauri/src/core/Cargo.toml` → 62 passed.
  Clippy with `--all-targets -- -D warnings` and `cargo fmt --check` were
  clean.
- Native Linux/X11 under Xvfb with no window manager: normal window 420×440;
  compact 320×200 with the compact layout; floating shrank the window and
  issued the always-on-top request; a restart reopened at 320×200 **and** the
  compact layout after the `viewMode` bug was fixed; `window-placement.json`
  was written with clamped logical bounds.
- Earlier the same day, the installed `.deb` launched from the Regolith ilia
  launcher after the desktop-entry fix; the process and a viewable window were
  confirmed, with `WM_CLASS` `deepwork-clock`.
- Not verified: whether i3 honours always-on-top (Xvfb has no window manager),
  playback on a physical audio device, tray click behaviour, notifications on a
  real desktop, screen readers, or any Windows/macOS runtime behaviour.

The first release must remain an unsigned alpha. Do not rename it production-ready or silently mark the pending cards complete. Resume future implementation at the pending card relevant to the next product milestone, retaining the tests and contracts already delivered.

## Implementation wave 3

- 2026-10-22: Optional session names in the main view with fuzzy suggestions
  from earlier labels. The name is stored with the phase and written into its
  Markdown log.
- 2026-10-22: Git-friendly session logs. A chosen folder (normally a git
  checkout) receives one Markdown file per phase under `deepwork-sessions/`;
  a sync pass writes missing files and imports unknown session ids. The app
  never runs git; commit/push stay manual.
- Checks: 13 frontend files / 190 tests, 73 application tests, 69 desktop-free
  core tests, Clippy and rustfmt clean, production build passed.
- Not verified: the native folder picker and a real sync against a git
  checkout. These paths are unit-tested with temporary directories only.
