# Production readiness: T40–T47

Status as of 2026-10-22. The version is `0.2.0-beta.1` and nothing in this
file has passed. It records what the project knows, what it does not know, and
what a maintainer has to run before a stable release.

**`1.0.0` must not be tagged while any row below is unverified.** A green CI
run, a local Linux launch or a browser accessibility scan does not satisfy these
gates. PLAN.md section 14 lists the ten stable gates; this file is the working
checklist for the last eight cards.

| Card | Requirement | Status | Evidence that exists | Maintainer must run |
|---|---|---|---|---|
| T40 | Manual screen-reader audit on every claimed OS | **Not verified** | Automated axe checks on the browser preview and native WebDriver DOM/focus checks. No packaged application was driven by a screen reader. | The full manual script in `docs/evidence/README.md` with NVDA and Narrator on Windows 11, VoiceOver on macOS 13+ (arm64 and x64), and Orca on Ubuntu 24.04 with at least GNOME. Use installed packages, not the dev server. Record reader name/version, OS, desktop, package hash, each step, expected and actual result. File blockers before any stable claim. |
| T41 | Visual, scaling and alternate-input audit | **Not verified** | Browser tests cover 200% text reflow, narrow layouts and high-contrast tokens; pseudo-localization and RTL helpers exist. No native 200% audit, OS high-contrast session, reduced-motion/transparency check, voice-control run, magnification run, or RTL layout review tied to a package. | On each packaged target: 200% text scale, OS high contrast, reduced motion and transparency, 44 px targets, keyboard-only and voice-control flows, magnification, and an RTL pseudo-locale pass. Tie screenshots and notes to a package hash and commit. Fix clipping, lost controls and color-only states. |
| T42 | Performance and eight-hour soak | **Not verified** | PLAN.md section 12 has initial budgets. No release-mode startup, process-tree memory, CPU or soak measurement is published for this wave. | Measure release builds with devtools closed: 20 warm launches (median and p95), cold first launch separately, whole process tree including WebView helpers, five-minute idle and running CPU, and an eight-hour soak with a memory-growth check. Record OS/desktop, hardware, WebView version, commit, package hash, interval and raw output. Compare against the PLAN budgets and document any reviewed exception. |
| T43 | Security, dependency and licence review | **Not verified** | Minimal allowlisted bridge, restrictive CSP, a third-party notice generator and `SECURITY.md`. No full advisory audit, no fuzzing of parsers or state sequences, and no final licence inventory for the bundled chime and icons. | Audit the capability and window allowlists, external navigation and remote-content paths. Install and run advisory checks over both lockfiles (for example `npm audit` and `cargo audit`, or an equivalent advisory database check), review transitive licences and the generated notices, and fuzz settings/recovery/history parsing plus command sequences. Record the tool versions and results. No reachable unresolved critical issue may be excluded silently. |
| T44 | Installer, upgrade and uninstall | **Not verified** | A local Linux `.deb` was built and launched, and the desktop-entry fix was checked on Regolith. There is no clean-machine install matrix, no upgrade/downgrade test and no published package hash. | For every distributed format and architecture (Windows NSIS, macOS DMG, Linux `.deb` and AppImage): install on a clean machine or VM, confirm missing-runtime behavior, upgrade while retaining data, verify downgrade refusal, uninstall, and confirm whether user data is retained as documented. Record the exact format, architecture, OS baseline and steps. |
| T45 | Signed release pipeline | **Blocked: no signing credentials** | Unsigned alpha workflow source only. No Authenticode certificate, no Apple Developer ID, no notarization or stapling, and no signature verification. | Configure protected signing secrets outside fork PRs. Sign the Windows package with Authenticode, sign and notarize plus staple the macOS package, then verify the signatures on a clean machine. Publish per-artifact hashes and source metadata. Never fabricate a certificate or claim a signature that was not verified. Without credentials, remain an unsigned prerelease. |
| T46 | Community maintenance readiness | **Not verified** | README, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, issue templates and a pull-request checklist exist in source. No clean-clone walkthrough on a fresh account or machine is recorded. | Clone the repository into a fresh directory and follow README/CONTRIBUTING exactly, including toolchain install, `npm ci`, all documented checks and a packaged build. Confirm no secrets, private services or undisclosed accounts are required. Check that issue templates and support links resolve, and state the supported OS and security-support window. |
| T47 | Stable release decision | **Blocked** | The version is still `0.1.0-alpha.1`; no stable tag, no published stable artifacts. | Re-check all ten gates in PLAN.md section 14 against recorded evidence. If any gate is unverified, stay on a prerelease and state why in the release notes. Only tag `1.0.0` after the reader matrix, audits, installer checks, signing and soak have passed with artifacts and hashes attached. |

## Rules for this file

- Change a status only after the check was executed and the evidence was
  recorded with a date, tool version, package hash and result.
- Keep "not verified" explicit. A passing local Linux run does not certify
  Windows or macOS, and an automated axe run does not certify a screen reader.
- Do not publish a stable release note that implies a row passed while it is
  still marked unverified here.
