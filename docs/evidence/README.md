# Verification evidence index

Only add a passing result after executing the check. Include commit/package hash, tool version, command or manual steps, expected and actual result, and date. Mark unavailable checks as unverified.

| Area | Required evidence | Current status |
|---|---|---|
| Core | Deterministic transitions, input bounds, repeat and completion invariants | Pending |
| Storage | Replacement, corruption, recovery, export and bounds | Pending |
| UI | Keyboard/focus/forms/contrast/reflow/browser accessibility | Pending |
| Native Linux | Release build, bridge, window lifecycle, runtime smoke | Pending |
| Native Windows | Hosted package build, installer and runtime smoke | Pending |
| Native macOS | Hosted arm64/x64 package builds and runtime smoke | Pending |
| Readers | NVDA/Narrator, VoiceOver, Orca packaged-app scripts | Unverified |
| Resource use | Whole process tree, startup and eight-hour soak | Unverified |
| Signatures | Authenticode and Developer ID/notarization | No credentials configured |

## Manual platform script

1. Record OS/desktop/display scale, assistive technology version, package hash and git tag.
2. Install from the release asset; launch through the normal application launcher.
3. Reach every control by keyboard; check visible focus and announced names/states.
4. Start a ten-second countdown; pause/resume; cancel reset; let it complete. Check exactly one completion.
5. Start a cycle; skip a phase; complete four focus phases using short test durations. Check long-break scheduling.
6. Change settings and restart; accept/discard recovery; corrupt a copied settings file in an isolated data directory.
7. Use compact mode, pin where supported, scale to 200%, change theme and OS high contrast/reduced motion.
8. Try configured global shortcut and deliberate conflict; deny notification permission; test without a tray.
9. Sleep past a deadline; change wall clock; disconnect a monitor; relaunch a second instance.
10. Export history with labels containing quotes/newlines and spreadsheet-formula prefixes. Confirm interrupted record handling.
11. Quit normally and confirm helpers terminate. Upgrade/uninstall and inspect documented data retention.
12. Record each failure precisely; do not replace results with a generic “works on my machine.”
