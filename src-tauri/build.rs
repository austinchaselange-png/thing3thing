// App commands are declared here so each window only gets the commands it
// needs (see capabilities/). The quick-entry window cannot change settings,
// credentials or the write policy.
const COMMANDS: &[&str] = &[
    "get_state",
    "sync_now",
    "apply_mutation",
    "connect_account",
    "disconnect_account",
    "use_demo",
    "set_write_policy",
    "dismiss_issue",
    "reapply_issue",
    "update_settings",
    "demo_simulate_remote_edit",
    "hide_quick_entry",
    "show_main_window",
    "take_links",
    "export_backup",
    "open_url",
    "drive_status",
    "drive_set_client",
    "drive_connect",
    "drive_disconnect",
    "drive_set_auto",
    "drive_backup_now",
    "drive_list",
    "drive_download",
    "drive_restore",
];

fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)))
        .expect("failed to run tauri-build");
}
