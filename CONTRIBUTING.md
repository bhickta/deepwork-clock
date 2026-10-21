# Contributing to Deepwork Clock

Thanks for helping. This project is small on purpose, so the bar for a change
is "clear behaviour, honest tests, focused diff".

## Before you start

- Read `docs/PLAN.md` for the behaviour and `docs/TASKS.md` for the work
  breakdown. `docs/HANDOFF.md` explains how the project is split across
  workers.
- Open an issue first for anything larger than a bug fix, so the design can be
  discussed before the code is written.

## Development setup

```bash
npm ci
rustup toolchain install   # installs the version pinned in rust-toolchain.toml
```

You need the Tauri 2 prerequisites for your platform
(<https://v2.tauri.app/start/prerequisites/>). On Ubuntu 24.04:

```bash
sudo apt install libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev \
  librsvg2-dev patchelf libxdo-dev
```

## The checks every change has to pass

```bash
npm run lint
npm run typecheck
npm test -- --run
npm run test:scripts
npm run build

cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/src/core/Cargo.toml
cargo test --manifest-path src-tauri/src/engine/Cargo.toml
```

`npm run verify:versions` must pass too: the version in `package.json`,
`src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, both library crates and
the About view have to agree.

## House rules

- **The timer lives in Rust.** The frontend renders snapshots and sends
  commands; it never counts down on its own and never decides that a phase
  completed.
- **No new runtime framework.** Vanilla TypeScript, semantic HTML and CSS.
  A new framework needs an architecture decision first.
- **No `any` at the bridge.** The contract types in `src/contract.ts` are
  validated at runtime; unknown fields are ignored, unknown schema versions
  are rejected.
- **Integer milliseconds.** No floating point duration arithmetic, no
  wall-clock subtraction as an elapsed source.
- **Deterministic tests.** No real sleeps in the engine tests, no network in
  the unit tests. A test that depends on timing or on a display needs an
  explicit configuration.
- **Honest claims.** If a check was not executed, say so. A passing local
  Linux run does not certify Windows or macOS, and an axe run does not certify
  a screen reader.
- **Small commits.** One behaviour per commit, with the rationale in the
  message. Never commit `node_modules/`, `target/`, `dist/` or secrets.

## Accessibility changes

Accessibility is a release gate, not a nice-to-have. When you touch the
interface:

- keep the `role="timer"` element with `aria-live="off"`,
- announce state changes through the single polite live region, never every
  second,
- give every icon-only control an accessible name and a visible tooltip,
- keep the focus order logical and return focus to the invoking control after
  a dialog,
- check the 200% text scale and the narrow layout for clipping.

## Pull requests

1. Branch from `main` with a descriptive name.
2. Make the change, add the tests, run the checks above.
3. Describe what you changed, what you verified and what you did **not**
   verify.
4. Reference the issue or task card from `docs/TASKS.md`.

## Reporting bugs

Include the operating system, the app version (from the About view), the
package you installed, the steps to reproduce, what you expected and what
happened. Accessibility problems should include the screen reader and its
version.

## Security

Please do not open a public issue for a security problem. Follow
[SECURITY.md](SECURITY.md).
