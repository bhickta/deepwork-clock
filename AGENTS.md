# Project instructions

- Read `docs/PLAN.md`, then your task in `docs/TASKS.md`, before implementation.
- Astra is for planning, investigation, architecture and handoffs only. Implementation must use a non-Astra model.
- Keep the timer authoritative in Rust. The frontend renders snapshots and requests commands.
- Use Tauri 2, strict TypeScript and semantic HTML. Do not add another application framework without an architecture decision.
- Never claim an OS integration, accessibility check, signing step or release verification passed without evidence.
- Keep tasks small, tests deterministic and commits focused. Do not commit credentials or build output.
- Parallel workers may edit only their assigned paths. The integrator owns shared configuration and commits.
- All model execution requested for this project must use explicitly free models unless the user authorizes otherwise.
