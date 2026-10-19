import type { AppState, DriveBackup, DriveStatus, Mutation, Settings, WritePolicy, WriteReport } from "../types";

/**
 * Everything the UI needs from the app. Implemented by the Tauri bridge
 * (desktop app) and by MockBackend (browser preview and tests).
 * Methods reject with a `WriteError`-shaped object on failure.
 */
export interface Backend {
  readonly kind: "tauri" | "mock";
  getState(): Promise<AppState>;
  /** Called with a fresh state after every change (sync, write, settings). */
  subscribe(listener: (s: AppState) => void): () => void;
  apply(m: Mutation, opts?: { force?: boolean }): Promise<WriteReport>;
  syncNow(): Promise<void>;
  connect(email: string, password: string): Promise<void>;
  disconnect(forgetCache: boolean): Promise<void>;
  useDemo(): Promise<void>;
  setPolicy(p: WritePolicy): Promise<void>;
  dismissIssue(id: number): Promise<void>;
  reapplyIssue(id: number): Promise<WriteReport>;
  updateSettings(s: Partial<Settings>): Promise<void>;
  /** Demo only: pretend another device edited something. */
  simulateRemoteEdit(): Promise<string>;
  hideQuickEntry(): Promise<void>;
  showMainWindow(): Promise<void>;
  /** things:/// links the app was opened with. */
  takeLinks(): Promise<string[]>;
  /** Later links (a second launch, the jump list). */
  onLink(listener: (url: string) => void): () => void;
  /** Reminders as they go off, for Snooze. */
  onReminder(listener: (r: { taskId: string; title: string; at: string }) => void): () => void;
  /** Saves a JSON backup; returns where it went. */
  exportBackup(): Promise<string>;
  openUrl(url: string): Promise<void>;
  // Google Drive backup
  driveStatus(): Promise<DriveStatus>;
  driveSetClient(clientId: string, clientSecret: string): Promise<DriveStatus>;
  driveConnect(): Promise<DriveStatus>;
  driveDisconnect(): Promise<DriveStatus>;
  driveSetAuto(auto: boolean): Promise<DriveStatus>;
  driveBackupNow(): Promise<DriveStatus>;
  driveList(): Promise<DriveBackup[]>;
  /** Saves a backup to this PC; returns where. */
  driveDownload(id: string, name: string): Promise<string>;
  /** Lists stored on this PC only. */
  driveRestore(id: string): Promise<void>;
  /** Status after automatic backups. */
  onDrive(listener: (s: DriveStatus) => void): () => void;
}
