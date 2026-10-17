# Tings 3 architecture

Tings 3 is a Windows desktop task manager in the style of Things 3 that reads and
(optionally) writes your Things Cloud data, so it stays in sync with Things on
iPhone. It is built with Tauri 2 (Rust) and React + TypeScript.

See [THINGS_CLOUD_RESEARCH.md](THINGS_CLOUD_RESEARCH.md) for the protocol and
the security review that shaped these decisions.

## Decision: an embedded local connector, not the MCP

| Option | Verdict |
|---|---|
| Use the hosted MCP (`thingscloudmcp.com`) | Rejected. Sends the Things password to a third party; MCP is designed for LLM tool calls, not a UI that needs the full graph, cursors and change events. |
| Run the Go MCP as a local sidecar | Rejected. Adds a second runtime, an HTTP server on localhost that anyone on the machine could call, and OAuth/session code we don't need. |
| **Port the protocol to a Rust crate inside the app** | **Chosen.** One process; credentials stay in memory of one binary; the connector is a plain library we can unit-test against a fake server; no listening sockets. |

The Rust port follows the MCP/SDK field-for-field (it is the only payload shape
known not to crash Things.app) and keeps its safety properties (schema fail-closed,
uncertain-write reconciliation, no automatic retry).

## Layers

```
┌──────────────────────── React UI (src/) ────────────────────────┐
│ Sidebar · lists · task editor · quick entry window · settings   │
│ zustand store ── selectors (Inbox/Today/Upcoming/…)             │
│ Backend interface ──┬── MockBackend (browser dev, tests)        │
│                     └── TauriBackend (invoke + events)          │
└─────────────────────────────┬───────────────────────────────────┘
                              │ Tauri IPC (commands / "snapshot" events)
┌──────────── src-tauri (app shell, Windows integration) ─────────┐
│ commands · tray · global shortcut · notifications · autostart  │
│ single instance · credential store (Windows Credential Manager)│
└─────────────────────────────┬───────────────────────────────────┘
                              │
┌──────────── crates/things-sync (no Tauri dependency) ───────────┐
│ SyncEngine: cursor, polling, snapshot, write pipeline           │
│ WritePolicy (read-only / writes / destructive)                  │
│ Write journal + reconciliation · field-level conflict detection │
│ Cache (SQLite: raw event log, cursor, journal)                  │
│ Mutation → wire items (the only place payloads are built)       │
└─────────────────────────────┬───────────────────────────────────┘
                              │ Transport trait
┌──────────── crates/things-cloud (protocol connector) ───────────┐
│ ids (Base58) · wire types · notes · recurrence · state replay   │
│ HttpTransport (reqwest, rustls, 1 req/s) · FakeCloud (tests/demo)│
│ things-cloud-cli: read-only diagnostic tool                     │
└──────────────────────────────────────────────────────────────────┘
```

### crates/things-cloud

* `Transport` trait: `verify`, `history_head`, `items(start)`, `commit(ancestor, items)`.
* `HttpTransport`: real Things Cloud. Classifies commit failures:
  * connection never established → `Rejected` (definitely not applied);
  * HTTP 4xx → `Rejected`;
  * timeout / connection lost after sending / HTTP 5xx / unparseable or
    unexpected `server-head-index` → **`Uncertain`**.
* `FakeCloud`: in-memory Things Cloud with the same semantics (append-only
  history, ancestor index, schema). Used by tests, by the demo account, and to
  simulate "edits from the iPhone" and network failures.
* `State`: replays events into tasks/projects/headings/areas/tags/checklists.
  Tracks, per entity and per wire field, the server index that last changed it
  (used for conflict detection). Handles tombstones, `t=2` deletes, legacy ids,
  note patches and explicit null clears.

### crates/things-sync

* **Cache** — SQLite in `%LOCALAPPDATA%\Tings 3\cache-<account-hash>.sqlite`:
  `events(idx, uuid, kind, action, payload)`, `meta(cursor, schema)`,
  `journal(...)`. On launch the state is rebuilt from the local event log, so the
  app opens instantly and works offline; a sync then pulls only the delta.
  Cursor advances only after a page has been decoded and applied (atomic
  transaction).
* **Write policy** — three levels, persisted locally:
  1. *Read-only* (default for every new account);
  2. *Writes enabled* — needs an explicit opt-in dialog that explains the risks;
  3. *Destructive enabled* — permanent deletion / stopping recurrence; separate
     opt-in, plus typed confirmation per operation.
* **Write pipeline** (serialised; one at a time):
  1. Refuse if policy forbids it or an unresolved uncertain write exists.
  2. Pull the delta (pre-write sync).
  3. Conflict check: the UI sends `baseRev` (the entity revision it showed the
     user). If any field we are about to write was changed remotely after
     `baseRev`, return `Conflict` with the remote version. Non-overlapping
     changes merge automatically.
  4. Build wire items; validate ids and invariants; record in the journal as
     `sending`.
  5. Commit once. `Ok` → apply locally, journal `committed`. `Rejected` →
     journal `rejected`, surface error (user may retry by hand). `Uncertain`
     → journal `uncertain`, **no retry**; reconcile by pulling and looking for
     our exact events (same id, kind, action and our unique `md` timestamp).
     Until reconciled or dismissed by the user, further writes are blocked.
  6. A `sending` entry found at startup (crash mid-commit) is treated as
     `uncertain`.
* **SyncEngine** — background thread; polls every 30 s while visible and every
  2 min in the tray; exponential back-off on errors and `429`; emits a fresh
  snapshot after every change. Reads are safe to retry; writes are not.

### src-tauri

* Commands: `get_snapshot`, `sync_now`, `apply_mutation`, `connect_account`,
  `disconnect_account`, `set_write_policy`, `resolve_uncertain`, settings.
* Credentials: `keyring` crate → **Windows Credential Manager** (DPAPI-protected,
  per Windows user). Stores email, password and history key. Nothing secret is
  written to SQLite, settings, logs or the frontend; the UI only learns the email.
* Tray (show, quick entry, sync now, quit; close-to-tray), global shortcut
  (default `Ctrl+Alt+Space`, configurable) opening a small always-on-top quick
  entry window, Windows toast notifications for reminders and sync problems,
  optional launch at login, single instance.

### UI

* Frontend never builds wire payloads; it sends semantic `Mutation`s.
* The same TypeScript `applyMutation` reducer powers the mock backend and the
  optimistic overlay shown while a write is in flight; the authoritative
  snapshot from Rust replaces it when the write resolves.
* List semantics (Things 3): Inbox `st=0`; Today = open, `st∈{1,2}` and start
  date ≤ today (This Evening when `sb=1`); Upcoming = `st=2` with future date;
  Anytime = `st=1` (includes Today); Someday = `st=2` without date; Logbook =
  completed/canceled; Trash = `tr`. Recurring templates are hidden; instances
  show a repeat badge with a readable rule.

## Modes

| Mode | Data | Writes |
|---|---|---|
| Demo (first launch) | FakeCloud seeded with sample data, in Rust | Allowed (nothing leaves the PC) |
| Connected, read-only (default) | Things Cloud | Blocked; UI shows a lock |
| Connected, writes enabled | Things Cloud | After opt-in |

## Testing strategy

* `things-cloud`: unit tests for ids, notes, recurrence, state replay;
  `HttpTransport` tests against a local mock HTTP server (paths, headers,
  error classification, redaction).
* `things-sync`: engine tests on `FakeCloud` — cursor safety, conflicts,
  uncertain-write reconciliation, journal recovery after crash, policy gates,
  payload golden tests mirroring the MCP.
* Frontend: Vitest for selectors, date logic, quick-entry parsing, reducer.
* CI: GitHub Actions on `windows-latest` builds NSIS + MSI installers and runs
  all tests; no secrets are configured or needed.
* Live Things Cloud: **only** by hand, with a disposable account, via
  `things-cloud-cli` (read-only) and the app. See TESTING.md.
