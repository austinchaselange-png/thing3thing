import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getBackend } from "../backend";
import { todayYmd } from "../lib/dates";
import { getThemePref, setThemePref, type ThemePref } from "../lib/theme";
import { belongsTo, buildIndex, search } from "../lib/lists";
import { isWriteError, useStore } from "../store";
import type { Issue, ListId, Selection, Settings, Task } from "../types";
import { AreaIcon, CloseIcon, LIST_META, LockIcon, ProgressPie, SearchIcon, TagIcon, WarningIcon } from "./Icons";

export function Modal({ title, onClose, children, width = 480, footer }: { title: string; onClose: () => void; children: ReactNode; width?: number; footer?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), onClose());
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <div className="modal-layer" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width }} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

const close = () => useStore.getState().openDialog(null);

async function run<T>(fn: () => Promise<T>, okText?: string): Promise<T | null> {
  try {
    const r = await fn();
    if (okText) useStore.getState().toast(okText, "success");
    return r;
  } catch (e) {
    useStore.getState().toast(isWriteError(e) ? e.message : String(e), "error");
    return null;
  }
}

function Toggle({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  return (
    <label className={`toggle-row${disabled ? " disabled" : ""}`}>
      <span>
        <span className="toggle-label">{label}</span>
        {hint && <small>{hint}</small>}
      </span>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

function AccountTab() {
  const app = useStore((s) => s.app)!;
  const backend = getBackend();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [forget, setForget] = useState(true);
  const connect = async () => {
    setBusy(true);
    const ok = await run(() => backend.connect(email.trim(), password), "Connected to Things Cloud (read-only).");
    setBusy(false);
    setPassword("");
    if (ok !== null) close();
  };
  if (app.account.mode === "cloud")
    return (
      <div className="settings-section">
        <p>
          Connected as <strong>{app.account.email}</strong>.
        </p>
        <p className="muted">Your password and Things Cloud history key are stored in Windows Credential Manager, protected by your Windows sign-in. They never leave this PC except to cloud.culturedcode.com.</p>
        <label className="check-row">
          <input type="checkbox" checked={forget} onChange={(e) => setForget(e.target.checked)} /> Also delete the local copy of my to-dos
        </label>
        <button className="btn danger" onClick={() => void run(() => backend.disconnect(forget), "Disconnected.")}>
          Disconnect
        </button>
      </div>
    );
  return (
    <div className="settings-section">
      {app.account.mode === "demo" && <div className="callout">Your to-dos are stored only on this PC. Nothing is sent anywhere.</div>}
      <h3>Connect Things Cloud</h3>
      <p className="muted">Use the email and password of the Things Cloud account your iPhone syncs with. Things 3 starts in <strong>read-only</strong> mode; you can enable writing later.</p>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void connect();
        }}
      >
        <label>
          Email
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Password
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        <button className="btn primary" disabled={busy || !email || !password}>
          {busy ? "Connecting…" : "Connect read-only"}
        </button>
      </form>
      <p className="fine">
        Things Cloud has no official API. Things 3 uses a reverse-engineered protocol that may change or break. See Settings → About.
      </p>
      {app.account.mode !== "demo" && (
        <button className="btn" onClick={() => void run(() => backend.useDemo())}>
          Keep to-dos on this PC instead
        </button>
      )}
    </div>
  );
}

function SyncTab() {
  const app = useStore((s) => s.app)!;
  const openDialog = useStore((s) => s.openDialog);
  const backend = getBackend();
  const { policy, sync, account } = app;
  const cloud = account.mode === "cloud";
  return (
    <div className="settings-section">
      <div className="status-grid">
        <span>Status</span>
        <span>{sync.phase}</span>
        <span>Last sync</span>
        <span>{sync.lastSyncedAt ? new Date(sync.lastSyncedAt).toLocaleString() : "never"}</span>
        <span>History index</span>
        <span>{app.snapshot.serverIndex}</span>
        {sync.lastError && (
          <>
            <span>Last error</span>
            <span className="error-text">{sync.lastError}</span>
          </>
        )}
      </div>
      <button className="btn" onClick={() => void run(() => backend.syncNow())} disabled={account.mode === "signedOut"}>
        Sync now
      </button>
      <button className="btn" onClick={() => void copyDiagnostics()}>
        Copy diagnostics
      </button>
      {(app.format.newerKinds.length > 0 || app.format.problems.length > 0) && (
        <>
          <h3>Data format</h3>
          <div className="callout warn-callout">
            {app.format.writesSupported ? (
              <p>
                Your Things apps now save to-dos in a newer format: <strong>{app.format.newerKinds.map((k) => `${k.kind} (${k.count})`).join(", ")}</strong>. Every
                item seen so far uses only fields Things 3 understands, so changes are saved in that same format.{" "}
                <strong>This is experimental:</strong> the new format hasn't been officially documented or verified. If anything unfamiliar shows up, Things 3
                turns changes off again automatically.
              </p>
            ) : (
              <p>
                Things Cloud sent some data Things 3 doesn't fully understand yet. <strong>Syncing from your iPhone keeps working</strong>; Things 3 reads
                everything it can and skips the rest. To protect your account, <strong>changes are turned off</strong> until this is supported, even if writing is
                allowed below.
              </p>
            )}
            {app.format.problems.length > 0 && (
              <ul className="fine problem-list">
                {app.format.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
      <h3>Writing to Things Cloud</h3>
      <Toggle
        label="Allow changes to be saved to Things Cloud"
        hint={cloud ? "Off by default. Edits will appear on your iPhone." : "To-dos stored on this PC are always editable."}
        checked={policy.writes}
        disabled={!cloud}
        onChange={(v) => (v ? openDialog({ kind: "writeOptIn" }) : void run(() => backend.setPolicy({ writes: false, destructive: false })))}
      />
      <Toggle
        label="Allow permanent deletions"
        hint="Deleting areas, tags and checklist items, and stopping repeats. Moving to Trash is always reversible and does not need this."
        checked={policy.destructive}
        disabled={!cloud || !policy.writes}
        onChange={(v) => (v ? openDialog({ kind: "destructiveOptIn" }) : void run(() => backend.setPolicy({ writes: policy.writes, destructive: false })))}
      />
      <PollSetting />
      {account.mode === "demo" && import.meta.env.DEV && (
        <>
          <h3>Testing</h3>
          <p className="muted">Pretend Things on your iPhone changed a to-do. Edit the same to-do here afterwards to see conflict handling.</p>
          <button className="btn" onClick={() => void run(async () => useStore.getState().toast(`Edited on “iPhone”: ${await backend.simulateRemoteEdit()}`))}>
            Simulate iPhone edit
          </button>
        </>
      )}
      {app.recentWrites.length > 0 && (
        <>
          <h3>Recent changes</h3>
          <ul className="journal">
            {app.recentWrites.map((w) => (
              <li key={w.id} className={`journal-${w.status}`}>
                <span className="journal-status">{w.status}</span> {w.summary}
                <small>{new Date(w.createdAt * 1000).toLocaleString()}</small>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function PollSetting() {
  const settings = useStore((s) => s.app!.settings);
  return (
    <label className="select-row">
      Check for changes every
      <select value={settings.pollSeconds} onChange={(e) => void run(() => getBackend().updateSettings({ pollSeconds: Number(e.target.value) }))}>
        {[30, 60, 120, 300, 900].map((s) => (
          <option key={s} value={s}>
            {s < 60 ? `${s} seconds` : `${s / 60} minute${s === 60 ? "" : "s"}`}
          </option>
        ))}
      </select>
    </label>
  );
}

function ShortcutInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [capturing, setCapturing] = useState(false);
  return (
    <button
      className={`shortcut-input${capturing ? " capturing" : ""}`}
      onClick={() => setCapturing(true)}
      onBlur={() => setCapturing(false)}
      onKeyDown={(e) => {
        if (!capturing) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Escape") return setCapturing(false);
        if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
        const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super"].filter(Boolean);
        if (!mods.length) return;
        const key = e.code.startsWith("Key") ? e.code.slice(3) : e.code.startsWith("Digit") ? e.code.slice(5) : e.code;
        onChange([...mods, key].join("+"));
        setCapturing(false);
      }}
    >
      {capturing ? "Press a shortcut…" : value}
    </button>
  );
}

function GeneralTab() {
  const app = useStore((s) => s.app)!;
  const s = app.settings;
  const update = (patch: Partial<Settings>) => void run(() => getBackend().updateSettings(patch));
  return (
    <div className="settings-section">
      <AppearanceRow />
      <label className="select-row">
        Quick Entry shortcut
        <ShortcutInput value={s.quickEntryShortcut} onChange={(v) => update({ quickEntryShortcut: v })} />
      </label>
      <Toggle label="Launch at Windows sign-in" checked={s.launchAtLogin} onChange={(v) => update({ launchAtLogin: v })} />
      <Toggle label="Keep running in the system tray when closed" checked={s.closeToTray} onChange={(v) => update({ closeToTray: v })} />
      <Toggle label="Reminder notifications" hint="Shown by Windows at the reminder time while Things 3 is running." checked={s.notifications} onChange={(v) => update({ notifications: v })} />
      <Toggle
        label="Translucent sidebar (Mica)"
        hint={app.platform.micaAvailable ? "Windows 11 only. Takes effect after restarting Things 3." : "Requires Windows 11."}
        checked={s.mica}
        disabled={!app.platform.micaAvailable}
        onChange={(v) => update({ mica: v })}
      />
    </div>
  );
}

function AppearanceRow() {
  const [pref, setPref] = useState<ThemePref>(getThemePref);
  const opts: [ThemePref, string][] = [
    ["system", "System"],
    ["light", "Light"],
    ["dark", "Dark"],
  ];
  return (
    <div className="select-row">
      Appearance
      <div className="seg" role="radiogroup" aria-label="Appearance">
        {opts.map(([id, label]) => (
          <button
            key={id}
            role="radio"
            aria-checked={pref === id}
            className={pref === id ? "active" : ""}
            onClick={() => {
              setThemePref(id);
              setPref(id);
            }}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

function AboutTab() {
  const app = useStore((s) => s.app)!;
  return (
    <div className="settings-section about">
      <p>
        <strong>Things 3</strong> {app.platform.version} — an unofficial, personal Windows client for Things. Not affiliated with Cultured Code.
      </p>
      <h3>Risks of the unofficial protocol</h3>
      <ul>
        <li>Things Cloud has no public API. The protocol was reverse-engineered by the open-source things-cloud-sdk and things-cloud-mcp projects and can change without notice.</li>
        <li>A malformed write can make Things on your iPhone crash while syncing, and such a write cannot be undone from the server. Things 3 builds every write with validated, tested payloads, but test on a disposable account first.</li>
        <li>If a write's outcome is unknown (connection dropped), Things 3 never resends it automatically. It checks Things Cloud and asks you.</li>
        <li>Cultured Code may rate-limit or block unofficial clients. Things 3 limits itself to one request per second.</li>
        <li>New occurrences of repeating to-dos are created by the official Things apps, not by Things 3.</li>
      </ul>
    </div>
  );
}

export function SettingsDialog({ tab: initial }: { tab?: "account" | "sync" | "general" | "about" }) {
  const [tab, setTab] = useState(initial ?? "account");
  const tabs = [
    ["account", "Account"],
    ["sync", "Sync"],
    ["general", "General"],
    ["about", "About"],
  ] as const;
  return (
    <Modal title="Settings" onClose={close} width={560}>
      <div className="tabs seg" role="tablist">
        {tabs.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={`tab${tab === id ? " active" : ""}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === "account" && <AccountTab />}
      {tab === "sync" && <SyncTab />}
      {tab === "general" && <GeneralTab />}
      {tab === "about" && <AboutTab />}
    </Modal>
  );
}

export function WriteOptInDialog({ destructive }: { destructive?: boolean }) {
  const policy = useStore((s) => s.app!.policy);
  const [ack, setAck] = useState(false);
  const [phrase, setPhrase] = useState("");
  const ok = ack && (!destructive || phrase === "DELETE");
  const enable = async () => {
    const r = await run(() => getBackend().setPolicy(destructive ? { writes: true, destructive: true } : { writes: true, destructive: policy.destructive }), destructive ? "Permanent deletions enabled." : "Writes enabled.");
    if (r !== null) close();
  };
  return (
    <Modal
      title={destructive ? "Allow permanent deletions?" : "Allow Things 3 to change your Things data?"}
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className={`btn ${destructive ? "danger" : "primary"}`} disabled={!ok} onClick={() => void enable()}>
            {destructive ? "Allow deletions" : "Enable writes"}
          </button>
        </>
      }
    >
      <div className="optin">
        <WarningIcon size={28} style={{ color: "var(--c-warn)" }} />
        {destructive ? (
          <ul>
            <li>Permanent deletions cannot be undone — not from Trash, not from your iPhone.</li>
            <li>Each deletion will still ask you to type DELETE.</li>
            <li>Only enable this after testing on a disposable Things Cloud account.</li>
          </ul>
        ) : (
          <ul>
            <li>Changes you make here will be sent to Things Cloud and appear on your iPhone.</li>
            <li>This uses an unofficial, reverse-engineered protocol. A bad write could make Things on iPhone crash while syncing, and might not be reversible.</li>
            <li>We strongly recommend trying writes on a <strong>disposable Things Cloud account</strong> first.</li>
            <li>If a change's outcome is uncertain, Things 3 will never resend it automatically.</li>
          </ul>
        )}
      </div>
      <label className="check-row">
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I understand the risks.
      </label>
      {destructive && (
        <label className="form">
          Type DELETE to confirm
          <input value={phrase} onChange={(e) => setPhrase(e.target.value)} aria-label="Confirmation phrase" />
        </label>
      )}
    </Modal>
  );
}

export function ConflictDialog({ mutation, fields }: { mutation: Parameters<ReturnType<typeof useStore.getState>["apply"]>[0]; fields: string[] }) {
  const apply = useStore((s) => s.apply);
  const id = "id" in mutation ? mutation.id : null;
  const current = useStore((s) => (id ? (s.view?.tasks.find((t) => t.id === id) ?? null) : null));
  return (
    <Modal
      title="Changed on another device"
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={close}>
            Keep their version
          </button>
          <button
            className="btn primary"
            onClick={() => {
              close();
              void apply(mutation, { force: true });
            }}
          >
            Use my change
          </button>
        </>
      }
    >
      <p>
        While you were editing, the <strong>{fields.join(", ")}</strong> of this item changed in Things Cloud (probably on your iPhone).
      </p>
      {current && (
        <div className="conflict-box">
          <div className="muted">Current version</div>
          <div className="conflict-title">{current.title}</div>
          {current.notes && <div className="conflict-notes">{current.notes}</div>}
        </div>
      )}
      <p className="muted">Other changes that didn't overlap were already merged.</p>
    </Modal>
  );
}

export function ConfirmDialog({ title, body, mutation, phrase }: { title: string; body: string; mutation: Parameters<ReturnType<typeof useStore.getState>["apply"]>[0]; phrase: boolean }) {
  const apply = useStore((s) => s.apply);
  const [text, setText] = useState("");
  const ok = !phrase || text === "DELETE";
  return (
    <Modal
      title={title}
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button
            className="btn danger"
            disabled={!ok}
            onClick={() => {
              close();
              void apply("confirm" in mutation ? { ...mutation, confirm: text } : mutation);
            }}
          >
            Delete permanently
          </button>
        </>
      }
    >
      <p>{body}</p>
      {phrase && (
        <label className="form">
          Type DELETE to confirm
          <input autoFocus value={text} onChange={(e) => setText(e.target.value)} aria-label="Confirmation phrase" />
        </label>
      )}
    </Modal>
  );
}

const SHORTCUTS: [string, [string, string][]][] = [
  ["Create", [["New to-do", "Ctrl+N"], ["Quick Entry (from any app)", "Ctrl+Alt+Space"], ["Duplicate to-do", "Ctrl+D"]]],
  ["Selected to-do", [["Edit / open", "Enter"], ["Complete", "Ctrl+K"], ["Context menu", "Shift+F10"], ["Move to Trash", "Delete"]]],
  ["When", [["Today", "Ctrl+T"], ["This Evening", "Ctrl+E"], ["Anytime", "Ctrl+R"], ["Someday", "Ctrl+O"], ["Choose date…", "Ctrl+S"]]],
  ["Organise", [["Move…", "Ctrl+Shift+M"], ["Tags…", "Ctrl+Shift+T"], ["Deadline…", "Ctrl+Shift+D"]]],
  ["Navigate", [["Inbox … Trash", "Ctrl+1 … 7"], ["Previous / next to-do", "↑ / ↓"], ["Quick Find", "Ctrl+F"], ["Sync now", "F5"], ["Settings", "Ctrl+,"], ["This list", "Ctrl+/"]]],
];

export function ShortcutsDialog() {
  return (
    <Modal title="Keyboard Shortcuts" onClose={close} width={560}>
      <div className="shortcut-grid">
        {SHORTCUTS.map(([group, rows]) => (
          <section key={group}>
            <h3>{group}</h3>
            {rows.map(([label, keys]) => (
              <div className="shortcut-row" key={label}>
                <span>{label}</span>
                <kbd className="keycap">{keys}</kbd>
              </div>
            ))}
          </section>
        ))}
      </div>
      <p className="fine">Right-click any to-do, project, area, tag or list for more actions.</p>
    </Modal>
  );
}

export function PromptDialog({ title, label, initial, confirmLabel, onSubmit }: { title: string; label: string; initial: string; confirmLabel: string; onSubmit: (v: string) => void }) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const submit = () => {
    if (!value.trim()) return;
    close();
    onSubmit(value.trim());
  };
  return (
    <Modal
      title={title}
      onClose={close}
      width={400}
      footer={
        <>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" disabled={!value.trim()} onClick={submit}>
            {confirmLabel}
          </button>
        </>
      }
    >
      <label className="form">
        {label}
        <input ref={inputRef} value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), submit())} aria-label={label} />
      </label>
    </Modal>
  );
}

export function IssueDialog({ issue }: { issue: Issue }) {
  const backend = getBackend();
  const live = useStore((s) => s.app?.issues.find((i) => i.id === issue.id)) ?? issue;
  const resolved = !useStore((s) => s.app?.issues.some((i) => i.id === issue.id));
  return (
    <Modal
      title="A change needs your attention"
      onClose={close}
      footer={
        resolved ? (
          <button className="btn primary" onClick={close}>
            Done
          </button>
        ) : (
          <>
            <button className="btn" onClick={() => void run(() => backend.syncNow())}>
              Check again
            </button>
            <button className="btn" onClick={() => void run(() => backend.dismissIssue(issue.id), "Dismissed.").then(close)}>
              Dismiss
            </button>
            {live.status === "missing" && (
              <button className="btn primary" onClick={() => void run(() => backend.reapplyIssue(issue.id), "Applied again.").then(close)}>
                Apply again
              </button>
            )}
          </>
        )
      }
    >
      <p>
        <strong>{live.summary}</strong>
      </p>
      {resolved ? (
        <p>This change has been resolved.</p>
      ) : live.status === "missing" ? (
        <p>The connection failed while saving, and the change does not appear in Things Cloud. It was most likely not saved. Check your iPhone, then apply it again or dismiss it.</p>
      ) : (
        <p>The connection failed while saving, so Things 3 can't tell whether Things Cloud received it. To avoid creating duplicates, it won't resend automatically. Things 3 will check again on the next sync.</p>
      )}
      {live.detail && <p className="fine">Details: {live.detail}</p>}
      <p className="fine">Other changes are paused until this is resolved.</p>
    </Modal>
  );
}

type FindResult = { key: string; label: string; icon: ReactNode; sub?: string; go: () => void };

export function QuickFind() {
  const view = useStore((s) => s.view)!;
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const ix = useMemo(() => buildIndex(view), [view]);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);
  const goTask = (t: Task) => {
    const s = useStore.getState();
    const today = todayYmd();
    let sel: Selection = { kind: "list", id: "anytime" };
    if (t.type === "project") sel = { kind: "project", id: t.id };
    else if (t.projectId) sel = { kind: "project", id: t.projectId };
    else {
      const lists: ListId[] = ["inbox", "today", "upcoming", "anytime", "someday", "logbook", "trash"];
      const found = lists.find((l) => belongsTo(l, t, ix, today));
      if (found) sel = { kind: "list", id: found };
      else if (t.areaId) sel = { kind: "area", id: t.areaId };
    }
    s.select(sel);
    if (t.type !== "project") s.selectTask(t.id);
  };
  const results: FindResult[] = useMemo(() => {
    const ql = q.trim().toLowerCase();
    if (!ql) return [];
    const out: FindResult[] = [];
    for (const [id, m] of Object.entries(LIST_META)) {
      if (m.title.toLowerCase().startsWith(ql)) out.push({ key: id, label: m.title, icon: <m.Icon style={{ color: m.color }} />, go: () => useStore.getState().select({ kind: "list", id: id as ListId }) });
    }
    for (const a of view.areas) if (a.title.toLowerCase().includes(ql)) out.push({ key: a.id, label: a.title, icon: <AreaIcon />, go: () => useStore.getState().select({ kind: "area", id: a.id }) });
    for (const t of view.tags) if (t.title.toLowerCase().includes(ql)) out.push({ key: t.id, label: t.title, icon: <TagIcon />, sub: "Tag", go: () => useStore.getState().select({ kind: "tag", id: t.id }) });
    for (const t of search(q, view, ix)) {
      const project = t.projectId ? ix.byId.get(t.projectId)?.title : undefined;
      out.push({
        key: t.id,
        label: t.title,
        icon: t.type === "project" ? <ProgressPie done={0} total={1} color="var(--c-project)" /> : <span className={`mini-check${t.status !== "open" ? " done" : ""}`} />,
        sub: project ?? (t.areaId ? ix.areas.get(t.areaId)?.title : undefined),
        go: () => goTask(t),
      });
    }
    return out.slice(0, 40);
  }, [q, view, ix]);
  const choose = (r: FindResult | undefined) => {
    if (!r) return;
    close();
    r.go();
  };
  return (
    <div className="modal-layer top" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="quick-find" role="dialog" aria-label="Quick Find">
        <div className="qf-input">
          <SearchIcon />
          <input
            ref={inputRef}
            value={q}
            placeholder="Quick Find"
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") close();
              if (e.key === "ArrowDown") (e.preventDefault(), setActive((a) => Math.min(a + 1, results.length - 1)));
              if (e.key === "ArrowUp") (e.preventDefault(), setActive((a) => Math.max(a - 1, 0)));
              if (e.key === "Enter") choose(results[active]);
            }}
          />
        </div>
        {results.length > 0 && (
          <div className="qf-results" role="listbox">
            {results.map((r, i) => (
              <button key={r.key} className={`qf-item${i === active ? " active" : ""}`} onMouseEnter={() => setActive(i)} onClick={() => choose(r)} role="option" aria-selected={i === active}>
                {r.icon}
                <span className="grow">{r.label}</span>
                {r.sub && <small>{r.sub}</small>}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`}>
          <span>{t.text}</span>
          {t.action && (
            <button
              className="link-btn"
              onClick={() => {
                dismiss(t.id);
                t.action!.run();
              }}
            >
              {t.action.label}
            </button>
          )}
          <button className="icon-btn tiny" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            <CloseIcon size={10} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function IssueBanner() {
  const issues = useStore((s) => s.app?.issues);
  const openDialog = useStore((s) => s.openDialog);
  if (!issues?.length) return null;
  const i = issues[0];
  return (
    <div className="issue-banner" role="alert">
      <WarningIcon />
      <span>
        {i.status === "missing" ? "A change was probably not saved: " : "A change may not have been saved: "}
        <strong>{i.summary}</strong>
      </span>
      <button className="btn small" onClick={() => openDialog({ kind: "issue", issue: i })}>
        Review
      </button>
    </div>
  );
}

/** Copies a support summary (no credentials, no to-do content) to the clipboard. */
export async function copyDiagnostics() {
  const app = useStore.getState().app;
  if (!app) return;
  const lines = [
    `Things 3 ${app.platform.version} (${app.platform.os})`,
    `Account: ${app.account.mode}`,
    `Sync: ${app.sync.phase}${app.sync.lastSyncedAt ? `, last synced ${new Date(app.sync.lastSyncedAt).toISOString()}` : ", never synced"}`,
    `Last error: ${app.sync.lastError ?? "none"}`,
    `History index: ${app.snapshot.serverIndex}; server schema: ${app.format.serverSchema ?? "unknown"}`,
    `Writes: allowed=${app.policy.writes}, possible=${app.canWrite}`,
    `Newer kinds: ${app.format.newerKinds.map((k) => `${k.kind}×${k.count}`).join(", ") || "none"}`,
    `Format problems: ${app.format.problems.join("; ") || "none"}`,
    `Open issues: ${app.issues.map((i) => `${i.status}: ${i.detail ?? ""}`).join("; ") || "none"}`,
  ];
  try {
    await navigator.clipboard.writeText(lines.join("\n"));
    useStore.getState().toast("Diagnostics copied. They contain no password or to-do text.", "success");
  } catch {
    useStore.getState().toast("Could not copy to the clipboard.", "error");
  }
}

/** A sync failure is shown in the window, not only in Settings. */
export function SyncErrorBanner() {
  const app = useStore((s) => s.app);
  const openDialog = useStore((s) => s.openDialog);
  if (!app || app.account.mode === "signedOut" || app.sync.phase !== "error" || !app.sync.lastError) return null;
  return (
    <div className="readonly-banner error-banner" role="alert">
      <WarningIcon size={12} /> <span className="banner-text">Sync stopped: {app.sync.lastError}</span>
      <button className="link-btn" onClick={() => void getBackend().syncNow()}>
        Try again
      </button>
      <button className="link-btn" onClick={() => openDialog({ kind: "settings", tab: "sync" })}>
        Details…
      </button>
    </div>
  );
}

export function ReadOnlyBanner() {
  const app = useStore((s) => s.app);
  const openDialog = useStore((s) => s.openDialog);
  if (!app || app.account.mode !== "cloud" || app.canWrite) return null;
  if (!app.format.writesSupported)
    return (
      <div className="readonly-banner">
        <LockIcon size={12} /> Read-only — Things Cloud sent data Things 3 doesn't fully understand yet, so changes are off. Syncing still works.
        <button className="link-btn" onClick={() => openDialog({ kind: "settings", tab: "sync" })}>
          Details…
        </button>
      </div>
    );
  return (
    <div className="readonly-banner">
      <LockIcon size={12} /> Read-only — changes can't be made until you enable writing.
      <button className="link-btn" onClick={() => openDialog({ kind: "writeOptIn" })}>
        Enable…
      </button>
    </div>
  );
}
