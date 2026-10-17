//! Tings 3 desktop app: Tauri shell around the things-sync engine.

mod commands;
mod core;
mod credentials;
mod settings;
mod shell;

use tauri::Manager;
use tauri_plugin_autostart::MacosLauncher;

const MINIMIZED_FLAG: &str = "--minimized";

pub fn run() {
    tauri::Builder::default()
        // Must be first: a second launch focuses the running instance.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| shell::show_main(app)))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![MINIMIZED_FLAG])))
        .plugin(shell::shortcut_plugin())
        .setup(|app| {
            let handle = app.handle().clone();
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

            std::thread::Builder::new().name("tings3-sync".into()).spawn(move || core.run_worker())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_state,
            commands::sync_now,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tings 3");
}
