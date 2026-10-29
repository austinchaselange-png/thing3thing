//! Things 3 desktop app: Tauri shell around the things-sync engine.

mod commands;
mod core;
mod credentials;
mod drive;
mod gcal;
mod settings;
mod shell;
mod winshell;

use std::sync::Mutex;

/// `things:` links the app was started with, until the UI asks for them.
pub struct PendingLinks(pub Mutex<Vec<String>>);

use tauri::{Emitter, Manager};
use tauri_plugin_autostart::MacosLauncher;

const MINIMIZED_FLAG: &str = "--minimized";

pub fn run() {
    tauri::Builder::default()
        // Must be first: a second launch focuses the running instance.
        // A second launch (a things:/// link, a jump list task) goes to the running instance.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            shell::show_main(app);
            for link in winshell::links_in(&args) {
                let _ = app.emit_to(shell::MAIN, "open-url", link);
            }
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![MINIMIZED_FLAG])))
        .plugin(shell::shortcut_plugin())
        .setup(|app| {
            let handle = app.handle().clone();
            let args: Vec<String> = std::env::args().collect();
            app.manage(PendingLinks(Mutex::new(winshell::links_in(&args))));
            app.manage(std::sync::Arc::new(drive::Drive::default()));
            app.manage(std::sync::Arc::new(gcal::GCal::new(app.path().app_local_data_dir().unwrap_or_else(|_| std::env::temp_dir()))));
            std::thread::spawn(|| {
                winshell::register_url_scheme();
                if let Err(e) = winshell::build_jump_list() {
                    log::warn!("could not build the jump list: {e:?}");
                }
            });
            let core = core::Core::new(handle.clone());
            app.manage(core.clone());
            let settings = core.settings();

            let start_hidden = std::env::args().any(|a| a == MINIMIZED_FLAG);
            shell::create_main_window(&handle, settings.mica && core::mica_available(), !start_hidden)?;
            shell::create_quick_window(&handle)?;
            shell::build_tray(&handle)?;
            if start_hidden {
                core.visible.store(false, std::sync::atomic::Ordering::Relaxed);
            }
            if let Err(e) = shell::register_shortcut(&handle, "", &settings.quick_entry_shortcut) {
                log::warn!("could not register quick entry shortcut {}: {e}", settings.quick_entry_shortcut);
            }
            // Keep the OS autostart entry in line with the saved preference.
            let _ = shell::set_autostart(&handle, settings.launch_at_login);

            // Google Drive backup: every 20 s, upload if anything changed (and connected).
            {
                let core = core.clone();
                let drive: std::sync::Arc<drive::Drive> = app.state::<std::sync::Arc<drive::Drive>>().inner().clone();
                let handle = handle.clone();
                std::thread::Builder::new().name("tings3-drive".into()).spawn(move || {
                    let mut pause_until = std::time::Instant::now() + std::time::Duration::from_secs(10);
                    // Data revision of the last payload Drive accepted (or found unchanged).
                    let mut backed_up_rev: Option<u64> = None;
                    loop {
                        std::thread::sleep(std::time::Duration::from_secs(20));
                        if std::time::Instant::now() < pause_until || !drive.auto_ready() {
                            continue;
                        }
                        // Nothing published since the last backup: skip serializing and hashing it all.
                        let rev = core.data_rev();
                        if backed_up_rev == Some(rev) && !drive.needs_upload() {
                            continue;
                        }
                        let Some(body) = core.backup_payload() else { continue };
                        match drive.back_up(&body, false) {
                            Ok(false) => {
                                backed_up_rev = Some(rev); // same bytes as the last upload
                                continue;
                            }
                            Ok(true) => backed_up_rev = Some(rev),
                            // A manual backup is running; check again next time.
                            Err(e) if e["code"] == "busy" => continue,
                            // Offline or Google unhappy: try again in 5 minutes.
                            Err(_) => pause_until = std::time::Instant::now() + std::time::Duration::from_secs(300),
                        }
                        let _ = handle.emit_to(shell::MAIN, "drive", drive.status());
                    }
                })?;
            }
            std::thread::Builder::new().name("tings3-sync".into()).spawn(move || core.run_worker())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_state,
            commands::sync_now,
            commands::quit_ready,
            commands::apply_mutation,
            commands::connect_account,
            commands::disconnect_account,
            commands::use_demo,
            commands::set_write_policy,
            commands::dismiss_issue,
            commands::reapply_issue,
            commands::update_settings,
            commands::demo_simulate_remote_edit,
            commands::hide_quick_entry,
            commands::show_main_window,
            commands::take_links,
            commands::open_project_window,
            commands::export_backup,
            commands::open_url,
            commands::drive_status,
            commands::drive_set_client,
            commands::drive_connect,
            commands::drive_disconnect,
            commands::drive_set_auto,
            commands::drive_backup_now,
            commands::drive_list,
            commands::drive_download,
            commands::drive_restore,
            commands::gcal_status,
            commands::gcal_set_client,
            commands::gcal_connect,
            commands::gcal_disconnect,
            commands::gcal_calendars,
            commands::gcal_set_visible,
            commands::gcal_events,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Things 3");
}
