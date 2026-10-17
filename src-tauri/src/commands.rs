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
