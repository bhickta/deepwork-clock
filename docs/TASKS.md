# Ordered implementation cards

Status is tracked separately in PROGRESS.md. Each card lists dependencies, paths, steps and acceptance. PLAN.md contains the detailed behavior; do not redesign it from a terse card. P = planning gate; A = alpha; B = beta; R = stable readiness. Independent cards may run in parallel only under HANDOFF.md ownership.

## P: prove the foundation

### T01 — Capture specification and repository baseline
Depends: none. Paths: docs/, AGENTS.md.
Steps: preserve remote history; record empty/existing workspace; write product/specification, task cards and handoff; list unresolved evidence.
Accept: a new model can locate every behavior and the next task. No implementation marked complete by document creation.

### T02 — Toolchain and support matrix
Depends: T01. Paths: root tooling, docs/evidence/toolchain.md.
Steps: inspect installed tools and available free model IDs; select compatible stable Rust/Tauri/Node versions; pin toolchain and lockfiles at bootstrap; select Linux baseline and hosted OS matrix.
Accept: versions and package prerequisites recorded; targets distinguished from tested platforms. No “latest” in reproducible release installs.

### T03 — Minimal desktop feasibility experiment
Depends: T02, T04 skeleton. Paths: temporary spike files or minimal app, docs/evidence/feasibility.md.
Steps: release-build one timer label and button; inspect accessibility tree; probe pin/compact/keyboard, tray and clock adapter; measure complete process tree; list unexecuted OS checks.
Accept: baseline measurements or explicit blocked checks. Stop expanding toward 1.0 if fundamental accessibility/resource requirements cannot be met. Alpha work may proceed with transparent experimental status.

## A: alpha foundation

### T04 — Bootstrap minimal application
Depends: T01/T02. Paths: Cargo/package/TypeScript/Vite/Tauri configs, main entrypoints, .gitignore.
Steps: create Tauri 2 Rust app and vanilla strict TS frontend; establish command scripts; add serde, minimal plugin permissions; commit lockfiles; select version 0.1.0-alpha.1; add license.
Accept: frontend builds, native app starts when desktop prerequisites exist, source control excludes caches/secrets/artifacts.

### T05 — Freeze bridge contract and engine public API
Depends: T04. Paths: src/contract.ts, engine types, docs/evidence/contract.md.
Steps: define Snapshot/Action/Settings/Error DTOs from PLAN section 6; specify serde naming; create matching JSON fixtures; name engine methods/effect variants.
Accept: backend/frontend agree on fixtures and optional/null fields; later workers consume documented public methods.

### T06 — Duration validation and formatting
Depends: T05. Paths: engine types, frontend formatting helper/tests.
Steps: validate 1 second–24 hours; parse UI units; implement ceiling-seconds formatting; reject NaN/overflow/empty/negative; preserve invalid form input.
Accept: exact examples at 0,1,59,60,3599,3600 and 86400 seconds; UTF labels counted by characters rather than bytes.

### T07 — Countdown transitions
Depends: T05/T06. Paths: engine transition module/tests.
Steps: implement configure/start/pause/resume/reset/end with explicit elapsed samples; no OS calls; invalid states unchanged; freeze remaining on pause.
Accept: delayed tick and pause-at-expiry tests pass; no tick-based decrement drift.

### T08 — Completion and cycle scheduling
Depends: T07. Paths: engine module/tests.
Steps: implement exactly one phase-completion effect, focus count, short/long break, skip and explicit advance; default next phase idle.
Accept: four focus completions select long break; skips/reset never increment; repeated deadline checks never duplicate effects.

### T09 — Revision and repeat safety
Depends: T08. Paths: engine/service DTO/tests.
Steps: stale revision errors return current snapshot; repeat Start/Pause harmless; skip/reset cannot apply twice; sample expiry before commands.
Accept: simultaneous-like interleavings and out-of-order events produce one deterministic valid result.

### T10 — Native elapsed clock adapter
Depends: T03/T07. Paths: src-tauri/src/platform/clock.rs.
Steps: implement suspend-inclusive sample per OS using verified APIs, checked conversions and narrowly scoped unsafe; add monotonic fallback with explicit capability status.
Accept: unit tests for conversion/overflow; native sleep test recorded where executed. No use of wall-clock as the sole elapsed source.

### T11 — Service and deadline scheduling
Depends: T08–T10. Paths: service.rs.
Steps: one owner serializes commands/ticks/effects; schedule nearest deadline; publish visible snapshots at <=1Hz; stop idle scheduling; dispatch desktop calls on required thread.
Accept: hidden UI still completes; no lock held over I/O/await/UI dispatch; quit stops worker and unregisters resources.

### T12 — Tauri invoke/event bridge
Depends: T05/T11. Paths: commands.rs, lib.rs, bridge.ts.
Steps: expose allowlisted commands; validate payloads; subscribe-before-get; reject old revisions; return structured errors.
Accept: frontend can control real Rust engine; integration test or manual invoke smoke confirms JSON shape. Mocks are not reported as native tests.

### T13 — Theme tokens and typography
Depends: T04. Paths: src/styles/.
Steps: define semantic light/dark/high-contrast tokens; system preference handling; tabular digits; focus ring; reduced motion; no remote fonts.
Accept: contrast measurements for each palette/state; no animation needed to understand status.

### T14 — Accessible main timer view
Depends: T06/T12/T13. Paths: app.ts, timer-view.ts.
Steps: semantic headings/forms/buttons; duration/phase/label; state-specific controls; safe text rendering; patch text without remounting controls.
Accept: keyboard-only start/pause/resume/complete; focus remains stable during ticks; screen reader does not announce each second.

### T15 — Settings and presets
Depends: T14/T18. Paths: settings-view.ts, settings DTO.
Steps: preset/custom durations, break interval, theme/text scale; dirty/save/cancel states; validation messages; active configuration frozen until explicit confirmation.
Accept: saving error preserves edits; preset changes cannot silently reset a running phase; settings round-trip.

### T16 — Dialogs and local shortcuts
Depends: T14. Paths: shortcuts.ts and view dialog code/tests.
Steps: implement PLAN shortcut table; ignore text entry/IME/repeat; confirmation initial focus Cancel; restore focus after close.
Accept: keyboard scripted workflows and shortcut collision cases pass. Space on a focused button acts only once.

### T17 — Compact mode and pin request
Depends: T12/T14. Paths: platform/window.rs, frontend view mode.
Steps: reuse one window; persist normal/compact sizes independently; allowlist pin/restore commands; expose capability failures.
Accept: mode switches never pause/reset; 200% text can reflow; unsupported pin is explained and does not appear successfully enabled.

### T18 — Durable settings store
Depends: T05. Paths: storage.rs/tests.
Steps: schema version, defaults, validation; same-directory temporary+flush+replace; backup; future-schema refusal; corrupted-file quarantine; revisions.
Accept: round-trip, corrupted file, replacement, write failure and migration fixtures pass; no silent data overwrite.

### T19 — Recovery checkpoints
Depends: T11/T18. Paths: service/storage and recovery UI.
Steps: persist transitions and 30-second active checkpoints; restore as recovery_pending; show checkpoint age; resume/discard choice; preserve phase completion ID.
Accept: crash/restart fixture recovers paused; no duplicate completion/sound; storage errors leave timer functioning with warning.

### T20 — Initial icon assets and app identity
Depends: T04/T13. Paths: src/assets/, src-tauri/icons/, notices.
Steps: original source vector clock mark; consistent licensed control icons; generate required native formats deterministically; light/dark tray variants.
Accept: files valid, 16/32/128px inspection recorded; installed app identity and desktop entry match bundle ID. No emoji functional icons.

### T21 — Alpha unit and browser acceptance
Depends: T06–T20. Paths: test suites, CI script configuration.
Steps: execute pure engine/storage tests; frontend behavior/keyboard/focus tests; browser axe and reflow checks; test real bridge separately.
Accept: all executed checks pass; missing OS/reader checks listed plainly. No ignored failing tests.

### T22 — Alpha CI and native packages
Depends: T20/T21. Paths: .github/workflows/, package scripts.
Steps: format/lint/typecheck/tests on PR; native Linux x64, Windows x64, macOS x64/arm64 release matrix; upload artifacts; generate per-build metadata.
Accept: successful hosted job per asset, no reliance on local Linux to certify others; dependencies/versions pinned.

### T23 — Alpha documentation and release
Depends: T22. Paths: README, CHANGELOG, version script, release workflow.
Steps: install/use/uninstall instructions; shortcuts; known limitations; version agreement; tag v0.1.0-alpha.1; checksums; publish prerelease with actual assets.
Accept: clean clone reproducibility instructions, matching source/tag/assets, verified checksum list and explicit unsigned/unverified notes.

## B: complete desktop experience

### T24 — Capabilities report
Depends: T12/T17. Paths: platform module and settings UI.
Steps: distinguish request accepted from observed support; report available/unavailable/permission_required/unknown and safe reason.
Accept: unsupported integration never silently succeeds; capability absence leaves basic timer usable.

### T25 — Tray/menu-bar control
Depends: T20/T24. Paths: platform tray adapter, service wiring.
Steps: native menu Show, contextual Start/Pause/Resume, Next, Quit; state-based labels; menu-based Linux restore path.
Accept: no dependence on Linux click events; tray actions share engine path; quit cleanup verified.

### T26 — Close, restore and single-instance lifecycle
Depends: T25. Paths: lib.rs/platform/window.rs.
Steps: initialize single-instance ownership before writes; second launch shows existing app; quit by default; opt-in hide only with functioning restore path.
Accept: no duplicate timer/storage writers; absent tray cannot strand app; OS shutdown does not spawn new windows.

### T27 — Monitor and DPI recovery
Depends: T17/T26. Paths: window placement adapter/tests.
Steps: store logical bounds/monitor identity when meaningful; clamp visible work area; handle monitor disappearance; Restore defaults menu.
Accept: negative origins, scale changes, unplug/replug, compact restore tested; compositor-owned placement documented.

### T28 — Local shortcut remapping
Depends: T16/T18. Paths: shortcuts/settings/tests.
Steps: record chord, normalize native modifiers, detect duplicates/reserved combinations, reset defaults, update tooltips/help.
Accept: edit fields and IME stay usable; invalid binding does not replace a working one.

### T29 — Global shortcut native path
Depends: T24/T28. Paths: platform/shortcut.rs.
Steps: opt-in Windows/macOS/X11 registration; dispatch only pressed transition; conflict error; unregister old binding transactionally and restore on failure.
Accept: failures explained, repeated key no double action, disabling unregisters all owned bindings.

### T30 — Wayland shortcut portal
Depends: T29. Paths: dedicated portal adapter.
Steps: create session, negotiate version, request bindings, respect portal-selected triggers, reconnect safely and close session.
Accept: actual GNOME/KDE tests or explicit unsupported status. No X11-only library advertised as Wayland support.

### T31 — Completion notifications
Depends: T24. Paths: notification.rs/service.
Steps: request permission contextually; one notification per completion while alive; click shows timer; respect system suppression; preserve in-app completion.
Accept: denied permission, notification service absent and notification failure never stop timer.

### T32 — Optional completion sound
Depends: T31. Paths: sound adapter/assets/settings.
Steps: short licensed local sound; off by default, preview/volume/mute; audio device failure harmless; no looping alarm.
Accept: no sound without consent, reduced distraction behavior and license notice recorded.

### T33 — Suspend/resume and auto-advance
Depends: T10/T19/T31. Paths: service/platform power adapter.
Steps: observe sleep/wake; reconcile continuous elapsed; one completion maximum after gap; mark interrupted; optional auto-next while awake only.
Accept: sleep past several phases cannot generate synthetic work or notification storm; missed power signal handled conservatively.

### T34 — Bounded session history
Depends: T18/T33. Paths: history storage and view.
Steps: unique phase record, outcomes, UTC/local date, interruption confirmation, retention/disable/delete; totals from milliseconds.
Accept: 90-day/5,000 record bounds; DST/timezone/duplicate effects tested; interrupted records excluded from confirmed focus totals.

### T35 — Safe history export
Depends: T34. Paths: export module/commands/view.
Steps: backend save dialog; CSV escape + formula mitigation; JSON schema; cancellation and disk-full handling.
Accept: Unicode, quotes/newlines, =,+,-,@ prefixes with whitespace/control characters tested; original JSON strings preserved.

### T36 — Autostart
Depends: T26. Paths: native adapter/settings.
Steps: disabled default; explicit toggle; observe actual registration; failures restore UI truth; document portable-package caveats.
Accept: no creation merely by launch; disable and uninstall cleanup verified per advertised platform.

### T37 — Localization readiness
Depends: T14–T16. Paths: i18n.ts/catalog/styles.
Steps: move user-facing text to stable keys; pluralization; localized duration announcements; logical CSS; pseudo-long and RTL fixtures.
Accept: no concatenated English fragments or clipped translated controls; English remains complete.

### T38 — About, licenses and diagnostics
Depends: T20/T24/T34. Paths: About/settings, diagnostics module, notices.
Steps: build version/hash, dependency notices, support links; preview diagnostics; redact personal fields and absolute user paths.
Accept: no label/secret in exported diagnostics; all shipped icon/font/sound licenses accounted for.

### T39 — Beta integration and release
Depends: T24–T38. Paths: tests, evidence, changelog/release.
Steps: native keyboard/tray/shortcut/notification/recovery scripts; package installation; document matrix gaps; release 0.2.0-beta.1 only with corresponding implemented feature set.
Accept: no alpha feature silently assumed complete; beta known issues match actual evidence.

## R: production readiness

### T40 — Screen-reader audit
Depends: T39. Paths: docs/evidence/accessibility.md and targeted fixes.
Steps: full manual script with NVDA/Narrator, VoiceOver, Orca; native menus/installers; packaged accessibility trees; criteria table.
Accept: reader/OS/version/package hash recorded per result; blockers fixed before stable claim.

### T41 — Visual and alternate-input audit
Depends: T39. Paths: evidence and targeted UI fixes.
Steps: 200% scale, high contrast, reduced motion/transparency, touch target, voice input, magnification, RTL and layout review.
Accept: no hidden controls, inaccessible drag-only operation or color-only states; screenshots tied to build.

### T42 — Performance and long soak
Depends: T39. Paths: reproducible measurement scripts/docs.
Steps: release-mode startup/process-tree memory/CPU/disk tests; eight-hour run; launch/quit loop; compare PLAN budgets.
Accept: raw measurements and method recorded; unexplained growth or excess resource use resolved/reviewed.

### T43 — Security, dependency and license review
Depends: T39. Paths: capability/CSP config, manifests, SECURITY.md.
Steps: audit allowlisted commands/window permissions; prevent external navigation/remote scripts; dependency advisories/licenses; fuzz parsing/state sequences.
Accept: minimal permissions, no arbitrary shell/filesystem bridge, no reachable unresolved critical issue hidden by exclusions.

### T44 — Installer, upgrade and uninstall
Depends: T39. Paths: packaging scripts/tests/docs.
Steps: clean machine install; missing runtime; upgrade retaining data; downgrade refusal; uninstall retaining/removing user data as documented.
Accept: verified steps per distributed format/architecture; dependencies and baseline explicit.

### T45 — Signed release pipeline
Depends: T43/T44. Paths: release workflow and docs.
Steps: protected signing secrets; Windows Authenticode; macOS sign+notarize+staple; signature verification; checksums and source metadata; fork PR secrets isolation.
Accept: signing actually verified, or stable release remains blocked with unsigned alpha/beta clearly labelled. Never fabricate certificates.

### T46 — Community maintenance
Depends: T39. Paths: README/CONTRIBUTING/CODE_OF_CONDUCT/issue templates.
Steps: newcomer setup; deterministic checks; architecture overview; issue/bug/accessibility templates; release policy; supported OS and security support window.
Accept: clean-clone walkthrough works; no secrets or undisclosed service required for local use.

### T47 — Stable release decision
Depends: T40–T46. Paths: release evidence index, changelog/version.
Steps: check all ten PLAN stable gates; resolve open blockers; tag 1.0.0; build immutable artifacts; verify hashes/signatures; publish release.
Accept: every stable claim points to evidence. If a gate cannot be verified, remain prerelease and state why.

## First-wave execution grouping

Integrator completes T01/T02/T04 shared skeleton and freezes T05. Then run three free-model OpenCode workers in parallel:

1. Engine: T06–T09 and core of T19, pure tests; owns engine subtree.
2. Frontend: T13–T16 plus compact/recovery presentation; owns src and frontend tests.
3. Backend integration: T10–T12/T17–T19/T24–T26 as feasible, owns backend glue/storage/platform files.

Integrator implements T20–T23, reviews cross-boundary behavior, runs checks, fixes integration and records accurate status. Advanced B/R tasks remain explicitly pending unless actually implemented and verified. An initial alpha must not be reported as the completed production roadmap.
