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
        .title("Cairn")
        .inner_size(1120.0, 740.0)
        .min_inner_size(720.0, 480.0)
        .decorations(false) // the UI draws its own title bar and traffic lights
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

pub fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Cairn", true, None::<&str>)?;
    let quick = MenuItem::with_id(app, "quick", "New To-Do…", true, None::<&str>)?;
    let sync = MenuItem::with_id(app, "sync", "Sync Now", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Cairn", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show, &quick, &sep, &sync, &settings, &sep2, &quit])?;
    let mut builder = TrayIconBuilder::with_id("cairn")
        .tooltip("Cairn")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main(app),
            "quick" => toggle_quick_entry(app),
            "sync" => app.state::<Arc<Core>>().sync_now(),
            "settings" => {
                show_main(app);
                let _ = app.emit_to(MAIN, "cairn:settings", ());
            }
            "quit" => app.exit(0),
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
