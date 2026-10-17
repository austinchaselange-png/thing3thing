# Things 3: Things-style Windows task manager with a local Things Cloud connector

## Summary

A Tauri 2 + React + TypeScript desktop app for Windows, modelled on Things 3,
that reads and (after explicit opt-in) writes Things Cloud so it can sync with
Things on iPhone. The Things Cloud protocol is ported to Rust from
[wbopan/things-cloud-mcp](https://github.com/wbopan/things-cloud-mcp) and runs
inside the app — no hosted MCP, no local server.

## Implementation

**Research and plan** — `docs/THINGS_CLOUD_RESEARCH.md`, `docs/ARCHITECTURE.md`.
The MCP was reviewed for capabilities, authentication (the password only
fetches a *history key*, which then acts as a bearer secret for all reads and
writes), and security. Findings that shaped the design: it's a hosted
multi-tenant service; debug logging dumps auth headers; the repo commits a
test-account password; several tools make permanent deletions.

**`crates/things-cloud`** — protocol connector
- Base58 ids (validated before every write — malformed ids permanently break the account), legacy-id mapping, note encoding and patches, recurrence rules, date encoding.
- Event-replay `State` with per-field revisions; all-or-nothing page application; fail-closed on unknown kinds and schemas newer than 301.
- `HttpTransport`: 1 request/second, no request logging, error messages stripped of URLs (which contain the history key). Commit failures are classified as *rejected* (connection never made, 4xx) or *uncertain* (timeout, dropped connection, 5xx, bad reply).
- Payload builders that mirror the MCP field for field and enforce the invariants that crash Things.app (`md` null on create, headings `st=1`, positive `ix`).
- `FakeCloud` for tests, demo data and failure simulation; `things-cloud-cli`, a read-only diagnostic tool.

**`crates/things-sync`** — cache and safe write pipeline
- SQLite cache of the raw event log and cursor, bound to one history; the app opens instantly and works offline.
- Write policy: read-only by default → writes (opt-in) → permanent deletions (separate opt-in plus typed DELETE).
- Pipeline: policy gate → block if an earlier write is unresolved → pull → field-level conflict check against the revision the user saw → journal → commit **once** → on an uncertain outcome, reconcile by reading only (matched on id, kind, action and our unique timestamp). Never auto-retried. A write still marked "sending" at startup is treated as uncertain.
- Semantic `Mutation`s from the UI (create, edit, schedule, move, complete, trash, checklists, areas, tags, stop repeating) mapped to wire items following Things' rules.

**`src-tauri`** — Windows integration
- Credentials in Windows Credential Manager (DPAPI); no plaintext fallback.
- Background sync worker with back-off (offline, rate limiting, auth problems, schema changes), reminder notifications, tray, close-to-tray, global quick-entry shortcut, autostart, single instance, optional Mica.
- Least-privilege IPC: commands are declared in `build.rs`; the quick-entry window can only read state and create to-dos. Strict CSP.

**`src`** — React UI
- Inbox, Today (+ This Evening), Upcoming, Anytime, Someday, Logbook, Trash, areas, projects with headings, tags, tag filter, Quick Find.
- Inline editor (notes, checklist, tags, deadline, When with calendar and typed dates, reminders, move, trash), drag to sidebar, Things shortcuts mapped to Ctrl.
- Natural-language Quick Entry (`Call mom tomorrow at 5pm #Calls due fri`).
- Sync status, read-only banner, conflict dialog, uncertain-write review, write opt-in dialogs. Light/dark.

**CI** — `.github/workflows/ci.yml`: Linux job (typecheck, Vitest, rustfmt, clippy `-D warnings`, cargo tests); Windows job (tests including a real Credential Manager round-trip with a throwaway credential, then `tauri build` → unsigned NSIS `.exe` and `.msi` uploaded as artifacts). No secrets are configured or used.

## Testing

Automated: 54 Rust tests and 17 frontend tests (one more Rust test runs on Windows only).

Manual (Linux, Xvfb): ran the full desktop app on the demo account; completed and created to-dos through real IPC and checked the committed payloads; opened Quick Entry with the global shortcut.

**Not verified:** sync against a real Things Cloud account, and the Windows-specific UX (tray, toasts, Mica, installer). No account or Windows machine was available. See `docs/TESTING.md` for a staged plan: demo → read-only CLI and app on your real account → writes on a **disposable** account → destructive operations on the disposable account only.

## Risks

Unofficial, reverse-engineered protocol: it can break or be blocked at any time, and a malformed write could crash Things on iPhone and can't be removed from the server. The installers are unsigned. The local cache is not encrypted at rest. See `SECURITY.md` and the research doc.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01CipuGkG18ucKGVsok1ETg5
