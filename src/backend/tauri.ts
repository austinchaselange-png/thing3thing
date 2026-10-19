import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AppState, DriveBackup, DriveStatus, Mutation, Settings, WritePolicy, WriteReport } from "../types";
import type { Backend } from "./Backend";

/** Bridge to the Rust side (src-tauri/src/commands.rs). */
export class TauriBackend implements Backend {
  readonly kind = "tauri" as const;

  getState() {
    return invoke<AppState>("get_state");
  }

  subscribe(listener: (s: AppState) => void) {
    const un = listen<AppState>("state", (e) => listener(e.payload));
    return () => {
      void un.then((f) => f());
    };
  }

  apply(mutation: Mutation, opts: { force?: boolean } = {}) {
    return invoke<WriteReport>("apply_mutation", { mutation, force: opts.force ?? false });
  }

  syncNow() {
    return invoke<void>("sync_now");
  }

  connect(email: string, password: string) {
    return invoke<void>("connect_account", { email, password });
  }

  disconnect(forgetCache: boolean) {
    return invoke<void>("disconnect_account", { forgetCache });
  }

  useDemo() {
    return invoke<void>("use_demo");
  }

  setPolicy(policy: WritePolicy) {
    return invoke<void>("set_write_policy", { policy });
  }

  dismissIssue(id: number) {
    return invoke<void>("dismiss_issue", { id });
  }

  reapplyIssue(id: number) {
    return invoke<WriteReport>("reapply_issue", { id });
  }

  updateSettings(settings: Partial<Settings>) {
    return invoke<void>("update_settings", { patch: settings });
  }

  simulateRemoteEdit() {
    return invoke<string>("demo_simulate_remote_edit");
  }

  hideQuickEntry() {
    return invoke<void>("hide_quick_entry");
  }

  showMainWindow() {
    return invoke<void>("show_main_window");
  }

  takeLinks() {
    return invoke<string[]>("take_links");
  }

  onLink(listener: (url: string) => void) {
    const un = listen<string>("open-url", (e) => listener(e.payload));
    return () => void un.then((f) => f());
  }

  onReminder(listener: (r: { taskId: string; title: string; at: string }) => void) {
    const un = listen<{ taskId: string; title: string; at: string }>("reminder", (e) => listener(e.payload));
    return () => void un.then((f) => f());
  }

  exportBackup() {
    return invoke<string>("export_backup");
  }

  openUrl(url: string) {
    return invoke<void>("open_url", { url });
  }

  driveStatus() {
    return invoke<DriveStatus>("drive_status");
  }

  driveSetClient(clientId: string, clientSecret: string) {
    return invoke<DriveStatus>("drive_set_client", { clientId, clientSecret });
  }

  driveConnect() {
    return invoke<DriveStatus>("drive_connect");
  }

  driveDisconnect() {
    return invoke<DriveStatus>("drive_disconnect");
  }

  driveSetAuto(auto: boolean) {
    return invoke<DriveStatus>("drive_set_auto", { auto });
  }

  driveBackupNow() {
    return invoke<DriveStatus>("drive_backup_now");
  }

  driveList() {
    return invoke<DriveBackup[]>("drive_list");
  }

  driveDownload(id: string, name: string) {
    return invoke<string>("drive_download", { id, name });
  }

  driveRestore(id: string) {
    return invoke<void>("drive_restore", { id });
  }

  onDrive(listener: (s: DriveStatus) => void) {
    const un = listen<DriveStatus>("drive", (e) => listener(e.payload));
    return () => void un.then((f) => f());
  }
}
