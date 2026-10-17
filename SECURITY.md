# Security

## Where your secrets live

| Secret | Stored in | Notes |
|---|---|---|
| Things Cloud password | Windows Credential Manager (`Things 3 (Things Cloud)` / your email) | Encrypted with DPAPI for your Windows user. Sent only to `https://cloud.culturedcode.com` in the `Authorization` header of the account-verify request. |
| Things Cloud history key | Same Credential Manager entry | Grants read **and write** access to all your Things data; treated like a password. Never logged, never shown, never sent to the UI. |
| Your to-dos | `%LOCALAPPDATA%\app.tings3.desktop\cache-*.sqlite` | Raw event log for offline use. Protected by your Windows account's file permissions, **not** encrypted at rest. Delete it with Settings → Account → Disconnect → "Also delete the local copy". |
| Preferences | `%APPDATA%\app.tings3.desktop\settings.json` | Your email address and UI preferences. No secrets. |

If Windows Credential Manager is unavailable, connecting fails. There is no
plaintext fallback.

## What Things 3 will never do

* Put credentials in the repository, build logs, CI configuration or cloud
  session environments. The CI workflows use **no secrets** and make no
  network requests to Things Cloud.
* Log request/response bodies, `Authorization` headers or URLs containing the
  history key. Network errors are stripped of URLs before being shown.
* Run a local server. The UI talks to the Rust core over Tauri IPC only.
* Retry a write whose outcome is unknown.

## Hardening

* Content-Security-Policy restricts the webview to bundled code; no remote
  scripts.
* IPC commands are gated per window (`src-tauri/capabilities/`). The
  quick-entry window can only read state and create to-dos.
* `freezePrototype` is enabled.
* The Rust `Secret` type redacts itself in `Debug`/`Display` and zeroes memory
  on drop.

## Known limitations

* Installers built by CI are **unsigned**. Windows SmartScreen will warn.
  Verify the artifact came from this repository's Actions run.
* The protocol is unofficial; see [docs/THINGS_CLOUD_RESEARCH.md](docs/THINGS_CLOUD_RESEARCH.md)
  for its risks, including permanent damage to an account from a malformed write.
* The reference MCP repository contains a committed test-account password in
  its `CLAUDE.md`. Things 3 does not use or copy it.

## Reporting

Please open a private security advisory on the repository rather than a
public issue.
