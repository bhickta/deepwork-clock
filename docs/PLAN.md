# Deepwork Clock: product and engineering plan

Prepared 2026-10-21. Status: implementation specification, not evidence of completed software.

## 1. Outcome and priorities

Build an open source desktop timer that stays readable while a person works, can be controlled without a mouse, preserves sessions across interruptions, respects the operating system and uses modest resources.

Priority order: correct timing and data safety; accessible operation; reliable desktop behavior; clear visual design; low resource consumption; optional convenience features. A broken accessibility path or lost session blocks a stable release even if the interface looks polished.

The user initially preferred Go and then explicitly permitted Rust or another language. Recommended stack: **Rust + Tauri 2 + TypeScript + semantic HTML/CSS**, with no runtime frontend framework. Node is a development dependency, not a bundled background runtime. Use the system WebView; do not bundle Electron or add a Go sidecar.

This is a product-fit recommendation, not a claim that Rust automatically uses less memory than Go. Validate the complete application, including WebView processes.

Read order for an implementing model: this document, `TASKS.md`, `HANDOFF.md`, then the files named by its task. Work one task at a time.

## 2. Decisions and supporting evidence

| Choice | Reason | Constraint |
|---|---|---|
| Tauri 2 / Rust | Stable desktop foundation, tray/window facilities, scoped bridge permissions and packaging | Platform integrations still require actual OS tests |
| TypeScript, Vite, native HTML controls | Small application, explicit DOM and accessibility semantics; fewer abstractions for small models | Update nodes without replacing the focused control |
| Pure timer module | Deterministic tests without desktop dependencies | No wall-clock calls or filesystem access inside transitions |
| JSON settings and recovery | Small bounded state, inspectable, easy export | Atomic replacement, schema versions, corruption recovery |
| Bounded JSON session history | Avoid a database for a small local timer | Max 5,000 records; revisit SQLite if measurements justify it |
| Manual dependency wiring | Small application with few services | No DI framework, generic event bus or plugin framework |
| MIT license | Permissive open source distribution | Audit font/icon/sound/dependency notices separately |

Alternatives evaluated:

- Go/Wails v2 remains a viable fallback. Official documentation calls v2 stable and v3 beta. It could share the same product specification, but adopting two backends would increase maintenance. [Wails status](https://v3.wails.io/faq/).
- Fyne and Gio are candidates if a strictly Go implementation becomes necessary. Do not assume equivalent screen-reader behavior from custom rendering. Fyne tracks assistive-technology support in [issue 1285](https://github.com/fyne-io/fyne/issues/1285); a current cross-platform prototype is required before selecting it.
- Native per-OS applications would improve access to native controls at the cost of three UI implementations. Keep this as a fallback if the WebView accessibility gate fails.
- Electron would be easy to automate but bundles an additional browser runtime; it does not fit the initial lightweight goal.

Tauri documents its [system WebViews](https://v2.tauri.app/reference/webview-versions/), [tray API](https://v2.tauri.app/learn/system-tray/), [global shortcuts](https://v2.tauri.app/plugin/global-shortcut/), [capability permissions](https://v2.tauri.app/security/capabilities/) and [distribution options](https://v2.tauri.app/distribute/). These are the starting references, not permission to invent API names. Resolve exact compatible versions during bootstrap and commit both lockfiles.

## 3. Release stages and scope

### 0.1.0-alpha.1: reviewable foundation

Deliver working countdown, focus/break cycle, start/pause/resume/reset/skip, accessible main and compact views, settings, themes, local recovery, tests, desktop packages and transparent known limitations. Alpha assets may be unsigned. They are not a production certification.

### 0.2.0-beta.1: feature complete candidate

Add verified tray controls, opt-in global shortcuts, notifications and sound, window placement recovery, presets, bounded history and export, autostart where supported, complete settings and platform capability reporting. Resolve defects in the alpha rather than adding unrelated scope.

### 1.0.0: production release

All required features below and the release gates in section 14 pass on the published support matrix. Sign Windows packages and sign/notarize macOS packages when credentials are available. Publish checksums, source, license notices, accessibility report and measured resource results. Never label untested arm64 packages as verified.

### Feature inventory

| ID | Feature / exact baseline behavior | Stage |
|---|---|---|
| F01 | Countdown: integer seconds, 1 second to 24 hours; UI accepts hours/minutes/seconds | Alpha |
| F02 | Focus cycles: default 50m work, 10m short break, 30m long break after four completed focus phases | Alpha |
| F03 | Pause/resume, reset current phase, skip current phase, end session; deliberate destructive confirmation | Alpha |
| F04 | Default next phase waits for explicit Start; opt-in auto-advance only while continuously awake | Beta |
| F05 | Main view, compact view, optional pin above ordinary windows | Alpha |
| F06 | Keyboard equivalents for every action; shortcut list; native menus | Alpha/Beta |
| F07 | System/light/dark/high-contrast themes, scalable text, reduced motion | Alpha |
| F08 | Presets 25/5, 50/10 and 90/20, editable durations; changing preset never replaces a running session silently | Alpha |
| F09 | Optional session label, max 120 Unicode characters, never in diagnostic logs | Alpha |
| F10 | Tray/menu-bar Show, Start/Pause/Resume, Next phase, Quit | Beta |
| F11 | Opt-in configurable global shortcuts; conflict feedback; no keylogging | Beta |
| F12 | Completion visible in app; optional OS notification and short sound; denied permission never blocks timer | Beta |
| F13 | Settings survive restart; interrupted session offers Resume or Discard, never silently resumes | Alpha |
| F14 | History, local daily timer totals, CSV/JSON export, retention and delete-all | Beta |
| F15 | Monitor/DPI changes, placement clamping, keyboard Restore window | Beta |
| F16 | Explicit close behavior: quit by default; hide only when a reliable restore path exists | Alpha/Beta |
| F17 | Optional launch at login, disabled initially; uninstall instructions | Beta |
| F18 | Offline operation, no account, no analytics, no remote assets | Alpha |
| F19 | English plus translation-ready strings and RTL-safe layout; pseudo-localization verification | Alpha/Beta |
| F20 | About, version, licenses, diagnostics export with preview and redaction | Beta |
| F21 | Stopwatch/count-up with overflow-safe formatting and pause/resume | Post-1.0 |
| F22 | Click-through overlay, opacity, several displays simultaneously, auto-updater | Post-1.0, separately gated |

No website blocker, cloud sync, team dashboard, AI coach, gamified streak punishment, browser extension or calendar integration in 1.0. Optional features must not compromise the calm default view.

## 4. Platform contract

Initial intended targets: Windows 11 x64, macOS arm64 and x64, Linux x64 on a documented Ubuntu LTS baseline with GTK/WebKitGTK. Add Windows/Linux arm64 only when build runners and testing exist. Test the current and oldest supported OS version before promising either. Choose exact minimum versions in task T02; toolkit support is not identical to product support.

| Capability | Windows | macOS | Linux X11 | Linux Wayland |
|---|---|---|---|---|
| Timer, settings, keyboard navigation | Required | Required | Required | Required |
| Screen reader | NVDA + Narrator | VoiceOver | Orca | Orca on tested desktop |
| Pin over ordinary app windows | Verify | Verify floating level | WM dependent | Compositor dependent |
| Absolute saved window coordinates | Verify | Verify across displays | WM dependent | Do not promise; compositor owns placement |
| Tray/menu bar | Verify | Verify | Desktop dependent | Desktop dependent |
| Global shortcut | Plugin, conflicts handled | Plugin, conflicts handled | Plugin, conflicts handled | Portal adapter or explicit unavailable status |
| Notification | Permission/session dependent | Permission dependent | Notification service dependent | Notification service/portal dependent |

Global-hotkey's documented Linux support is [X11 only](https://docs.rs/global-hotkey/latest/global_hotkey/). A Wayland implementation must use a separately tested [GlobalShortcuts portal session](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.GlobalShortcuts.html), negotiate its version, accept user-selected bindings and clean up on shutdown. Never claim the regular plugin provides this automatically.

Wayland xdg-shell does not give ordinary applications universal global-position/keep-above controls. Pin and position need capability-specific behavior and documented compositor rules where appropriate. Use [upstream xdg-shell semantics](https://wayland.app/protocols/xdg-shell) as the reference. Do not pretend a successful request proves the compositor honored it.

Tauri documents Linux limitations on tray mouse events. Always expose Show in the tray context menu; do not depend on a left click or hover. On desktops without a tray, closing must not strand the running application. Never require a GNOME extension for basic timer operation.

Display a concise status beside an unavailable option: “Your desktop does not support this option.” Diagnostics can contain the technical reason. Do not fill the timer screen with implementation details.

## 5. Timer semantics: the authoritative specification

### Values and states

Use integer milliseconds internally. No floating point duration arithmetic. Backend JSON durations must remain within JavaScript safe integer range; the 24-hour cap makes this easy.

`Mode = countdown | cycle`. `Phase = focus | short_break | long_break`.
`Status = idle | running | paused | completed | recovery_pending`.

State contains session UUID, phase UUID, sequence number, mode, phase, status, configured phase duration, remaining-at-anchor milliseconds, elapsed clock anchor (runtime only), completed focus count, frozen cycle configuration, optional label and completion identifier. Frontend snapshots omit runtime clock handles.

One backend service owns state. All commands and deadline checks serialize through this owner. No UI, tray callback or second window mutates it directly.

| Command | Valid states | Result |
|---|---|---|
| Configure | idle / completed | Validate, create idle phase; do not alter an active phase |
| Start | idle | Set runtime anchor, status running |
| Pause | running | Sample remaining first; if already expired, complete instead; otherwise freeze remaining |
| Resume | paused | Set new runtime anchor; preserve remaining |
| Reset | idle / running / paused / completed | New phase ID, full configured duration, idle; completed history unchanged |
| Skip | running / paused / completed in cycle | Record skipped if not completed, select next phase idle; skip never increments focus completion count |
| Advance | completed cycle | Select next phase idle; increment happened at completion, never again here |
| End | any active session | Record interrupted/ended where applicable; clear to idle default |
| Tick | running | Recompute remaining from elapsed clock; complete once if zero |
| Restore | startup | Valid active record becomes recovery_pending; Resume explicitly creates a new anchor |

Invalid commands return a typed error and unchanged state. Repeated Start on running and Pause on paused are harmless no-ops, supporting keyboard repeats. Repeated destructive commands are rejected through stale revision checks. Completion and Skip/Advance ordering must not count a phase twice.

Display rule: `ceil(remaining_ms / 1000)`, clamped at zero. At 60 seconds display `01:00`; at 3,600 seconds display `1:00:00`; no negative time. The transition to completion is backend-owned even if the UI is hidden or its WebView is throttled.

Cycles: completion of a focus phase increments the completed-focus count exactly once. Choose long break when count modulo configured interval is zero, otherwise short break. Any break leads to focus. Reset/skip never counts as completed focus. Count resets on starting a new cycle, not at midnight. Edits to settings affect the next session; explicitly applying them to the current session requires confirmation.

### Time sources, sleep and wall-clock changes

Do not decrement a counter on every tick. Compute from an elapsed-time anchor. UI notifications are not clocks.

For 1.0 the countdown **continues across system sleep**, but the next phase never auto-starts after an observed suspend/resume or uncertain long interruption. Completing while asleep yields one completion on wake. Record that interruption, exclude that phase from confirmed focus totals until the user accepts it, and retain ordinary timer elapsed data. The UI explains this setting plainly.

Provide an elapsed clock that includes suspend: Linux `CLOCK_BOOTTIME`, macOS `mach_continuous_time` with checked timebase conversion, Windows an appropriate documented suspend-inclusive tick source such as `GetTickCount64`. Verify target APIs and semantics in T03 before implementing. Keep native bindings in a tiny adapter; no unsafe code in the pure engine. Rust [`Instant`](https://doc.rust-lang.org/std/time/struct.Instant.html) alone is not a portable sleep-policy contract.

If the suspend-inclusive adapter is unavailable, use a documented fallback with monotonic timing while awake and enter recovery_pending on a detected long gap or suspend. Never silently use wall-clock subtraction as a reliable equivalent. Wall clock is only for timestamps and recovery hints; NTP, DST and manual changes must not change an awake countdown. Test those separately.

On restart do not serialize/reconstruct an `Instant`. Recover the last persisted remaining duration, paused, and show checkpoint age. User chooses Resume or Discard. A completed record must not emit another completion sound on restart. Saving every 30 seconds while running bounds approximate progress loss; write immediately on commands and completion. Never claim subsecond crash recovery with this policy.

### Effects and delivery

Pure transition returns new state plus effects: persist checkpoint, append history, phase completed, phase changed. Stable completion ID is the phase UUID. Durable history upserts by that ID. Notification/sound are best-effort, deduplicated in one process; exactly-once external notifications across crashes are not promised. Persist the completion before attempting external effects. Failure of a notification must not undo completion.

## 6. Backend/frontend contract

Create a versioned shared contract before parallel coding. Use Rust `serde` tagged enums with camelCase JSON fields. Frontend validates incoming snapshots; unknown fields can be ignored, unknown schema versions cannot.

`Snapshot` v1 fields:

```
schemaVersion: 1
revision: nonnegative integer
sessionId: string | null
phaseId: string | null
mode: "countdown" | "cycle"
phase: "focus" | "short_break" | "long_break"
status: "idle" | "running" | "paused" | "completed" | "recovery_pending"
durationMs: integer
remainingMs: integer
completedFocusCount: integer
label: string
interrupted: boolean
```

Bridge commands, deliberately small:

- `get_snapshot() -> Snapshot`
- `timer_command({requestId, expectedRevision, action, payload?}) -> Snapshot`
- `get_settings() -> Settings`
- `save_settings({expectedSettingsRevision, settings}) -> Settings`
- `get_capabilities() -> Capabilities`
- `window_action({action}) -> Result` (compact, normal, pin, restore; allowlisted)
- `list_history({limit, before?}) -> HistoryPage`
- `export_history({format}) -> ExportResult` (backend-owned save dialog)
- `delete_history({confirmation}) -> Result`

`timer:snapshot` emits on transitions and at most once per displayed second while a view is visible. UI can extrapolate visually between snapshots but cannot complete a session. Snapshot revisions are monotonically increasing, including published ticks; reject stale actions with `STALE_REVISION` and return latest snapshot. Client must refresh and let the user retry destructive actions, never blindly retry them.

Subscribe before requesting initial snapshot; ignore older revisions. Backend checks expiry immediately before every command. Capabilities have state `available | unavailable | permission_required | unknown`, reason, optional effective value. A request being accepted is different from a capability being observed working.

Stable error codes: INVALID_DURATION, INVALID_STATE, STALE_REVISION, STORAGE_UNAVAILABLE, UNSUPPORTED, SHORTCUT_CONFLICT, PERMISSION_DENIED, CORRUPT_DATA, INTERNAL. Errors contain safe user text; diagnostic details stay local. Cap label input at 120 characters and bridge payloads at a documented size.

## 7. Architecture and files

Create these only as needed, without empty speculative layers:

```
src/                         # frontend
  main.ts                    # boot, subscribe, mount
  contract.ts                # shared DTO definitions and validation
  bridge.ts                  # actual Tauri invokes, one boundary
  app.ts                     # DOM assembly and focus-safe updates
  timer-view.ts              # timer controls and presentation
  settings-view.ts           # forms and save/cancel
  shortcuts.ts               # local shortcut handling
  i18n.ts                    # string catalog
  styles/{tokens,base,app}.css
  assets/icons/              # selected licensed SVGs
src-tauri/
  Cargo.toml
  tauri.conf.json
  capabilities/main.json
  src/{main,lib,commands,service,storage,platform}.rs
  src/engine/{mod,types,transition}.rs
  src/platform/{clock,window,shortcut,notification}.rs
  icons/                     # generated native icon formats
tests/                       # frontend and desktop contract tests
docs/{PLAN,TASKS,HANDOFF,PROGRESS}.md
docs/evidence/               # actual measured evidence, not invented results
.github/workflows/{ci,release}.yml
```

Engine is independent of Tauri; it takes samples supplied by the service. Use small enums and ordinary structs, constructor injection and owned values. Avoid advanced lifetime tricks, global mutable state, premature generics and panics in normal error paths. A mutex is acceptable around a short state transition; never hold it across filesystem, notifications, UI scheduling or awaits. Preserve effect order with a single service owner/queue. UI work occurs on Tauri's required thread.

Prefer stdlib plus serde/serde_json, Tauri and required official plugins. Add a crate only for a concrete requirement. Use strict TS, no `any` at the bridge, no remote CDN, no arbitrary HTML injection. Native OS code is isolated and commented with its safety assumptions.

## 8. Interaction and visual specification

The timer is the primary object. Default view: phase name, large tabular digits, optional label, text-labelled Start/Pause/Resume, secondary Reset and Next, quiet settings/help controls. Do not add dashboards to the active timer.

Proposed normal window 420x440 logical pixels, compact 300x160, settings 560x640. These are starting design values, not hard accessibility limits. Reflow or scroll when text scaling requires it. Compact mode reuses the same window initially to avoid a second WebView and state owner. Expanding returns to normal dimensions without pausing.

Use an 8px spacing scale (4px for fine adjustments), 12px card radius, system font stack, tabular digits, restrained elevation. Body 16px, supporting text at least 14px, timer 64px normal / 42px compact, adjustable scale 100–200%. Check actual glyph widths at 24 hours and with localized strings.

Theme tokens: canvas, surface, elevatedSurface, text, mutedText, accent, onAccent, border, focusRing, warning, danger, success. Define and measure every state in each palette: normal, hover, active, disabled, focus, selected, error. Initial colors may be designed freely, but contrast tests decide acceptance. System theme updates live unless overridden. High contrast is explicit and responds to forced-colors where supported. Custom arbitrary user palettes are deferred.

Use one icon family (e.g. Lucide, after license verification) with consistent 20/24px geometry and currentColor. Start/play, pause, reset/rotate, next, pin, settings, expand/collapse, sound, help. Every icon-only control has a visible tooltip and accessible name; toggles expose pressed state. Never use emoji as functional icons. Application icon must be recognizable at 16px and have light/dark tray variants; generated .ico/.icns/.png assets must be inspected in actual native contexts. Include source SVG and notices. No image generation is necessary for a simple vector clock mark.

Motion is brief, optional and decorative. No continuous pulsing, spinning ring, flashing completion or per-frame idle rendering. Progress updates on the second boundary. Reduced motion disables transitions. Sound defaults off, preview is explicit and respects volume; visual completion always remains available. Do not steal focus on completion or move the window unexpectedly.

Destructive flow: Reset running/paused and End require a dialog; initial focus is Cancel. Reset from idle can happen directly. Escape cancels the current dialog, not the timer. On completion show “Focus complete” and Start break/Next focus as appropriate; no modal required.

## 9. Accessibility acceptance specification

Use [WCAG 2.2](https://www.w3.org/TR/WCAG22/) AA as the web-content baseline, and [WCAG2ICT](https://www.w3.org/TR/wcag2ict-22/) to interpret relevant desktop behavior. These are engineering targets, not a legal conformance certificate. Maintain criterion-by-criterion evidence and include native window/menu/installer behavior in testing.

### A01: Keyboard and alternate input

All actions work with Tab/Shift+Tab, Enter/Space and standard native menu navigation. No keyboard trap. Dragging has menu/keyboard alternatives. Focus stays visible, follows logical order, and returns to the invoking control after dialogs. All views have headings and explicit form labels. Preserve native control behavior; never intercept shortcuts while typing in an input or during IME composition. Test voice control, magnification and a keyboard-only workflow.

### A02: Screen readers

Use native buttons/inputs; semantic headings, landmarks and named groups. Timer uses `role="timer"` with a readable text representation and live updates off. A separate polite status announces phase/state changes once, not every second. Provide a shortcut/button to announce remaining time on demand. [ARIA timer semantics](https://www.w3.org/TR/wai-aria-1.2/#timer).

Use labelled modal dialogs with contained focus, Escape cancellation and return focus following the [APG dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/). Error text is associated with its field; saving failure is announced without discarding edits. Inspect the actual packaged WebView accessibility tree, not only browser automation output.

### A03: Readability and perception

Target normal text contrast >=4.5:1, large text >=3:1 and meaningful control boundaries/states >=3:1. App target is 44x44 logical-pixel control hit areas where practical, including compact primary controls. Color never carries the only meaning. Focus ring is a clear 2px or stronger app design target, visible against adjacent surfaces. No clipping at 200% text size; reflow into a scrollable view at narrow widths. Test OS high contrast, dark/light, reduced motion and reduced transparency. Decorative SVGs are hidden from assistive technology.

### A04: Cognitive and hearing support

Plain language, stable control positions, predictable confirmation and no shame-based copy. No sound-only alarm. No automatic dismissal of important errors. Duration entry errors explain accepted bounds and retain typed values. Any automatic cycle behavior is opt-in, explained and interruptible. No flashing or animation required to understand progress.

Required manual script per OS: open application; locate timer and current phase; enter duration; start; query remaining; pause; edit settings; cancel reset; resume; complete; start next phase; use compact mode; recover after restart; quit. Record reader/version/OS/package hash, expected/actual result and failures. Browser axe checks supplement this; they do not replace it.

## 10. Shortcut contract

`Primary` means Command on macOS, Ctrl elsewhere. Show native glyphs/text and current remaps in tooltips, menus and help.

| Action | Local default | Notes |
|---|---|---|
| Start / pause / resume | Space | Only when timer surface has focus; a focused button keeps its native Space action |
| Reset | Primary+Shift+R | Confirmation if active |
| Next phase | Primary+Shift+N | Confirmation if skipping active phase |
| Compact / expand | Primary+Shift+M | Same underlying timer |
| Pin toggle | Primary+Shift+P | Only if capability available |
| Settings | Primary+, | Close/cancel without losing session |
| Shortcut help | F1 | Native Help menu alternate |
| Announce remaining | Primary+Shift+T | One polite announcement |
| Restore window | Native menu action | Must work even after invalid saved position |
| Quit | Native platform menu accelerator | Explicitly distinct from hide |

All global shortcuts are off by default. Suggested opt-in bindings: Primary+Alt+Shift+Space for show/hide, Primary+Alt+Shift+T for toggle running; registration must be verified and conflicts explained. Allow recording/remapping/clearing. Do not reserve OS-reserved combinations, register bare letters, capture input streams or request broad accessibility permissions merely for convenience. Handle keydown repeat so one press cannot pause and immediately resume. Test non-US layouts, IME, AltGr and assistive technology conflicts.

## 11. Storage, recovery and privacy

Use OS application config/data directories from the framework. Files: `settings.json`, `recovery.json`, `history.json`; each has schemaVersion and bounded content. Settings have a revision. History records contain phase ID, timestamps (UTC), original local date/offset, configured and timer elapsed durations, outcome (completed/skipped/ended), interrupted/confirmed flags and optional label.

UTC timestamps preserve ordering; daily totals use the stored local date at phase completion, not a later time-zone reinterpretation. Sum milliseconds before formatting; never sum rounded display minutes. Do not market timer totals as objectively productive work. Interrupted phases require confirmation before appearing in confirmed focus totals.

Write a temporary file in the same directory, flush, then platform-correct replace, with a previous-good backup. Verify Windows replacement semantics rather than assuming POSIX rename behavior. Ensure single-instance ownership before writing. Serialize writes and preserve ordering. On write failure keep timer working in memory, show a persistent nonblocking warning, and offer safe export/retry. Do not report settings saved before durable success.

Malformed or oversized files are quarantined with an explanatory message and safe defaults. Never overwrite the only corrupt original. Refuse unsupported future schema versions without deleting them. Migration takes a backup and is idempotent. Settings import, if added later, validates fields and rejects path injection. Do not deserialize arbitrary objects into privileged actions.

History default retention: 90 days, maximum 5,000 records, user can disable history or delete all. Labels are local personal data. Export through a user-chosen save dialog; escape CSV and mitigate spreadsheet formulas for cells beginning with =,+,-,@ (including leading whitespace/control characters). JSON export preserves raw strings. Export diagnostics separately with an explicit preview; strip labels, usernames, absolute user paths and secrets. No network use by default; manual release links open only allowlisted HTTPS URLs through native browser handling.

## 12. Resource and reliability budgets

These are **initial acceptance targets**, not benchmark results. T03 must record actual baseline and either meet the budget or document a reviewed product tradeoff before adding features.

| Measurement | Initial target |
|---|---|
| Release frontend JS+CSS | <=150 KiB gzip excluding app icons |
| Compressed per-architecture app package | <=30 MiB excluding externally installed system WebView/runtime |
| Warm interactive start | median <=1s, p95 <=2s over 20 launches on recorded reference hardware |
| Cold first launch | record separately, no misleading warm/cold comparison |
| Process-tree working set | target <=150 MiB, investigate >200 MiB; report OS-specific metric and shared-process caveats |
| Idle CPU | <=0.5% of one core averaged over 5 minutes after warm-up |
| Visible running timer CPU | <=1% of one core averaged over 5 minutes |
| Hidden timer | no continuous frontend updates; backend deadline remains active |
| Active accuracy | remaining computed within 100ms of reference; visible seconds within one refresh interval |
| Memory stability | no sustained growth >10 MiB after warm-up during an 8-hour soak, investigate allocations |
| Storage | bounded writes, 30-second active checkpoints, immediate important transitions |

Measure release builds with devtools closed and no debugger. Include all owned WebView/helper processes and document how shared services were accounted for. Record OS/desktop, CPU, RAM, WebView version, commit, package hash, sample interval and raw output. Do not compare Linux RSS with Windows private bytes as if equivalent. Keep compiler LTO/strip optimizations measured; never add UPX as a default distribution shortcut.

## 13. Testing and automation

Pure engine tests: every state/action pair; exact deadline; delayed wake; pause at expiry; reset; skip; long-break modulo; repeat commands; negative/oversized input; hour formatting; wall-clock jumps; sleep; restart; stale commands; duplicate completion; duration overflow. Property test random command sequences for nonnegative bounded remaining and no duplicate completion. No real sleeps in engine tests.

Storage tests: round trip; atomic replacement; permission denied; interrupted write; malformed/oversized/future data; previous backup; bounded history; migration; CSV formula escaping; Unicode labels; duplicate history effects.

Frontend tests: commands issued from labelled controls; state-specific actions; focus not replaced on ticks; dialog focus return; local shortcuts ignore inputs/composition/repeat; settings errors preserved; stale/out-of-order snapshots; no per-second reader announcement; contrast tokens; long strings/RTL; scale and compact reflow.

Desktop tests: actual invoke boundary, main/compact behavior, close/restore, tray menu, shortcut conflict, notification denial, secondary launch, unplugged monitor, mixed DPI, OS sleep/resume, screen readers and installer/uninstaller. Tauri's [WebDriver documentation](https://v2.tauri.app/develop/tests/webdriver/) describes platform limitations, including macOS driver availability; browser tests cannot be represented as packaged macOS automation.

CI on every PR: format, lint, typecheck, Rust unit tests, frontend tests, frontend build, dependency/license review. Matrix native builds on Linux/Windows/macOS. Use rustfmt, Clippy, cargo test, TypeScript, ESLint and Vitest; browser Playwright/axe for DOM checks. Scope integration tests explicitly; do not add coverage-only assertions. Use Miri or sanitizers selectively for native clock adapter code where feasible. Pin CI actions to reviewed commit SHAs, document updates, use least permissions and do not expose signing secrets to fork PRs.

## 14. Packaging, versioning and release gates

Repository: `git@github.com:bhickta/deepwork-clock.git`. Preserve any existing remote history. No force pushes. Small commits describe behavior and rationale; exclude target/, node_modules/, generated installers and local session logs. Commit source icon assets and necessary generated native icons.

Semantic Versioning: start `0.1.0-alpha.1`; tag `v0.1.0-alpha.1`. Cargo, package.json, Tauri config and lockfiles must agree. Use a release script that checks every version field and fails on mismatch. Map prerelease identifiers correctly to Windows package numeric versions where needed. Record migration compatibility in changelog. Never reuse a published tag for different binaries; patch with a new version.

Build targets: Windows x64 NSIS .exe (optionally MSI later); macOS arm64 and x64 .dmg plus .app archive; Linux x64 .deb and .AppImage, optional .rpm once tested. Build on native hosted runners with pinned dependencies/toolchains. Linux packages must declare system dependencies and tested baseline; AppImage is not proof of universal distro compatibility. Do not build installers through guessed cross-compilation commands.

Publish source archive, SHA256SUMS, dependency/license notices and per-target build metadata. Windows Authenticode and macOS Developer ID/notarization require maintainer-controlled credentials; absence must remain a documented limitation. Signing and notarization are distinct from signing update payloads. Defer automatic updater until signed manifests, key rotation and rollback are designed and tested.

Release workflow: CI succeeds -> native packages build -> checksums verify -> smoke tests/evidence recorded -> draft GitHub release -> review artifact list and notes -> publish when authorized. The user has authorized pushing and versioned assets; publication may proceed within that scope, but never imply missing manual verification has occurred. An alpha prerelease with honest limitations is the appropriate first artifact if production gates are not met.

Stable 1.0 gates, all required:

1. Required F01–F20 features implemented or scope explicitly revised with owner approval.
2. Complete core/storage/bridge/keyboard tests and native packaging checks pass.
3. Manual screen-reader matrix passes on every claimed OS; accessibility report lists remaining issues accurately.
4. Multi-monitor/DPI/sleep/resume/clock-change/notification-denial/shortcut-conflict scripts pass.
5. Resource budgets measured; eight-hour soak and repeated launch/quit pass.
6. Install, upgrade, uninstall and data retention behavior documented and verified.
7. Security and dependency/license review complete; no known reachable critical vulnerabilities without a documented resolution.
8. Signing status, package hashes, source/version correspondence and release notes verified.
9. README, contribution guide, code of conduct, security policy, licenses and supported-platform table complete.
10. No TODO, fake success, ignored failing test, placeholder UI or unsupported “fully accessible” claim disguised as completed work.

## 15. Risk register and stop conditions

| Risk | Early experiment | Fallback |
|---|---|---|
| Packaged WebView/reader incompatibility | T03 reader script on each OS | Fix semantics first; change toolkit if native bridge is inadequate |
| Wayland pin/hotkey gaps | GNOME and KDE capability probe | Supported normal timer; portal shortcut or documented desktop action |
| Excessive WebView memory | Minimal release build baseline | Reduce windows/assets; consider native UI before feature expansion |
| Rust complexity for small models | Pure structs/enums, tiny task cards | Split task; do not introduce async/generic machinery unnecessarily |
| Time source excludes sleep | Native adapter test | Recovery-pending fallback; never silently change advertised policy |
| Missing signing credentials | Inspect configured secret names without reading values | Clearly unsigned alpha; production signing remains blocked |
| Free model quota/unavailability | One minimal tool-use probe | Another explicitly free model, retain logs; do not switch to paid |
| Parallel edits collide | Ownership boundaries and shared contract | Integrator resolves sequentially; no worker commits shared files |
| No access to physical target OS | Hosted build plus explicit manual checklist | Publish alpha with unverified items; no stable-production claim |

A worker stops on an unresolvable contract/API mismatch, unavailable dependency or test requirement it cannot execute. It records the failure and asks the integrator; it does not fabricate evidence or silently remove the requirement.
