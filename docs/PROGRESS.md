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
| T22, T23 | In progress | CI/release workflow source complete; first hosted run and downloadable assets pending |
| T24–T26 | Implemented, partial native verification | Capability reporting, tray/single-instance/close handling; physical desktop scripts pending |
| T27 | Pending | Full monitor/DPI persistence and hot-plug recovery; basic Restore window exists |
| T28 | Partial | Shortcut help and global chord input exist; full configurable local-shortcut remapping pending |
| T29 | Implemented, not fully OS tested | Opt-in native global shortcuts, repeat/conflict handling |
| T30 | Pending | Wayland portal shortcut adapter; current UI explicitly reports unavailable |
| T31 | Implemented, delivery not manually verified | Optional native notification after durable completion |
| T32 | Pending | Completion sound intentionally unavailable; setting cannot silently enable it |
| T33 | Partial | Suspend-inclusive countdown and conservative interruption marking; full power-event coverage and opt-in auto-advance pending |
| T34, T35 | Implemented | Bounded history, interruption confirmation, totals and safe CSV/JSON export; native save-dialog interaction still manual |
| T36 | Implemented, OS verification pending | Opt-in launch at login |
| T37 | Partial | English catalog and layout readiness; pseudo-localization/RTL audit and translations pending |
| T38 | Partial | About/version, dependency notices and warnings; diagnostics export pending |
| T39 | Pending | Beta completeness/validation and beta release |
| T40–T47 | Pending | Production accessibility, performance/soak, security/license review, installer verification, signing and stable-release decision |

The first release must remain an unsigned alpha. Do not rename it production-ready or silently mark the pending cards complete. Resume future implementation at the pending card relevant to the next product milestone, retaining the tests and contracts already delivered.
