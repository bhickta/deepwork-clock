# Small-model implementation protocol

## Mandatory read and execution loop

1. Read AGENTS.md and PLAN.md. Read exactly the assigned task card and its prerequisites in TASKS.md.
2. Inspect existing files and git status. Do not regenerate an already initialized project.
3. Write a five-line understanding: goal, inputs, outputs, owned paths, checks.
4. Implement the smallest coherent change. Follow the frozen bridge contract.
5. Test behavior, including one relevant failure case. Do not add superficial tests just to increase counts.
6. Run the task's checks. Fix failures in owned files; report shared-file fixes to the integrator.
7. Report files changed, behavior, exact commands/results, limitations and next dependency.
8. Integrator reviews, updates PROGRESS.md and makes a focused commit. Workers do not commit or push.

If a card exceeds roughly 400 lines of meaningful changed source or involves several unrelated behaviors, split it into lettered subcards before coding. Generated lockfiles/native icon files do not count toward that guideline. Never implement unrelated cards while waiting for a dependency.

## Parallel ownership for the first implementation wave

- Engine worker: `src-tauri/src/engine/**` and engine tests only. No Cargo/config changes; request dependencies from integrator.
- Frontend worker: `src/**`, `index.html`, `tests/frontend/**` only. Use contract.ts as defined in PLAN.md. No package/config changes; request dependencies from integrator.
- Integration/platform worker: `src-tauri/src/{lib,main,commands,service,storage,platform}.rs`, `src-tauri/src/platform/**`, `src-tauri/{Cargo.toml,build.rs,tauri.conf.json,capabilities/**}`, native integration tests. Do not edit engine files. Read the engine public API first or coordinate a proposed interface before writing glue.
- Integrator: root package/tooling, lockfiles, CI/releases, documentation, native assets, review, conflict resolution and commits.

The frozen engine API for the first wave must be documented by the engine worker immediately: Engine::new, snapshot, apply(action, elapsed_ms), tick(elapsed_ms), restore, settings/config validation. Prefer a serializable Action enum and explicit Transition {snapshot,effects}. Integration worker may wait for this message or design glue around these specified names; never infer undocumented internals.

## Model/run policy

Use OpenCode and explicitly free model IDs. Preferred discovered candidate: `opencode/minimax-m3.1-flash-free`; verify with a minimal tool-use run. Do not use Astra for implementation. No paid fallback without authorization. Keep raw logs outside the repository and record only session IDs, assigned tasks and concise outcomes in PROGRESS.md.

Parallel runs must use their stated ownership. One actor owns package installs and version locks. No worker may push, change git remotes, publish releases, access signing secrets or install system packages. Integrator handles authorized repository/release operations after checks.

## Completion response template

```
Task:
Files:
Behavior implemented:
Checks (exact commands and results):
Not verified / remaining:
Integration instructions:
```

## Useful command contract after bootstrap

Run from repository root unless noted. These scripts must be established by T04 before referring to them as existing commands.

```
npm ci
npm run typecheck
npm run lint
npm test -- --run
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri -- build
```

Core tests should remain runnable without a display. Desktop tests use a real session or explicitly configured virtual display. A local Linux pass cannot certify macOS or Windows.
