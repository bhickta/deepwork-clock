## What changed

<!-- One behaviour per pull request, with the reason. -->

## Related issue or task card

<!-- Link the issue, or name the card in docs/TASKS.md. -->

## Verification

- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm test -- --run`
- [ ] `npm run test:scripts` (when release tooling changed)
- [ ] `npm run build`
- [ ] Rust format, Clippy and tests for the affected crates
- [ ] Checked the keyboard path and any affected dialog focus
- [ ] Checked the 200% text scale and the narrow layout if the UI changed

## What was not verified

<!-- Be explicit. A local Linux pass does not certify Windows, macOS,
     Wayland, a screen reader or a physical audio device. -->

## Checklist

- [ ] Tests cover the behaviour, including a failure case where relevant
- [ ] The timer stays authoritative in Rust; no frontend-side countdown
- [ ] No `any` at the bridge and no new runtime framework
- [ ] Documentation or changelog updated when behaviour changes
- [ ] No secrets, `node_modules/`, `target/`, `dist/` or build output
- [ ] Accessibility impact considered (names, focus, live regions, contrast)
