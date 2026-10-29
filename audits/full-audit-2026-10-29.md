# Things 3 (thing3thing) — full audit, 2026-10-29

Branch `claude/calendar-panel-notes-windows-logbook` @ `81091f0`, plus uncommitted icon/dialog/CSS changes (left untouched).

**What I did:** read the entry point (`src-tauri/src/lib.rs`), engine and write pipeline (`crates/things-sync/src/engine.rs`, `mutation.rs`), app core (`src-tauri/src/core.rs`, `shell.rs`), store, undo, actions, links, and the main views. I ran the tests: Rust crates passed 61/61. Frontend passed 74/77, and the 3 failures are calendar tests that time out. I also ran the web build on **sample data only** (`/?sample`, mock backend) and took screenshots of Today, Inbox, Upcoming, Anytime, Someday, Logbook, Trash, a project, an area, the editor, Quick Find, Settings (all tabs), the context menu, a narrow window and the empty state, in light and dark. I didn't contact Things Cloud, and I didn't open or change your real data, cache or settings.

**Compared with the Oct 20 audit (`audits/things3.md`):** most of it was fixed in `81091f0`. Items T-S02 (undo), T-S08 (stuck "sending" write), T-P01 (whole-state broadcasts) and T-P03 (bulk writes) are still open. They're re-checked and folded in below.

---

## 1. Fix next (ranked, most serious first)

### 1. Undo/Redo can silently overwrite edits made on your iPhone
`src/lib/undo.ts:24-85`, `src/store.ts:170-184`, `src/store.ts:353`
- Every undo/redo mutation is sent with `baseRev: null`, so the conflict check (`engine.rs:318-330`) is skipped. Say you complete a to-do here, edit its title on your iPhone, then press Ctrl+Z here. The undo succeeds and nothing tells you a conflict happened. A title or notes undo writes the old text over the iPhone edit.
- Undo pops the step **before** it runs (`store.ts:173`). If the write fails (offline, read-only, blocked), the step is gone and you can't retry. Redo has the same problem (`store.ts:181`).
- Completing a project also completes its open children (`mutation.rs:524-535`). The undo only reopens the project itself (`undo.ts:27-30`), so its to-dos stay completed.
- **Fix:** after each write, record the new revision of every entity the write touched and use those as `baseRev` for undo. On conflict, show the existing Conflict dialog. Only pop the step once every mutation in it succeeds. For project completion, record the children it closed and reopen them on undo.

### 2. "Quit Things 3" from the tray can block all future writes and lose an open edit
`src-tauri/src/shell.rs:211` (`"quit" => app.exit(0)`), `src/components/TaskItem.tsx:303-312`
- Quit exits immediately. If a write is in flight (the engine has written the journal entry as `sending` and is waiting on Things Cloud), the next launch marks it **uncertain** (`engine.rs:147-151`). Every later write is then refused with "Blocked" until you review it by hand.
- The task editor only saves on close (Enter, Escape or click outside), so a title or notes edit that's still open when you quit is lost.
- **Fix:** on Quit, emit an event so the UI flushes the open editor, then take the engine lock (which waits for an in-flight write) before calling `exit`. Add a short timeout so the app can't hang.

### 3. A saved write can leave writes blocked until you restart
`crates/things-sync/src/engine.rs:338-345`, `engine.rs:238`
- If Things Cloud accepts the commit but saving it locally fails (`append_entries` / `apply_entries` / `journal_set` returns an error), the journal entry stays `Sending`. `reconcile_page` deliberately ignores `Sending` entries (line 238), but `journal_open()` still counts them, so every write gets `Blocked` for the rest of the session. Only a restart turns it into "uncertain".
- **Fix:** when any local step after a successful `commit` fails, mark the entry `Uncertain` right away (best effort). The next sync then confirms it by reading, as already designed. Never resend.

### 4. Reminders are silently skipped when the app is busy
`src-tauri/src/core.rs:400-402`, `core.rs:524-527`
- The worker checks the window `(last_reminder, now]` every ~15 s. If the engine is locked at that moment, `check_reminders` returns early, but `last_reminder` still moves forward to `now`. Locks happen during your own writes (each one syncs and commits over the network) and during the Drive backup's `try_lock`. Any reminder due in that window never fires: no toast and no in-app bar.
- **Fix:** have `check_reminders` return whether it ran, and only move `last_reminder` forward when it did.

### 5. Typing a new to-do and hitting Enter can lose the text
`src/components/ListView.tsx:31-51`
- `commit` clears the input (`setText("")`) **before** `apply` resolves. If the write fails (offline pre-sync, read-only, blocked), the toast shows an error and the title you typed is gone.
- **Fix:** keep the text until `apply` returns a report. Only clear it on success.

### 6. Every 30-second poll re-sends the whole app state, and backups re-serialize every 20 s
`src-tauri/src/core.rs:323-328`, `core.rs:487-488`, `src-tauri/src/lib.rs:70-76`, `src/store.ts:223-225`
- `sync_once` always calls `publish`, even when nothing new arrived. That rebuilds the full snapshot, emits it to every window (main, quick entry, project windows), and replaces `view`. Each list then rebuilds its index and groups.
- `publish` also bumps `data_rev` every time. That means the "nothing changed, skip the backup" check in `lib.rs:72-75` never skips: the Drive thread pretty-prints and hashes your entire data every 20 s.
- **Fix:** only `publish` (and bump `data_rev`) when `report.new_entries > 0` or the policy or issues changed. Use `publish_status` for plain status ticks.

### 7. Bulk actions are slow on Things Cloud: one sync plus one commit per to-do
`src/actions.ts:147-152`, `crates/things-sync/src/engine.rs:309`
- Completing, scheduling or tagging N selected to-dos sends N separate `apply` calls. Each one does a full pre-write sync and a commit, one at a time, against a transport limited to 1 request/s. Selecting 20 to-dos and pressing Ctrl+K means roughly 40+ requests and a long wait, and every step re-publishes the full state.
- **Fix:** add a batch mutation (one pre-sync, per-item conflict check, one commit, one publish). If that's too big, at least skip the pre-sync when one ran under a second ago.

### 8. Bulk "Undo" in the completion toast is wrong
`src/actions.ts:156-163`
- After **Reopen** (status → open), the toast's Undo calls `bulkSetStatus(..., "open")`. Those to-dos are already open, so the filter removes them all and nothing happens.
- After **Cancel**, Undo reopens instead of restoring each to-do's previous status.
- **Fix:** capture each target's previous status and restore that, or simply call `store.undo()`.

### 9. `things:///add` links have no size limit
`src/links.ts:92`, `links.ts:110-114`, `links.ts:130`
- Any app or web page can open a `things:///add?titles=…` link. Every line becomes a to-do written to Things Cloud, with no cap and no confirmation. Clipboard paste is capped at 100 (`actions.ts:324`), but links aren't. `add-project&to-dos=` is also unlimited.
- **Fix:** cap at 100, like paste. Ask "Add N to-dos?" when a link would add more than ~5.

### 10. Disconnect can leave the app half signed out
`src-tauri/src/core.rs:632-658`
- The engine is dropped (line 635) **before** the credentials are deleted (line 638). If Windows Credential Manager returns an error, the command fails. The engine is gone but settings still say `Cloud`, and the UI doesn't get a fresh state.
- "Forget cache" ignores delete errors (`let _ = remove_file`, line 642), so the app reports success even when the SQLite cache is still on disk.
- **Fix:** delete the credentials first, then drop the engine and save settings. Collect file-delete failures and report them ("Signed out, but the local cache at … couldn't be removed").

### 11. Choosing an account can quietly not stick
`src-tauri/src/core.rs:615-620` (connect), `core.rs:750-754` (use_demo), `core.rs:196-200`
- Both call `save_settings`, which only logs errors. If `settings.json` can't be written, the UI says you're connected, but the next launch opens signed out. (`update_settings` already handles this correctly through `write_settings`.)
- **Fix:** use `write_settings` and return the error.

### 12. Multi-step creates report success after partial failure
`src/actions.ts:247-268` (Duplicate Project), `src/links.ts:130` (`add-project` to-dos), `src/actions.ts:332-340` (Paste)
- Duplicate Project ignores the result of each child `createTask` and always toasts "Project duplicated". Paste stops at the first failure but still says "Pasted N", with no mention of the rest.
- **Fix:** count failures and say "Duplicated project — 3 to-dos couldn't be copied" (or similar).

### 13. Six commits and today's icon/dialog work exist only on this PC
`git` state
- The current branch has no upstream. Six commits (`8ea135f`…`81091f0`) aren't on any remote, and the icon set, `Dialogs.tsx` and `app.css` have uncommitted changes. There's also a second remote named `cairn` pointing at the old repo, which makes it easy to push to the wrong place.
- **Fix:** commit the work in progress and push the branch to `origin` (thing3thing). Consider renaming or removing the `cairn` remote.

### 14. The test suite fails on this machine
`src/calendar/calendar.test.tsx:90`, `:149` (and one more in the same file)
- 3 calendar panel tests hit the 5 s default timeout. Run alone, one still finishes at 5.1 s. The logic passes; the tests are just slow (heavy `userEvent` typing in jsdom). Until this is fixed, "run the tests" can't serve as a pass/fail gate.
- **Fix:** set `testTimeout: 15000` for that file (or globally in `vite.config.ts`). Use `userEvent.setup({ delay: null })`.

**Also still open from Oct 20, lower priority:** all history is replayed from SQLite on every launch (`engine.rs:140-146`). The event log and journal grow forever (T-P06), and long Logbooks render every row (T-P07).

---

## 2. Polish

| # | Where | What's rough | Suggestion |
|---|---|---|---|
| 1 | `src/components/Dialogs.tsx:133`, `:136` | Settings → Sync shows the raw enum ("idle") and developer jargon ("History index 1"). | "Up to date" / "Syncing…" / "Offline"; move History index into Copy diagnostics. |
| 2 | `Dialogs.tsx:135` | "10/29/2026, 7:38:27 AM" here vs "Saved 7:38 AM" in the sidebar. | One relative format everywhere ("Today, 7:38 AM"). |
| 3 | `Dialogs.tsx:~180-194` | In "On this PC" mode, Sync still shows two greyed Things Cloud toggles and a "Check for changes every" picker that does nothing. | Hide them unless the account is Cloud. |
| 4 | `src/components/NotesField.tsx:18-21` | Clicking an `http://` or `mailto:` link in notes copies it to the clipboard instead of opening it. | Open both through the shell (allow `http:` and `mailto:` in `open_in_browser`). |
| 5 | `src/components/QuickEntry.tsx:58-63`, `:83` | Escape in Quick Entry throws away what you typed (clicking away keeps it). | Keep the draft on Escape, clear it only after Save. Or ask first if notes are non-empty. |
| 6 | `src/App.tsx:402-409` | In Logbook and Trash the + button stays on screen, greyed out. | Hide it there. |
| 7 | Trash screen; `menus.tsx:370`, `:512` | Empty Trash is only in the ••• menus; the Trash page itself has no visible button. | A small "Empty Trash" button under the title, like Things. |
| 8 | Project and area pages | Two ••• buttons: one next to the title, one in the top-right corner. | Keep the title one; drop the corner one on these pages. |
| 9 | `src/styles/app.css:2592-2596` | The quick-action rail (`right: calc(100% + 6px)`) sits outside the row. In a narrow window it's cut off and shows as a white nub over the sidebar edge. | Put it inside the row on the right, shown on hover/selection. |
| 10 | `SidebarWidgets.tsx:57-60`, `app.css:454` | Week chart: days with 0 done show as full-height grey boxes, so they read as data. | Show empty days as a 2 px baseline. |
| 11 | `src/components/menus.tsx:144`, `:396`, `:442` | Context menu: "When" is the only item without its shortcut hint (Ctrl+S). | Add `shortcut: "Ctrl+S"`. |
| 12 | `src/components/LogbookFilters.tsx:121`, `:148`, `:154` | The Logbook filter bar mixes three control styles: native `<select>`s, segmented pills and a "Copy" text link. | Use the app's popover pickers for the selects so the row matches the tag filter chips. |
| 13 | `src/App.tsx:427` | New Heading saves the title untrimmed ("  Packing "). | `title.trim()`. |
| 14 | `src/lib/undo.ts:53` | Undoing a title change on a to-do that had no title sets it to "Untitled". | Allow an empty title in the inverse. |
| 15 | Light mode, top-right ••• | Solid black circle; much heavier than anything else in the toolbar. | Same ghost style as the calendar and search buttons. |

---

## 3. Feature ideas

Ideas marked **Beta** write to your Things data in a new way, or are experiments, so they should sit behind a "Beta features" toggle in Settings → General.

1. **Edit repeat rules.** Today the editor can only show a repeat ("New occurrences are created by Things on your iPhone") or stop it. Being able to change "every Monday" → "every weekday" closes the biggest gap with Things. **Beta** (writes to the hidden template).
2. **Drag a to-do onto the calendar panel** to set its When date for that day. The calendar is already open beside the list, so planning becomes one gesture. It only sets the to-do's date; no calendar events are written.
3. **Morning "Plan Today" sheet.** On the first open of the day, show overdue deadlines, yesterday's unfinished Today items and the next 2 days, with one-click Today/Evening/Someday. It uses data you already load. **Beta**
4. **Weekly Review.** Step through each project and area and flag "stalled" projects (no open, unscheduled to-dos) and stale Someday items. It's the natural next step after the sidebar Progress/Streak cards.
5. **Logbook insights.** Done per area/project per week, plus your busiest day. `lib/insights.ts` already computes week counts and streaks; this extends it to the Logbook filters you just built. **Beta**
6. **Saved filters / smart lists.** Pin a tag + area + "has deadline" combination to the sidebar, e.g. "Work · Important". It reuses the Logbook filter model.
7. **Offline queue.** Today an edit made offline is rejected (the pre-sync fails). Queue it, show "3 changes waiting", and send in order on reconnect, keeping the existing conflict check. **Beta** (new write path)
8. **Quick Entry routing:** "@Trip to Lisbon" or "@Work" picks the project or area, and "!fri" sets a deadline. `parseQuickEntry` already handles dates, times and #tags.
9. **Project templates.** "Save as template" on a project, then "New from template…" in the + menu. `duplicateProject` already copies headings, to-dos and checklists.
10. **Restore from a Drive snapshot, with a preview.** Pick a day's backup and see what would change (added/removed to-dos) before restoring. `drive_list` / `drive_download` / `restore_local` already exist.
11. **Mini Today window.** A small always-on-top Today list (like the Quick Entry window) that you can check off from the corner of the screen. **Beta**
12. **Tag manager.** Rename, merge, nest and set Alt-shortcut keys in one place. The data model already has `parentId` and `shortcut`, and Alt+key tag shortcuts already work.
13. **Export the Logbook** as Markdown or CSV for a date range, building on the existing "Copy" in the Logbook filter bar.

---

## 4. Design ideas

- **One radius and spacing system.** `app.css` uses **12 different border radii** (3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 999 px), even though `--r-box: 10px` and `--r-ctl: 6px` tokens exist (used only 23 times). Collapse them to four tokens: control 6, card 10, popover 12, pill 999. Do the same for padding: there are a dozen one-off pairs (`10px 12px`, `9px 14px`, `7px 8px`…), which could become a 4 px scale (`--s-1..--s-6`).
- **One button family.** There are currently `.btn`, `.btn.small`, `.sb-btn`, `.icon-btn`, `.chip`, `.seg` buttons, native `<select>`s and text links. Define three button styles (primary, quiet, ghost-icon) with a single height (28 px) and use them everywhere. The ••• buttons, Logbook filter bar and selection bar are the visible outliers.
- **One card.** Sidebar cards, the task editor, Settings sections and the Logbook filter bar each use their own shadow and border mix (44 `box-shadow` declarations). A single `--card` recipe (background, 1 px border, `--shadow-ctl`) would tie them together.
- **Dark mode.** It looks good overall. Two fixes: the week-chart empty days (grey blocks) are louder than the real bars, and the selected-row blue shows through the Settings backdrop. Make the modal scrim a little stronger in dark mode only.
- **Icon.** There are uncommitted changes to the icon set. The current mark (dark tile with a white check, inside a blue rounded square) loses its inner tile at 16–32 px: in the taskbar and favicon it reads as a blue blob with a speck. Make a simplified small-size variant (white check straight on blue, no inner tile) for `32x32.png`, `favicon.png` and the 16/24/32 layers of `icon.ico`.
- **Motion.** There are 27 transitions/animations with a proper reduced-motion guard, but durations vary. Add `--dur-fast: 120ms` and `--dur: 180ms` tokens. Two motions would make it feel more like Things: the checkbox fill followed by a short delay before the row slides out, and rows animating to their new place after a drag or Ctrl+↑/↓ (a FLIP animation).
- **Layouts that look dated.**
  - The **Settings** dialog is a centred modal with a segmented tab strip and a two-column status grid. A left-hand section list (Account / Sync / Backups / General / About) in a wider sheet would look more current and give the Sync and Drive pages room.
  - The **Logbook filter bar** (native dropdowns) is the one screen that looks like a web form rather than Things.
  - In the **narrow layout**, the icon-only sidebar has no labels for areas and projects (they're identical cube and circle icons). Hover tooltips with the name, or the first letter in the icon, would fix this.

---

## Built on 2026-10-29 (branch `fix/audit-2026-10-29`)

Sections 1 and 2 were built. Before any change, a backup was saved to `../thing3thing-backups/2026-10-29-pre-build/`: app data, settings, the installed exe, a repo bundle and the uncommitted work as a patch.

**Fix next**

| # | Status | Notes |
|---|---|---|
| 1 Undo | Done | Undo/redo are tied to the revision our own write produced, so later changes from another device show the Conflict dialog. Steps stay on the stack until they fully succeed. Undoing a completed project reopens its to-dos. |
| 2 Quit | Done | The tray Quit asks the UI to save an open editor (`quit_ready`), then waits up to 20 s for any write in flight before exiting. |
| 3 Stuck "sending" | Done | A local failure after a confirmed commit marks the entry *uncertain*, so the next sync confirms it. |
| 4 Reminders | Done | The reminder window only moves forward once it was actually checked. |
| 5 Draft text | Done | The text is kept when saving fails. Shift+Enter rapid entry still clears right away and puts the text back if that save fails. |
| 6 Polling | Done | Polls with nothing new only refresh the status line. `dataRev` lets the UI keep its lists, and Drive backups skip unchanged data again. |
| 7 Bulk speed | Partly | Things Cloud's handling of a stale ancestor is undocumented, so every write still syncs first, *except* a write that comes within 2 s of our own confirmed commit. That's the same gap as the normal sync-then-commit (throttled to 1/s), and it roughly halves the requests for bulk edits. Batching into one commit wasn't done. |
| 8 Bulk Undo toast | Done | Restores each to-do's previous status. |
| 9 Links | Done | Capped at 100. Links adding more than 5 ask first with an "Add them" button. |
| 10 Disconnect | Done | Credentials are removed first. Leftover cache files are reported. |
| 11 Settings save | Done | Connect / Start fresh write `settings.json` before reporting success. |
| 12 Partial failures | Done | Duplicate Project, Paste and `add-project` links report what didn't get added. |
| 13 Unpushed work | **Waiting for you** | Not committed or pushed without your OK. |
| 14 Slow tests | Done | `testTimeout: 15000`; calendar tests type with no delay. |

Also fixed while in there: editing notes and then the title in the same open editor no longer raises a conflict with your own first save.

**Polish:** all 15 done, with two adjustments. #12 uses chip buttons that open the app's own menu, not separate popover pickers. #14: the backend rejects empty titles, so undo now leaves a to-do that had no title alone instead of naming it "Untitled". #15: the corner ••• was already a light ghost button in light mode. The black circle in the first screenshot was a theme flash in the preview, and it's gone now that project, area and tag pages have a single •••.

**Tests:** 89 frontend tests (12 new in `src/auditFixes.test.tsx`) and all Rust suites pass, including a new `back_to_back_writes_land_in_order`.

**Install (important):** Claude runs inside a Windows app package, so files it writes under `AppData` are silently redirected into `AppData\Local\Packages\Claude_…\LocalCache`. Earlier sessions "installed" builds into that hidden copy. As a result, the real `AppData\Local\Things 3` had **no `tings3.exe`** (the Start-menu shortcut was broken), while things:/// links and the jump list ran the hidden copy against your real data. This time the new `tings3.exe` was copied through `\localhost\C$\…` into **both** the real install folder and the hidden copy (old exe kept as `tings3.previous-20261029.exe`), then started from the real folder. On first run it re-registers things:/// and the jump list with the real path.

**Data check:** the real data (`AppData\Local\app.tings3.desktop`) was backed up first to `../thing3thing-backups/2026-10-29-pre-build/REAL-localdata`. After the install and first launch: all 851 history events identical (SHA-256 match), journal unchanged (268, so nothing was sent), write policy unchanged, `settings.json` byte-identical.
