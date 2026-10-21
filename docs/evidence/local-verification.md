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
