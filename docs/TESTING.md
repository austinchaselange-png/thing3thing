# Testing Things 3

## What has been verified, and what has not

| Area | Verified by | Status |
|---|---|---|
| Protocol encoding (ids, dates, notes, recurrence, payload shapes) | Rust unit tests mirroring the reference MCP | ✅ automated |
| HTTP transport (paths, headers, schema checks, failure classification, key redaction) | Tests against a local mock HTTP server | ✅ automated |
| Sync engine (cursor safety, conflicts, uncertain writes, crash recovery, read-only gate) | Tests against `FakeCloud` | ✅ automated |
| Windows Credential Manager round-trip | `cargo test -p tings3` on the Windows CI runner | ✅ automated (Windows only) |
| UI list semantics, quick-entry parsing, dialogs | Vitest + Testing Library | ✅ automated |
| Full app with demo data (IPC, writes, global shortcut, quick entry) | Run manually on Linux under Xvfb | ✅ manual |
| Windows-specific UX (tray, toasts, Mica, autostart, installer) | — | ⚠️ needs a Windows machine |
| **Real Things Cloud reads** | — | ⚠️ **not verified** — no account was available during development |
| **Real Things Cloud writes / sync with iPhone** | — | ⚠️ **not verified** — must be tested with a disposable account (below) |

The write payloads are copied field-for-field from things-cloud-mcp, which its
authors tested against Things.app, but **Things 3's own end-to-end sync with
Things Cloud has not been exercised.** Treat it as untested until you have run
the checks below.

## Automated tests

```powershell
npm ci
npm test                 # Vitest: UI logic and components
npm run typecheck
cargo test --workspace   # Rust: connector, engine, app (Windows adds a Credential Manager test)
cargo clippy --workspace --all-targets -- -D warnings
```

## 1. Demo mode (no account, nothing leaves the PC)

1. Install the artifact from GitHub Actions (`Things 3_*_x64-setup.exe` or `.msi`).
2. First launch opens demo data. Try: completing to-dos, Ctrl+N with
   "Call mom tomorrow at 5pm #Calls", dragging a to-do onto Someday, the
   When picker (Ctrl+S), projects with headings, Quick Find (Ctrl+F).
3. Press **Ctrl+Alt+Space** from another app → Quick Entry appears. Enter saves, Esc hides.
4. Close the window → Things 3 stays in the tray. Tray → Quit exits.
5. Settings → General: change the shortcut, toggle launch at sign-in, then
   sign out/in of Windows to confirm.
6. Give a demo to-do a reminder 2 minutes from now (When → Add Reminder) and
   wait for the Windows notification.
7. Settings → Sync → **Simulate iPhone edit**, then edit the same to-do's
   title → the conflict dialog appears.

## 2. Read-only connector check (your real account, safe)

Reading never changes anything in Things Cloud.

```powershell
cargo run -p things-cloud --features cli --bin things-cloud-cli -- summary --email you@example.com
```

The CLI prompts for the password (not echoed or stored) and prints counts
for Inbox/Today/Upcoming/Someday/projects/areas/tags. Compare with your iPhone.
Add `--titles` to list Today's titles.

If it prints a `newer format:` line (for example `Task7`), your Things
apps already use a newer data format. If it lists no unfamiliar fields, Things 3
saves changes in that newer format (experimental — test on a disposable account
first). If it lists unfamiliar fields, changes stay off; the field names (never
your data) are what's needed to support them.

Then in the app: Settings → Account → Connect. Things 3 connects **read-only**.
Check that every list matches your iPhone, edit something on the iPhone, and
confirm it appears in Things 3 within ~30 s (or press F5).

## 3. Writes — disposable account only

**Do not do this with your real account first.** A malformed write can make
Things on iPhone crash while syncing, and cannot be removed from the server.

1. Create a new Things Cloud account on the iPhone (Settings → Things Cloud →
   sign out, create account) or use a spare device.
2. Add a few to-dos, a project with a heading, an area, tags, a repeating to-do
   and a checklist on the iPhone.
3. Connect Things 3 to the disposable account, then Settings → Sync → *Allow
   changes* and accept the warning.
4. In Things 3, one at a time, and check the iPhone after each:
   - create a to-do in Inbox, Today, This Evening, a date, Someday;
   - complete / reopen / cancel; move to Trash and restore;
   - edit title, notes, deadline, tags, reminder;
   - move between Inbox, an area, a project and a heading;
   - add, tick and rename checklist items;
   - complete a project (its to-dos complete too);
   - create a project, heading, area and tag.
5. Conflict: open a to-do's editor in Things 3, change its title on the iPhone,
   then change it in Things 3 → conflict dialog. Try both buttons.
6. Uncertain writes: disconnect the network *while* saving (or block
   `cloud.culturedcode.com` in the firewall mid-request). Things 3 must show
   "may not have been saved", never resend on its own, and resolve it after the
   next sync.
7. Repeating to-dos: complete an instance in Things 3; the next instance should be
   created by the iPhone app after it syncs.

## 4. Destructive operations — disposable account only

Enable Settings → Sync → *Allow permanent deletions* (requires typing DELETE),
then test deleting an empty area, a tag, a checklist item and "stop repeating".
Confirm on the iPhone. Things 3 refuses to delete an area that still contains
items.

## Reporting results

Please record the Things for iPhone version and what you observed. If Things
crashes after a Things 3 write, stop, sign the iPhone out of that account, and
open an issue with the to-do kind you edited (do not paste credentials).
