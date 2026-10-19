// Settings → Google Drive: back up everything to a "Things 3" folder in the
// user's Drive. Three states: set up (a Google OAuth client), connect, and
// connected (status, snapshots, restore for lists stored on this PC).
import { useEffect, useState } from "react";
import { getBackend } from "../backend";
import { isWriteError, useStore } from "../store";
import type { DriveBackup, DriveStatus } from "../types";
import { CheckIcon, DriveIcon, WarningIcon } from "./Icons";

async function attempt<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    useStore.getState().toast(isWriteError(e) ? e.message : String(e), "error");
    return null;
  }
}

export function ago(ms: number | null | undefined): string {
  if (!ms) return "never";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
}

function size(bytes: number | null | undefined) {
  if (!bytes) return "";
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** "Things 3 – 2026-10-18.json" → "Sunday, October 18". */
function backupLabel(b: DriveBackup): string {
  if (b.latest) return "Latest";
  const m = /(\d{4}-\d{2}-\d{2})/.exec(b.name);
  if (!m) return b.name.replace(/\.json$/, "");
  const d = new Date(`${m[1]}T12:00:00`);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: sameYear ? undefined : "numeric" });
}

const CONSOLE = "https://console.cloud.google.com/apis/credentials";
const DRIVE_API = "https://console.cloud.google.com/apis/library/drive.googleapis.com";

export function DriveSettings() {
  const status = useStore((s) => s.drive);
  const setDrive = (d: DriveStatus | null) => d && useStore.setState({ drive: d });
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    void attempt(() => getBackend().driveStatus()).then(setDrive);
  }, []);

  if (!status) return <div className="settings-section drive-settings" aria-busy="true" />;
  return (
    <div className="settings-section drive-settings">
      <div className="drive-hero">
        <span className="drive-hero-icon">
          <DriveIcon size={26} />
        </span>
        <div>
          <h3>Back up to Google Drive</h3>
          <p>
            Things 3 keeps a copy of all your lists in a <b>Things 3</b> folder in your Google Drive, updated a few seconds after every change, with a snapshot for each of the last 30 days.
          </p>
        </div>
      </div>
      {!status.configured ? (
        <ClientSetup onDone={setDrive} />
      ) : !status.connected ? (
        <div className="drive-connect">
          <button
            className="btn primary"
            disabled={connecting}
            onClick={() => {
              setConnecting(true);
              void attempt(() => getBackend().driveConnect())
                .then((d) => {
                  setDrive(d);
                  if (d?.connected) useStore.getState().toast(d.lastBackupAt ? "Connected. Your first backup is in Google Drive." : "Google Drive connected", "success");
                })
                .finally(() => setConnecting(false));
            }}
          >
            {connecting ? "Waiting for Google…" : "Connect Google Drive…"}
          </button>
          <p className="hint">{connecting ? "Finish signing in in your browser, then come back here." : "Opens Google in your browser to sign in. Things 3 only gets access to the files it creates."}</p>
          {!status.builtInClient && <ChangeClient onDone={setDrive} />}
        </div>
      ) : (
        <Connected status={status} onChange={setDrive} />
      )}
    </div>
  );
}

function Connected({ status, onChange }: { status: DriveStatus; onChange: (d: DriveStatus | null) => void }) {
  const local = useStore((s) => s.app?.account.mode === "demo");
  const [backups, setBackups] = useState<DriveBackup[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const load = () => void attempt(() => getBackend().driveList()).then((list) => setBackups(list ?? []));
  useEffect(load, [status.lastBackupAt]);

  const backUp = () => {
    setBusy(true);
    void attempt(() => getBackend().driveBackupNow())
      .then((d) => {
        onChange(d);
        if (d) useStore.getState().toast("Backed up to Google Drive", "success");
      })
      .finally(() => setBusy(false));
  };

  return (
    <>
      <div className="drive-account card">
        <span className="drive-avatar" aria-hidden="true">
          {(status.name || status.email || "?").slice(0, 1).toUpperCase()}
        </span>
        <span className="grow">
          <b>{status.name || "Google Drive"}</b>
          <small>{status.email}</small>
        </span>
        <button className="btn" onClick={() => void attempt(() => getBackend().driveDisconnect()).then(onChange)}>
          Disconnect
        </button>
      </div>

      <label className="toggle-row">
        <span>
          <span className="toggle-label">Back up automatically</span>
          <small>After each change, while Things 3 is running.</small>
        </span>
        <input type="checkbox" role="switch" checked={status.auto} onChange={(e) => void attempt(() => getBackend().driveSetAuto(e.target.checked)).then(onChange)} />
      </label>

      <div className={`drive-status${status.lastError ? " error" : ""}`} role="status">
        {status.lastError ? <WarningIcon size={13} /> : <CheckIcon size={13} />}
        <span className="grow">
          {busy || status.busy ? "Backing up…" : status.lastError ? `Last backup failed: ${status.lastError}` : `Last backup ${ago(status.lastBackupAt)}`}
        </span>
        {status.folderLink && (
          <button className="link-btn" onClick={() => void attempt(() => getBackend().openUrl(status.folderLink!))}>
            Show in Google Drive
          </button>
        )}
        <button className="btn" disabled={busy} onClick={backUp}>
          Back Up Now
        </button>
      </div>

      <h3 className="drive-list-title">Backups</h3>
      <div className="drive-list card" role="list">
        {backups === null ? (
          <div className="drive-row muted">Loading…</div>
        ) : !backups.length ? (
          <div className="drive-row muted">No backups yet.</div>
        ) : (
          backups.map((b) => (
            <div key={b.id} className="drive-row" role="listitem">
              <span className="grow">
                <b>{backupLabel(b)}</b>
                <small>
                  {b.modifiedTime ? new Date(b.modifiedTime).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""}
                  {b.size ? ` · ${size(b.size)}` : ""}
                </small>
              </span>
              {confirm === b.id ? (
                <span className="drive-confirm">
                  Replace your lists with this backup?
                  <button className="btn" onClick={() => setConfirm(null)}>
                    Cancel
                  </button>
                  <button
                    className="btn danger"
                    onClick={() => {
                      setConfirm(null);
                      void attempt(() => getBackend().driveRestore(b.id)).then((r) => r !== null && useStore.getState().toast("Restored from Google Drive", "success"));
                    }}
                  >
                    Restore
                  </button>
                </span>
              ) : (
                <>
                  <button className="link-btn" onClick={() => void attempt(() => getBackend().driveDownload(b.id, b.name)).then((p) => p && useStore.getState().toast(`Saved to ${p}`, "success"))}>
                    Download
                  </button>
                  {local && (
                    <button className="link-btn" title="Replace the lists stored on this PC with this backup" onClick={() => setConfirm(b.id)}>
                      Restore…
                    </button>
                  )}
                </>
              )}
            </div>
          ))
        )}
      </div>
      <p className="hint">
        {local
          ? "Restoring replaces the lists stored on this PC. Your current lists are kept in a file next to them, just in case."
          : "Your lists also live in Things Cloud. To keep your iPhone in charge, backups of a Things Cloud account can be downloaded but not restored over it."}
      </p>
    </>
  );
}

/** One-time setup: a Google OAuth client of type "Desktop app". */
function ClientSetup({ onDone }: { onDone: (d: DriveStatus | null) => void }) {
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <div className="drive-connect">
        <button className="btn primary" onClick={() => setOpen(true)}>
          Set Up Google Drive…
        </button>
        <p className="hint">Takes about five minutes, once. Google needs you to register Things 3 with your own Google account.</p>
      </div>
    );
  return <ClientForm onDone={onDone} steps />;
}

function ChangeClient({ onDone }: { onDone: (d: DriveStatus | null) => void }) {
  const [open, setOpen] = useState(false);
  return open ? (
    <ClientForm onDone={onDone} />
  ) : (
    <button className="link-btn small" onClick={() => setOpen(true)}>
      Use a different Google client…
    </button>
  );
}

function ClientForm({ onDone, steps }: { onDone: (d: DriveStatus | null) => void; steps?: boolean }) {
  const [id, setId] = useState("");
  const [secret, setSecret] = useState("");
  const open = (url: string) => void attempt(() => getBackend().openUrl(url));
  return (
    <div className="drive-setup">
      {steps && (
        <ol className="drive-steps">
          <li>
            In Google Cloud, create a project and{" "}
            <button className="link-btn" onClick={() => open(DRIVE_API)}>
              turn on the Google Drive API
            </button>
            .
          </li>
          <li>
            Under <b>OAuth consent screen</b>, choose <b>External</b>, fill in a name, add your Google address as a test user, then <b>Publish app</b> so the sign-in doesn't expire every week.
          </li>
          <li>
            Under{" "}
            <button className="link-btn" onClick={() => open(CONSOLE)}>
              Credentials
            </button>
            , choose <b>Create credentials → OAuth client ID</b> with application type <b>Desktop app</b>.
          </li>
          <li>Paste the client ID and client secret here.</li>
        </ol>
      )}
      <label className="form">
        Client ID
        <input value={id} onChange={(e) => setId(e.target.value)} placeholder="1234…-abc.apps.googleusercontent.com" spellCheck={false} autoFocus />
      </label>
      <label className="form">
        Client secret
        <input value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="GOCSPX-…" spellCheck={false} type="password" />
      </label>
      <p className="hint">Stored in Windows Credential Manager. Google calls the secret of a desktop app non-confidential; it only identifies Things 3 to Google.</p>
      <button className="btn primary" disabled={!id.trim()} onClick={() => void attempt(() => getBackend().driveSetClient(id, secret)).then(onDone)}>
        Save
      </button>
    </div>
  );
}
