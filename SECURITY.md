# Security policy

## Supported versions

Deepwork Clock is in alpha. Only the latest published alpha receives fixes.

| Version | Supported |
| --- | --- |
| 0.1.0-alpha.1 | Yes |
| anything older | No |

## Reporting a vulnerability

Please **do not** open a public issue, pull request or discussion for a
security problem.

Report it privately through GitHub's security advisory form for this
repository ("Security" → "Report a vulnerability"), or by email to the
maintainer listed in the repository metadata.

Include:

- the version and package you tested,
- the platform and its version,
- the steps to reproduce,
- the impact you observed.

You can expect an acknowledgement within a few days. Please give the
maintainers reasonable time to fix the issue before disclosing it publicly.
We are happy to credit reporters in the changelog if you want that.

## Security model of this application

Deepwork Clock is a local, offline timer.

- It has no account system, no telemetry and no analytics.
- It makes no network requests at runtime and loads no remote assets.
- The Tauri bridge exposes a small, allowlisted set of commands. The frontend
  cannot open a shell, read arbitrary files or reach the network through it.
- The webview runs with a restrictive content security policy and without
  remote script or style sources.
- Settings, history and recovery data are stored in the platform application
  data directory. They contain local personal data (for example an optional
  session label) and are not removed by uninstalling the application.
- The optional global shortcut is registered with the operating system. The
  application does not capture the keyboard outside its own window and does not
  log key presses.

## Known security limitations of this alpha

- The release packages are **unsigned**. There is no Authenticode signature,
  no Apple Developer ID signature and no notarization, so the integrity of a
  downloaded package cannot be verified by the operating system. Verify the
  published `SHA256SUMS` file instead.
- There is no automatic update mechanism. Updates are manual downloads, which
  avoids an update channel, but also means an installed copy stays outdated
  until the user acts.
- The dependency inventory in `THIRD_PARTY_NOTICES.md` is generated from the
  committed lockfiles. A full advisory audit of the transitive dependency tree
  is planned before the 1.0 release.

## Hardening the build

The release pipeline runs on GitHub hosted runners with read-only
permissions for the repository, no signing secrets and no publish credentials
outside the publishing job. Pull requests from forks never receive secrets.
