# Changelog

All notable changes follow [Semantic Versioning](https://semver.org/).

## 0.3.0 - 2026-08-16

- Add Web management for IP/CIDR login bypass rules in Account & Security, available to account sessions and already-whitelisted visitors.

## 0.2.1 - 2026-08-16

- Capture body-scoped skin variables and allow embedded or remote login background images under CSP.
- Persist an explicitly acknowledged Harness internal-testing notice in the remote browser and replay it for unchanged copy after reloads.
- Keep Account & Security password inputs inside their form container under content-box host themes.

## 0.2.0 - 2026-08-16

- Add a theme-aware login page that reuses the last authenticated Harness skin snapshot in the same browser.
- Add a Web client bundle with a sidebar sign-out action and an Account & Security settings section.
- Add authenticated account details and password-change endpoints; password changes verify the current password and revoke all existing sessions.
- Prevent IP-whitelist bypasses from changing account credentials without an account session.

## 0.1.3 - 2026-08-16

- Pin authenticated Web profiles to Harness's in-app browse directory picker so remote access never opens a dialog on the Host desktop.

## 0.1.2 - 2026-08-16

- Verify the version-driven npm publication workflow from a `main` push.

## 0.1.1 - 2026-08-16

- Leave manually selected password strength to the local owner; only reject an empty password.

## 0.1.0 - 2026-08-15

- Add the fail-closed public authentication proxy bundle for the Harness Web profile.
- Add the pluggable Auth Center and built-in local password provider.
- Add password retry locking, one-use captcha modes, IP/CIDR whitelist, and session revocation.
- Add the interactive and subcommand-based `dsh-auth` owner CLI.
- Add version-driven npm publication automation.
