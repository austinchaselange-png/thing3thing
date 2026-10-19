//! IPC commands. Blocking work (network, SQLite) runs off the UI thread.
//! Errors are returned as `{ code, message, ... }` objects.

use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{AppHandle, State};
use things_sync::{Mutation, WritePolicy, WriteReport};

use crate::core::{AppStateDto, Core};
use crate::settings::SettingsPatch;
use crate::shell;

type Res<T> = Result<T, Value>;

async fn blocking<T: Send + 'static>(core: &State<'_, Arc<Core>>, f: impl FnOnce(&Core) -> Res<T> + Send + 'static) -> Res<T> {
    let core = Arc::clone(core.inner());
    tauri::async_runtime::spawn_blocking(move || f(&core))
        .await
        .unwrap_or_else(|e| Err(json!({ "code": "storage", "message": format!("internal error: {e}") })))
}

#[tauri::command]
pub fn get_state(core: State<'_, Arc<Core>>) -> AppStateDto {
    core.state()
}

#[tauri::command]
pub fn sync_now(core: State<'_, Arc<Core>>) {
    core.sync_now();
}

#[tauri::command]
pub async fn apply_mutation(core: State<'_, Arc<Core>>, mutation: Mutation, force: bool) -> Res<WriteReport> {
    blocking(&core, move |c| c.apply(mutation, force)).await
}

#[tauri::command]
pub async fn connect_account(core: State<'_, Arc<Core>>, email: String, password: String) -> Res<()> {
    blocking(&core, move |c| c.connect(email, password)).await
}

#[tauri::command]
pub async fn disconnect_account(core: State<'_, Arc<Core>>, forget_cache: bool) -> Res<()> {
    blocking(&core, move |c| c.disconnect(forget_cache)).await
}

#[tauri::command]
pub async fn use_demo(core: State<'_, Arc<Core>>) -> Res<()> {
    blocking(&core, |c| c.use_demo()).await
}

#[tauri::command]
pub async fn set_write_policy(core: State<'_, Arc<Core>>, policy: WritePolicy) -> Res<()> {
    blocking(&core, move |c| c.set_policy(policy)).await
}

#[tauri::command]
pub async fn dismiss_issue(core: State<'_, Arc<Core>>, id: i64) -> Res<()> {
    blocking(&core, move |c| c.dismiss_issue(id)).await
}

#[tauri::command]
pub async fn reapply_issue(core: State<'_, Arc<Core>>, id: i64) -> Res<WriteReport> {
    blocking(&core, move |c| c.reapply_issue(id)).await
}

#[tauri::command]
pub async fn update_settings(core: State<'_, Arc<Core>>, patch: SettingsPatch) -> Res<()> {
    blocking(&core, move |c| c.update_settings(patch)).await
}

#[tauri::command]
pub async fn demo_simulate_remote_edit(core: State<'_, Arc<Core>>) -> Res<String> {
    blocking(&core, |c| c.simulate_remote_edit()).await
}

#[tauri::command]
pub fn hide_quick_entry(app: AppHandle) {
    shell::hide_quick_entry(&app);
}

#[tauri::command]
pub fn show_main_window(app: AppHandle) {
    shell::show_main(&app);
}

/// `things:` links the app was launched with (later ones arrive as "open-url" events).
#[tauri::command]
pub fn take_links(links: State<'_, crate::PendingLinks>) -> Vec<String> {
    std::mem::take(&mut *links.0.lock().unwrap())
}

/// Saves everything (to-dos, projects, areas, tags, checklists) as JSON in
/// Documents\Things 3 Backups and shows it in Explorer. Returns the file path.
#[tauri::command]
pub async fn export_backup(core: State<'_, Arc<Core>>) -> Res<String> {
    blocking(&core, |c| {
        let fail = |e: std::io::Error| json!({ "code": "storage", "message": format!("Couldn't save the backup: {e}") });
        let state = c.state();
        let docs = std::env::var_os("USERPROFILE").map(std::path::PathBuf::from).unwrap_or_default().join("Documents");
        let dir = docs.join("Things 3 Backups");
        std::fs::create_dir_all(&dir).map_err(fail)?;
        let name = format!("things-backup-{}.json", chrono::Local::now().format("%Y-%m-%d-%H%M%S"));
        let path = dir.join(name);
        let body = json!({
            "app": "Things 3 for Windows",
            "exportedAt": chrono::Local::now().to_rfc3339(),
            "account": state.account,
            "snapshot": state.snapshot,
        });
        std::fs::write(&path, serde_json::to_string_pretty(&body).unwrap_or_default()).map_err(fail)?;
        #[cfg(windows)]
        {
            let _ = std::process::Command::new("explorer").arg(format!("/select,{}", path.display())).spawn();
        }
        Ok(path.display().to_string())
    })
    .await
}
