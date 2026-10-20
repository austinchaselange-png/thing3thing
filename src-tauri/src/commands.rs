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
pub async fn apply_mutation(window: tauri::WebviewWindow, core: State<'_, Arc<Core>>, mutation: Mutation, force: bool) -> Res<WriteReport> {
    // Quick Entry only ever creates to-dos; it may not edit, move or delete anything.
    if window.label() == shell::QUICK && !matches!(mutation, Mutation::CreateTask { .. }) {
        return Err(json!({ "code": "invalid", "message": "Quick Entry can only create new to-dos." }));
    }
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

/// Opens a project in its own window.
#[tauri::command]
pub fn open_project_window(app: AppHandle, id: String, title: String) -> Res<()> {
    shell::open_project_window(&app, &id, &title).map_err(|e| json!({ "code": "storage", "message": format!("Couldn't open a window: {e}") }))
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

// ---------- Google Drive backup ----------

type DriveState<'a> = State<'a, Arc<crate::drive::Drive>>;
type Status = crate::drive::DriveStatus;

async fn drive_blocking<T: Send + 'static>(d: &DriveState<'_>, f: impl FnOnce(&crate::drive::Drive) -> Res<T> + Send + 'static) -> Res<T> {
    let d = Arc::clone(d.inner());
    tauri::async_runtime::spawn_blocking(move || f(&d))
        .await
        .unwrap_or_else(|e| Err(json!({ "code": "storage", "message": format!("internal error: {e}") })))
}

/// Opens an https link (Google Drive, a help page) in the default browser.
#[tauri::command]
pub fn open_url(url: String) -> Res<()> {
    crate::drive::open_in_browser(&url)
}

#[tauri::command]
pub async fn drive_status(drive: DriveState<'_>) -> Res<Status> {
    drive_blocking(&drive, |d| Ok(d.status())).await
}

#[tauri::command]
pub async fn drive_set_client(drive: DriveState<'_>, client_id: String, client_secret: String) -> Res<Status> {
    drive_blocking(&drive, move |d| d.set_client(client_id, client_secret)).await
}

#[tauri::command]
pub async fn drive_connect(app: AppHandle, drive: DriveState<'_>, core: State<'_, Arc<Core>>) -> Res<Status> {
    let result = drive_blocking(&drive, |d| d.connect()).await;
    shell::show_main(&app); // back from the browser
    result?;
    // First backup right away.
    let core = Arc::clone(core.inner());
    drive_blocking(&drive, move |d| {
        if let Some(body) = core.backup_payload() {
            let _ = d.back_up(&body, true);
        }
        Ok(d.status())
    })
    .await
}

#[tauri::command]
pub async fn drive_disconnect(drive: DriveState<'_>) -> Res<Status> {
    drive_blocking(&drive, |d| d.disconnect()).await
}

#[tauri::command]
pub async fn drive_set_auto(drive: DriveState<'_>, auto: bool) -> Res<Status> {
    drive_blocking(&drive, move |d| d.set_auto(auto)).await
}

#[tauri::command]
pub async fn drive_backup_now(drive: DriveState<'_>, core: State<'_, Arc<Core>>) -> Res<Status> {
    let core = Arc::clone(core.inner());
    drive_blocking(&drive, move |d| {
        let body = core.backup_payload().ok_or_else(|| json!({ "code": "invalid", "message": "There's nothing to back up yet." }))?;
        d.back_up(&body, true)?;
        Ok(d.status())
    })
    .await
}

#[tauri::command]
pub async fn drive_list(drive: DriveState<'_>) -> Res<Vec<crate::drive::BackupFile>> {
    drive_blocking(&drive, |d| d.list()).await
}

/// Saves a backup from Drive into Documents\Things 3 Backups and shows it.
#[tauri::command]
pub async fn drive_download(drive: DriveState<'_>, id: String, name: String) -> Res<String> {
    drive_blocking(&drive, move |d| {
        let bytes = d.download(&id)?;
        let fail = |e: std::io::Error| json!({ "code": "storage", "message": format!("Couldn't save the backup: {e}") });
        let dir = std::env::var_os("USERPROFILE").map(std::path::PathBuf::from).unwrap_or_default().join("Documents").join("Things 3 Backups");
        std::fs::create_dir_all(&dir).map_err(fail)?;
        let safe: String = name.chars().map(|c| if r#"<>:"/\|?*"#.contains(c) { '-' } else { c }).collect();
        let path = dir.join(if safe.trim().is_empty() { "Things 3 backup.json".to_string() } else { safe });
        std::fs::write(&path, bytes).map_err(fail)?;
        #[cfg(windows)]
        {
            let _ = std::process::Command::new("explorer").arg(format!("/select,{}", path.display())).spawn();
        }
        Ok(path.display().to_string())
    })
    .await
}

/// Replaces lists stored on this PC with a backup from Drive.
#[tauri::command]
pub async fn drive_restore(drive: DriveState<'_>, core: State<'_, Arc<Core>>, id: String) -> Res<()> {
    let core = Arc::clone(core.inner());
    drive_blocking(&drive, move |d| {
        let bytes = d.download(&id)?;
        core.restore_local(&bytes)
    })
    .await
}

// ---------- Google Calendar side panel (read-only, separate sign-in) ----------

type CalState<'a> = State<'a, Arc<crate::gcal::GCal>>;

async fn cal_blocking<T: Send + 'static>(c: &CalState<'_>, f: impl FnOnce(&crate::gcal::GCal) -> Res<T> + Send + 'static) -> Res<T> {
    let c = Arc::clone(c.inner());
    tauri::async_runtime::spawn_blocking(move || f(&c))
        .await
        .unwrap_or_else(|e| Err(json!({ "code": "storage", "message": format!("internal error: {e}") })))
}

#[tauri::command]
pub async fn gcal_status(cal: CalState<'_>) -> Res<crate::gcal::CalStatus> {
    cal_blocking(&cal, |c| Ok(c.status())).await
}

#[tauri::command]
pub async fn gcal_set_client(cal: CalState<'_>, client_id: String, client_secret: String) -> Res<crate::gcal::CalStatus> {
    cal_blocking(&cal, move |c| c.set_client(client_id, client_secret)).await
}

#[tauri::command]
pub async fn gcal_connect(app: AppHandle, cal: CalState<'_>) -> Res<crate::gcal::CalStatus> {
    let result = cal_blocking(&cal, |c| c.connect()).await;
    shell::show_main(&app); // back from the browser
    result
}

#[tauri::command]
pub async fn gcal_disconnect(cal: CalState<'_>) -> Res<crate::gcal::CalStatus> {
    cal_blocking(&cal, |c| c.disconnect()).await
}

#[tauri::command]
pub async fn gcal_calendars(cal: CalState<'_>) -> Res<Vec<crate::gcal::CalendarInfo>> {
    cal_blocking(&cal, |c| c.calendars()).await
}

#[tauri::command]
pub async fn gcal_set_visible(cal: CalState<'_>, id: String, visible: bool) -> Res<Vec<crate::gcal::CalendarInfo>> {
    cal_blocking(&cal, move |c| c.set_visible(id, visible)).await
}

#[tauri::command]
pub async fn gcal_events(cal: CalState<'_>, time_min: String, time_max: String) -> Res<crate::gcal::EventsResult> {
    cal_blocking(&cal, move |c| c.events(time_min, time_max)).await
}
