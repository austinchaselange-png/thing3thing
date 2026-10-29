//! Non-secret preferences, stored as JSON in the app config directory.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum AccountMode {
    #[default]
    Demo,
    Cloud,
    SignedOut,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub mode: AccountMode,
    pub email: Option<String>,
    pub quick_entry_shortcut: String,
    pub close_to_tray: bool,
    pub launch_at_login: bool,
    pub notifications: bool,
    pub poll_seconds: u64,
    pub mica: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            mode: AccountMode::Demo,
            email: None,
            quick_entry_shortcut: "Ctrl+Alt+Space".into(),
            close_to_tray: true,
            launch_at_login: false,
            notifications: true,
            poll_seconds: 30,
            mica: false,
        }
    }
}

/// The subset the UI may change (account fields are changed by commands).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    pub quick_entry_shortcut: Option<String>,
    pub close_to_tray: Option<bool>,
    pub launch_at_login: Option<bool>,
    pub notifications: Option<bool>,
    pub poll_seconds: Option<u64>,
    pub mica: Option<bool>,
}

/// Writes `body` to a uniquely named temporary file next to `path`, flushes it
/// to disk, then renames it over `path`. Readers see the old or the new file, never half of one.
pub fn write_flushed(path: &Path, body: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let tmp: PathBuf = path.with_file_name(format!(".{name}.{}.tmp", things_cloud::id::new_id()));
    let result = (|| {
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        f.write_all(body)?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

impl Settings {
    /// Missing file: defaults. Unreadable or damaged file: the damaged copy is
    /// kept beside it and the app starts signed out (rather than quietly
    /// switching to the "On this PC" lists).
    pub fn load(path: &Path) -> Settings {
        let bytes = match std::fs::read(path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Settings::default(),
            Err(e) => {
                log::error!("settings: could not read {}: {e}", path.display());
                return Settings { mode: AccountMode::SignedOut, ..Settings::default() };
            }
        };
        match serde_json::from_slice(&bytes) {
            Ok(s) => s,
            Err(e) => {
                let aside = path.with_extension(format!("damaged-{}.json", chrono::Local::now().format("%Y%m%d-%H%M%S")));
                let kept = std::fs::copy(path, &aside).is_ok();
                log::error!("settings: {} is damaged ({e}); kept a copy: {kept}", path.display());
                Settings { mode: AccountMode::SignedOut, ..Settings::default() }
            }
        }
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        write_flushed(path, &serde_json::to_vec_pretty(self)?)
    }

    pub fn apply(&mut self, p: SettingsPatch) {
        if let Some(v) = p.quick_entry_shortcut {
            self.quick_entry_shortcut = v;
        }
        if let Some(v) = p.close_to_tray {
            self.close_to_tray = v;
        }
        if let Some(v) = p.launch_at_login {
            self.launch_at_login = v;
        }
        if let Some(v) = p.notifications {
            self.notifications = v;
        }
        if let Some(v) = p.poll_seconds {
            self.poll_seconds = v.clamp(30, 3600);
        }
        if let Some(v) = p.mica {
            self.mica = v;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_and_patching() {
        let mut s = Settings::default();
        assert_eq!(s.mode, AccountMode::Demo);
        s.apply(SettingsPatch { poll_seconds: Some(1), ..Default::default() });
        assert_eq!(s.poll_seconds, 30, "polling faster than 30 s is not allowed");
        let json = serde_json::to_value(&s).unwrap();
        assert_eq!(json["quickEntryShortcut"], "Ctrl+Alt+Space");
        assert!(json.get("password").is_none());
        let parsed: Settings = serde_json::from_str(r#"{"mode":"cloud","email":"a@b.c"}"#).unwrap();
        assert_eq!(parsed.mode, AccountMode::Cloud);
        assert!(parsed.close_to_tray, "missing fields fall back to defaults");
    }
}
