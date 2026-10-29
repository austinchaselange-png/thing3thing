//! Windows integration: windows, system tray, global shortcut, autostart.

use std::sync::atomic::Ordering;
use std::sync::Arc;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::core::Core;

pub const MAIN: &str = "main";
pub const QUICK: &str = "quick";

pub fn create_main_window(app: &AppHandle, mica: bool, visible: bool) -> tauri::Result<WebviewWindow> {
    let mut b = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
        .title("Things 3")
        .inner_size(1120.0, 740.0)
        .min_inner_size(360.0, 420.0)
        .decorations(false) // the UI draws its own title bar and traffic lights
        // Tauri's file-drop handler swallows HTML5 drag and drop on Windows,
        // which the UI needs for reordering to-dos.
        .disable_drag_drop_handler()
        .shadow(true)
        .center()
        .visible(visible);
    if mica {
        use tauri::window::{Effect, EffectsBuilder};
        b = b.transparent(true).effects(EffectsBuilder::new().effect(Effect::Mica).build());
    }
    let window = b.build()?;
    let handle = app.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::CloseRequested { api, .. } => {
            let core = handle.state::<Arc<Core>>();
            if core.settings().close_to_tray {
                api.prevent_close();
                if let Some(w) = handle.get_webview_window(MAIN) {
                    let _ = w.hide();
                }
                core.visible.store(false, Ordering::Relaxed);
            }
        }
        WindowEvent::Focused(true) => {
            let core = handle.state::<Arc<Core>>();
            if !core.visible.swap(true, Ordering::Relaxed) {
                core.wake(); // refresh when the user comes back
            }
        }
        // Minimizing counts as hidden, so background polling slows down just as
        // it does in the tray; restoring wakes it straight away.
        WindowEvent::Resized(_) => {
            let core = handle.state::<Arc<Core>>();
            let minimized = handle.get_webview_window(MAIN).and_then(|w| w.is_minimized().ok()).unwrap_or(false);
            if minimized {
                core.visible.store(false, Ordering::Relaxed);
            } else if handle.get_webview_window(MAIN).and_then(|w| w.is_visible().ok()).unwrap_or(false) && !core.visible.swap(true, Ordering::Relaxed) {
                core.wake();
            }
        }
        _ => {}
    });
    Ok(window)
}

pub fn create_quick_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let window = WebviewWindowBuilder::new(app, QUICK, WebviewUrl::App("quick-entry.html".into()))
        .title("Quick Entry")
        .inner_size(580.0, 200.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .center()
        .build()?;
    let w = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Focused(false) = event {
            let _ = w.hide();
        }
    });
    Ok(window)
}

/// Opens a project in a window of its own (or focuses it if it's already open).
/// It runs the same UI, locked to that project; changes reach every window
/// through the broadcast "state" event.
pub fn open_project_window(app: &AppHandle, id: &str, title: &str) -> tauri::Result<()> {
    // Labels may only hold [a-zA-Z0-9-/:_]; Things ids are Base58, but be strict anyway.
    let safe: String = id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(64).collect();
    if safe.is_empty() {
        return Ok(());
    }
    let label = format!("project-{safe}");
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    let title = if title.trim().is_empty() { "Things 3".to_string() } else { format!("{} – Things 3", title.trim()) };
    // Cascade from the main window so the new one doesn't hide exactly behind it.
    let open = app.webview_windows().keys().filter(|l| l.starts_with("project-")).count() as f64;
    let mut b = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(format!("index.html?window=project&id={safe}").into()))
        .title(title)
        .inner_size(760.0, 680.0)
        .min_inner_size(480.0, 360.0)
        .decorations(false)
        .disable_drag_drop_handler()
        .shadow(true);
    match app.get_webview_window(MAIN).and_then(|m| m.outer_position().ok().zip(m.scale_factor().ok())) {
        Some((pos, scale)) => {
            let step = 36.0 * (open + 1.0);
            b = b.position(pos.x as f64 / scale + 60.0 + step, pos.y as f64 / scale + 40.0 + step);
        }
        None => b = b.center(),
    }
    let w = b.build()?;
    let _ = w.set_focus();
    Ok(())
}

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    app.state::<Arc<Core>>().visible.store(true, Ordering::Relaxed);
}

pub fn toggle_quick_entry(app: &AppHandle) {
    let Some(w) = app.get_webview_window(QUICK) else { return };
    if w.is_visible().unwrap_or(false) {
        let _ = w.hide();
    } else {
        let _ = w.center();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

pub fn hide_quick_entry(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(QUICK) {
        let _ = w.hide();
    }
}

fn parse_shortcut(s: &str) -> Result<Shortcut, String> {
    s.parse::<Shortcut>().map_err(|e| e.to_string())
}

/// Swaps the global quick-entry shortcut. On failure the old one stays active.
pub fn register_shortcut(app: &AppHandle, old: &str, new: &str) -> Result<(), String> {
    let gs = app.global_shortcut();
    let new_sc = parse_shortcut(new)?;
    if let Ok(old_sc) = parse_shortcut(old) {
        let _ = gs.unregister(old_sc);
    }
    if let Err(e) = gs.register(new_sc) {
        if let Ok(old_sc) = parse_shortcut(old) {
            let _ = gs.register(old_sc);
        }
        return Err(e.to_string());
    }
    Ok(())
}

pub fn shortcut_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                toggle_quick_entry(app);
            }
        })
        .build()
}

pub fn set_autostart(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let al = app.autolaunch();
    let r = if enabled { al.enable() } else { al.disable() };
    r.map_err(|e| format!("Could not change the startup setting: {e}"))
}

/// Quit from the tray: the UI first saves an open edit, and a change being
/// sent to Things Cloud is allowed to finish, so nothing is cut off mid-write.
pub fn quit_gracefully(app: &AppHandle) {
    let core = app.state::<Arc<Core>>().inner().clone();
    if core.quitting.swap(true, Ordering::SeqCst) {
        return;
    }
    let has_ui = app.get_webview_window(MAIN).is_some();
    let _ = app.emit_to(MAIN, "tings3:before-quit", ());
    let app = app.clone();
    std::thread::spawn(move || {
        // Up to 5 s for the UI to report back (it calls `quit_ready`).
        let start = std::time::Instant::now();
        while has_ui && !core.quit_ready.load(Ordering::SeqCst) && start.elapsed() < std::time::Duration::from_secs(5) {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        core.when_idle(std::time::Duration::from_secs(20), || {
            app.exit(0);
            // Keep holding the engine until the process ends.
            std::thread::sleep(std::time::Duration::from_secs(5));
        });
    });
}

pub fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Things 3", true, None::<&str>)?;
    let quick = MenuItem::with_id(app, "quick", "New To-Do…", true, None::<&str>)?;
    let sync = MenuItem::with_id(app, "sync", "Sync Now", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Things 3", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show, &quick, &sep, &sync, &settings, &sep2, &quit])?;
    let mut builder = TrayIconBuilder::with_id("tings3")
        .tooltip("Things 3")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main(app),
            "quick" => toggle_quick_entry(app),
            "sync" => app.state::<Arc<Core>>().sync_now(),
            "settings" => {
                show_main(app);
                let _ = app.emit_to(MAIN, "tings3:settings", ());
            }
            "quit" => quit_gracefully(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}
