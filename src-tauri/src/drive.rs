//! Google Drive backup: keeps a copy of everything in a "Things 3" folder in
//! the user's Drive — `Things 3 – Latest.json`, updated shortly after changes,
//! plus one dated snapshot per day (the last 30 are kept).
//!
//! Sign-in uses Google's installed-app flow with PKCE and a loopback redirect
//! (http://127.0.0.1:<port>), so no password passes through the app. The only
//! scope is `drive.file`: the app can see and change only the files it created,
//! nothing else in the user's Drive. The refresh token is kept in Windows
//! Credential Manager; access tokens live only in memory.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const SERVICE: &str = "Things 3 (Google Drive)";
const ACCOUNT: &str = "google-drive";
const SCOPES: &str = "openid email https://www.googleapis.com/auth/drive.file";
const FOLDER: &str = "Things 3";
const LATEST: &str = "Things 3 – Latest.json";
const DAILY_PREFIX: &str = "Things 3 – ";
/// Daily snapshots kept in Drive.
pub const KEEP_DAYS: usize = 30;

/// A client ID can be built in (TINGS3_GOOGLE_CLIENT_ID at build time) or pasted in Settings.
const BUILT_IN_CLIENT_ID: Option<&str> = option_env!("TINGS3_GOOGLE_CLIENT_ID");
const BUILT_IN_CLIENT_SECRET: Option<&str> = option_env!("TINGS3_GOOGLE_CLIENT_SECRET");

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveStatus {
    /// A client ID is available (built in or pasted).
    pub configured: bool,
    pub built_in_client: bool,
    pub connected: bool,
    pub email: Option<String>,
    pub name: Option<String>,
    pub auto: bool,
    pub busy: bool,
    /// Epoch ms of the last successful backup.
    pub last_backup_at: Option<i64>,
    pub last_error: Option<String>,
    pub folder_link: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupFile {
    pub id: String,
    pub name: String,
    pub modified_time: Option<String>,
    pub size: Option<u64>,
    pub latest: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    client_id: Option<String>,
    client_secret: Option<String>,
    refresh_token: Option<String>,
    email: Option<String>,
    name: Option<String>,
    folder_id: Option<String>,
    latest_id: Option<String>,
    #[serde(default = "yes")]
    auto: bool,
    last_backup_at: Option<i64>,
}

fn yes() -> bool {
    true
}

impl Default for Stored {
    fn default() -> Self {
        Stored { client_id: None, client_secret: None, refresh_token: None, email: None, name: None, folder_id: None, latest_id: None, auto: true, last_backup_at: None }
    }
}

struct Access {
    token: String,
    expires: Instant,
}

#[derive(Default)]
pub struct Drive {
    stored: Mutex<Option<Stored>>,
    access: Mutex<Option<Access>>,
    busy: Mutex<bool>,
    /// Held for the whole of an upload, so two backups never interleave.
    backup_lock: Mutex<()>,
    last_error: Mutex<Option<String>>,
    /// Hash of the last uploaded backup, so unchanged data isn't re-sent.
    last_hash: Mutex<Option<String>>,
}

type Res<T> = Result<T, Value>;

fn err(code: &str, message: impl Into<String>) -> Value {
    json!({ "code": code, "message": message.into() })
}

/// One shared client (cheap to clone), so connections to Google are reused.
pub(crate) fn http() -> reqwest::blocking::Client {
    static CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();
    CLIENT.get_or_init(|| reqwest::blocking::Client::builder().timeout(Duration::from_secs(60)).build().expect("http client")).clone()
}

/// Revokes a Google token. Ok(()) only when Google confirms it (or says it was already invalid).
pub(crate) fn revoke(token: &str) -> Result<(), String> {
    match http().post("https://oauth2.googleapis.com/revoke").form(&[("token", token)]).send() {
        Ok(r) if r.status().is_success() || r.status().as_u16() == 400 => Ok(()),
        Ok(r) => Err(format!("Google answered {}", r.status())),
        Err(e) => Err(format!("couldn't reach Google: {e}")),
    }
}

pub(crate) fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

pub(crate) fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Opens a web page in the default browser.
pub fn open_in_browser(url: &str) -> Res<()> {
    // Web and email links only, as one plain token (no spaces or control
    // characters that could reach the shell as extra arguments).
    let scheme_ok = url.starts_with("https://") || url.starts_with("http://") || url.starts_with("mailto:");
    if !scheme_ok || url.len() > 4096 || url.chars().any(|c| c.is_whitespace() || c.is_control() || c == '"') {
        return Err(err("invalid", "Only web and email links can be opened."));
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", url])
            .creation_flags(0x0800_0000)
            .spawn()
            .map_err(|e| err("storage", format!("Couldn't open the browser: {e}")))?;
    }
    Ok(())
}

impl Drive {
    fn entry() -> Result<keyring::Entry, Value> {
        keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| err("storage", format!("Secure storage is unavailable: {e}")))
    }

    fn load(&self) -> Stored {
        let mut slot = self.stored.lock().unwrap();
        if slot.is_none() {
            let s = Self::entry()
                .ok()
                .and_then(|e| e.get_password().ok())
                .and_then(|raw| serde_json::from_str::<Stored>(&raw).ok())
                .unwrap_or_default();
            *slot = Some(s);
        }
        slot.clone().unwrap_or_default()
    }

    fn save(&self, s: Stored) -> Res<()> {
        let raw = serde_json::to_string(&s).unwrap_or_default();
        Self::entry()?.set_password(&raw).map_err(|e| err("storage", format!("Couldn't save to Credential Manager: {e}")))?;
        *self.stored.lock().unwrap() = Some(s);
        Ok(())
    }

    fn update(&self, f: impl FnOnce(&mut Stored)) -> Res<()> {
        let mut s = self.load();
        f(&mut s);
        self.save(s)
    }

    fn client(&self) -> Option<(String, String)> {
        let s = self.load();
        match (s.client_id, BUILT_IN_CLIENT_ID) {
            (Some(id), _) if !id.is_empty() => Some((id, s.client_secret.unwrap_or_default())),
            (_, Some(id)) => Some((id.to_string(), BUILT_IN_CLIENT_SECRET.unwrap_or_default().to_string())),
            _ => None,
        }
    }

    pub fn status(&self) -> DriveStatus {
        let s = self.load();
        DriveStatus {
            configured: self.client().is_some(),
            built_in_client: BUILT_IN_CLIENT_ID.is_some(),
            connected: s.refresh_token.is_some(),
            email: s.email,
            name: s.name,
            auto: s.auto,
            busy: *self.busy.lock().unwrap(),
            last_backup_at: s.last_backup_at,
            last_error: self.last_error.lock().unwrap().clone(),
            folder_link: s.folder_id.map(|id| format!("https://drive.google.com/drive/folders/{id}")),
        }
    }

    pub fn set_client(&self, client_id: String, client_secret: String) -> Res<DriveStatus> {
        let id = client_id.trim().to_string();
        if !id.ends_with(".apps.googleusercontent.com") {
            return Err(err("invalid", "That doesn't look like a Google OAuth client ID (it ends with .apps.googleusercontent.com)."));
        }
        let changed = self.load().client_id.as_deref() != Some(id.as_str());
        self.update(|s| {
            if changed {
                // A different client can't use the old sign-in.
                s.refresh_token = None;
                s.email = None;
                s.name = None;
            }
            s.client_id = Some(id);
            s.client_secret = Some(client_secret.trim().to_string()).filter(|x| !x.is_empty());
        })?;
        if changed {
            *self.access.lock().unwrap() = None;
        }
        Ok(self.status())
    }

    pub fn set_auto(&self, auto: bool) -> Res<DriveStatus> {
        self.update(|s| s.auto = auto)?;
        Ok(self.status())
    }

    /// Opens Google's consent page in the browser and waits (up to 3 minutes)
    /// for it to come back to a one-time local address.
    pub fn connect(&self) -> Res<DriveStatus> {
        let (client_id, client_secret) =
            self.client().ok_or_else(|| err("invalid", "Add your Google OAuth client ID in Settings → Google Drive first."))?;
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| err("storage", format!("Couldn't open a local port: {e}")))?;
        let port = listener.local_addr().map_err(|e| err("storage", e.to_string()))?.port();
        let redirect = format!("http://127.0.0.1:{port}");
        let verifier = format!("{}{}{}", things_cloud::id::new_id(), things_cloud::id::new_id(), things_cloud::id::new_id());
        let challenge = b64url(&Sha256::digest(verifier.as_bytes()));
        let state = things_cloud::id::new_id();
        let url = format!(
            "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code&scope={}&code_challenge={}&code_challenge_method=S256&access_type=offline&prompt=consent&state={}",
            urlencode(&client_id),
            urlencode(&redirect),
            urlencode(SCOPES),
            challenge,
            state
        );
        open_in_browser(&url)?;

        let code = wait_for_code(&listener, &state, "Google Drive")?;
        let resp: Value = http()
            .post("https://oauth2.googleapis.com/token")
            .form(&[
                ("code", code.as_str()),
                ("client_id", client_id.as_str()),
                ("client_secret", client_secret.as_str()),
                ("redirect_uri", redirect.as_str()),
                ("grant_type", "authorization_code"),
                ("code_verifier", verifier.as_str()),
            ])
            .send()
            .and_then(|r| r.json())
            .map_err(|e| err("sync", format!("Couldn't reach Google: {e}")))?;
        let refresh = resp["refresh_token"].as_str().ok_or_else(|| {
            err("rejected", format!("Google didn't grant access: {}", resp["error_description"].as_str().or(resp["error"].as_str()).unwrap_or("no refresh token")))
        })?;
        let access = resp["access_token"].as_str().unwrap_or_default().to_string();
        let expires = resp["expires_in"].as_u64().unwrap_or(3000);
        *self.access.lock().unwrap() = Some(Access { token: access, expires: Instant::now() + Duration::from_secs(expires.saturating_sub(60)) });
        self.update(|s| {
            s.refresh_token = Some(refresh.to_string());
            s.folder_id = None;
            s.latest_id = None;
        })?;
        if let Ok(about) = self.get_json("https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress)") {
            self.update(|s| {
                s.email = about["user"]["emailAddress"].as_str().map(str::to_string);
                s.name = about["user"]["displayName"].as_str().map(str::to_string);
            })?;
        }
        *self.last_error.lock().unwrap() = None;
        *self.last_hash.lock().unwrap() = None;
        Ok(self.status())
    }

    pub fn disconnect(&self) -> Res<DriveStatus> {
        let revoked = self.load().refresh_token.map(|t| revoke(&t)).unwrap_or(Ok(()));
        self.update(|s| {
            s.refresh_token = None;
            s.email = None;
            s.name = None;
            s.folder_id = None;
            s.latest_id = None;
            s.last_backup_at = None;
        })?;
        *self.access.lock().unwrap() = None;
        *self.last_hash.lock().unwrap() = None;
        // Signed out on this PC either way; say so if Google didn't confirm the revoke.
        *self.last_error.lock().unwrap() = revoked.err().map(|e| {
            format!("Disconnected on this PC, but Google didn't confirm that access was removed ({e}). You can remove Things 3 at myaccount.google.com/permissions.")
        });
        Ok(self.status())
    }

    fn token(&self) -> Res<String> {
        if let Some(a) = self.access.lock().unwrap().as_ref() {
            if a.expires > Instant::now() {
                return Ok(a.token.clone());
            }
        }
        let refresh = self.load().refresh_token.ok_or_else(|| err("noAccount", "Connect Google Drive in Settings first."))?;
        let (client_id, client_secret) = self.client().ok_or_else(|| err("noAccount", "Google Drive isn't set up."))?;
        let resp: Value = http()
            .post("https://oauth2.googleapis.com/token")
            .form(&[("client_id", client_id.as_str()), ("client_secret", client_secret.as_str()), ("refresh_token", refresh.as_str()), ("grant_type", "refresh_token")])
            .send()
            .and_then(|r| r.json())
            .map_err(|e| err("offline", format!("Couldn't reach Google: {e}")))?;
        let Some(token) = resp["access_token"].as_str() else {
            if resp["error"] == "invalid_grant" {
                let _ = self.update(|s| s.refresh_token = None);
                return Err(err("noAccount", "Google Drive access expired or was removed. Reconnect it in Settings."));
            }
            return Err(err("sync", "Google didn't accept the sign-in. Try reconnecting Google Drive."));
        };
        let expires = resp["expires_in"].as_u64().unwrap_or(3000);
        *self.access.lock().unwrap() = Some(Access { token: token.to_string(), expires: Instant::now() + Duration::from_secs(expires.saturating_sub(60)) });
        Ok(token.to_string())
    }

    fn check(r: reqwest::blocking::Response) -> Res<reqwest::blocking::Response> {
        let status = r.status();
        if status.is_success() {
            return Ok(r);
        }
        let v: Value = r.json().unwrap_or(Value::Null);
        let msg = v["error"]["message"].as_str().unwrap_or("Google Drive returned an error").to_string();
        Err(err(if status.as_u16() == 404 { "notFound" } else { "sync" }, msg))
    }

    fn get_json(&self, url: &str) -> Res<Value> {
        let r = http().get(url).bearer_auth(self.token()?).send().map_err(|e| err("offline", format!("Couldn't reach Google Drive: {e}")))?;
        Self::check(r)?.json().map_err(|e| err("sync", e.to_string()))
    }

    /// The app's "Things 3" folder, created on first use.
    fn folder(&self) -> Res<String> {
        if let Some(id) = self.load().folder_id {
            match self.get_json(&format!("https://www.googleapis.com/drive/v3/files/{id}?fields=id,trashed")) {
                Ok(v) if v["trashed"] != true => return Ok(id),
                Ok(_) | Err(_) => {}
            }
        }
        let q = format!("name = '{FOLDER}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false");
        let found = self.get_json(&format!("https://www.googleapis.com/drive/v3/files?q={}&fields=files(id)&pageSize=1", urlencode(&q)))?;
        let id = match found["files"][0]["id"].as_str() {
            Some(id) => id.to_string(),
            None => {
                let r = http()
                    .post("https://www.googleapis.com/drive/v3/files?fields=id")
                    .bearer_auth(self.token()?)
                    .json(&json!({ "name": FOLDER, "mimeType": "application/vnd.google-apps.folder" }))
                    .send()
                    .map_err(|e| err("offline", e.to_string()))?;
                let v: Value = Self::check(r)?.json().map_err(|e| err("sync", e.to_string()))?;
                v["id"].as_str().unwrap_or_default().to_string()
            }
        };
        self.update(|s| {
            s.folder_id = Some(id.clone());
            s.latest_id = None;
        })?;
        Ok(id)
    }

    fn create_file(&self, folder: &str, name: &str, body: &[u8]) -> Res<String> {
        let boundary = format!("things3-{}", things_cloud::id::new_id());
        let meta = json!({ "name": name, "parents": [folder], "mimeType": "application/json" }).to_string();
        let mut payload = Vec::with_capacity(body.len() + 512);
        write!(payload, "--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{meta}\r\n--{boundary}\r\nContent-Type: application/json\r\n\r\n").ok();
        payload.extend_from_slice(body);
        write!(payload, "\r\n--{boundary}--").ok();
        let r = http()
            .post("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id")
            .bearer_auth(self.token()?)
            .header("Content-Type", format!("multipart/related; boundary={boundary}"))
            .body(payload)
            .send()
            .map_err(|e| err("offline", format!("Couldn't reach Google Drive: {e}")))?;
        let v: Value = Self::check(r)?.json().map_err(|e| err("sync", e.to_string()))?;
        Ok(v["id"].as_str().unwrap_or_default().to_string())
    }

    fn replace_file(&self, id: &str, body: &[u8]) -> Res<()> {
        let r = http()
            .patch(format!("https://www.googleapis.com/upload/drive/v3/files/{id}?uploadType=media"))
            .bearer_auth(self.token()?)
            .header("Content-Type", "application/json")
            .body(body.to_vec())
            .send()
            .map_err(|e| err("offline", format!("Couldn't reach Google Drive: {e}")))?;
        Self::check(r).map(|_| ())
    }

    /// Every file in the backup folder, newest first (all pages, so pruning sees them all).
    pub fn list(&self) -> Res<Vec<BackupFile>> {
        let folder = self.folder()?;
        let q = format!("'{folder}' in parents and trashed = false");
        let mut out = Vec::new();
        let mut page: Option<String> = None;
        for _ in 0..50 {
            let mut url = format!(
                "https://www.googleapis.com/drive/v3/files?q={}&orderBy={}&pageSize=1000&fields=nextPageToken,files(id,name,modifiedTime,size)",
                urlencode(&q),
                urlencode("modifiedTime desc")
            );
            if let Some(p) = &page {
                url.push_str(&format!("&pageToken={}", urlencode(p)));
            }
            let v = self.get_json(&url)?;
            out.extend(v["files"].as_array().into_iter().flatten().map(|f| BackupFile {
                id: f["id"].as_str().unwrap_or_default().to_string(),
                name: f["name"].as_str().unwrap_or_default().to_string(),
                modified_time: f["modifiedTime"].as_str().map(str::to_string),
                size: f["size"].as_str().and_then(|s| s.parse().ok()),
                latest: f["name"] == LATEST,
            }));
            match v["nextPageToken"].as_str() {
                Some(next) if Some(next) != page.as_deref() => page = Some(next.to_string()),
                _ => break,
            }
        }
        Ok(out)
    }

    pub fn download(&self, id: &str) -> Res<Vec<u8>> {
        if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            return Err(err("invalid", "Unknown backup."));
        }
        let r = http()
            .get(format!("https://www.googleapis.com/drive/v3/files/{id}?alt=media"))
            .bearer_auth(self.token()?)
            .send()
            .map_err(|e| err("offline", format!("Couldn't reach Google Drive: {e}")))?;
        Ok(Self::check(r)?.bytes().map_err(|e| err("sync", e.to_string()))?.to_vec())
    }

    fn delete(&self, id: &str) -> Res<()> {
        let r = http()
            .delete(format!("https://www.googleapis.com/drive/v3/files/{id}"))
            .bearer_auth(self.token()?)
            .send()
            .map_err(|e| err("offline", e.to_string()))?;
        Self::check(r).map(|_| ())
    }

    /// Uploads a backup if it changed (or `force`): replaces Latest, adds
    /// today's snapshot once a day and trims old ones.
    pub fn back_up(&self, body: &[u8], force: bool) -> Res<bool> {
        let hash = b64url(&Sha256::digest(body));
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        let daily = format!("{DAILY_PREFIX}{today}.json");
        // One upload at a time. An automatic backup skips its turn rather than
        // queue an older copy; the next check (20 s later) uploads the newest data.
        let _upload = if force {
            self.backup_lock.lock().unwrap_or_else(|p| p.into_inner())
        } else {
            match self.backup_lock.try_lock() {
                Ok(g) => g,
                Err(std::sync::TryLockError::WouldBlock) => return Err(err("busy", "A backup is already running.")),
                Err(std::sync::TryLockError::Poisoned(p)) => p.into_inner(),
            }
        };
        if !force && self.last_hash.lock().unwrap().as_deref() == Some(hash.as_str()) {
            return Ok(false);
        }
        *self.busy.lock().unwrap() = true;
        let result = (|| {
            let folder = self.folder()?;
            let files = self.list()?;
            // Latest: update in place so links to it keep working.
            match files.iter().find(|f| f.latest) {
                Some(f) => self.replace_file(&f.id, body)?,
                None => {
                    let id = self.create_file(&folder, LATEST, body)?;
                    self.update(|s| s.latest_id = Some(id))?;
                }
            }
            // Today's snapshot: first backup of the day creates it, later ones update it.
            match files.iter().find(|f| f.name == daily) {
                Some(f) => self.replace_file(&f.id, body)?,
                None => {
                    self.create_file(&folder, &daily, body)?;
                }
            }
            // Keep the newest KEEP_DAYS daily snapshots.
            let mut dailies: Vec<&BackupFile> = files.iter().filter(|f| !f.latest && f.name.starts_with(DAILY_PREFIX) && f.name != daily).collect();
            dailies.sort_by(|a, b| b.name.cmp(&a.name));
            let failed = dailies.into_iter().skip(KEEP_DAYS.saturating_sub(1)).filter(|old| self.delete(&old.id).is_err()).count();
            if failed > 0 {
                log::warn!("drive: {failed} old daily backup(s) could not be removed");
            }
            Ok::<_, Value>(())
        })();
        *self.busy.lock().unwrap() = false;
        match result {
            Ok(()) => {
                *self.last_hash.lock().unwrap() = Some(hash);
                *self.last_error.lock().unwrap() = None;
                self.update(|s| s.last_backup_at = Some(now_ms()))?;
                Ok(true)
            }
            Err(e) => {
                *self.last_error.lock().unwrap() = e["message"].as_str().map(str::to_string);
                Err(e)
            }
        }
    }

    /// True until a backup has succeeded since the app started or the account
    /// changed, so the caller uploads even when its data hasn't changed.
    pub fn needs_upload(&self) -> bool {
        self.last_hash.lock().unwrap().is_none()
    }

    /// Ready for an automatic backup: connected and switched on.
    pub fn auto_ready(&self) -> bool {
        let s = self.load();
        s.auto && s.refresh_token.is_some() && self.client().is_some()
    }
}

const DONE_PAGE: &str = r#"<!doctype html><meta charset="utf-8"><title>Things 3</title>
<style>body{font:15px system-ui,-apple-system,"Segoe UI",sans-serif;background:#f5f5f7;color:#1d1d1f;display:grid;place-items:center;height:100vh;margin:0}
.c{background:#fff;padding:32px 40px;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.08);text-align:center;max-width:360px}
h1{font-size:19px;margin:0 0 8px}p{color:#6e6e73;margin:0}@media(prefers-color-scheme:dark){body{background:#1e1e1e;color:#eee}.c{background:#2a2a2c}p{color:#aaa}}</style>
<div class="c"><h1>%TITLE%</h1><p>%BODY%</p></div>"#;

fn respond(stream: &mut std::net::TcpStream, title: &str, body: &str) {
    let page = DONE_PAGE.replace("%TITLE%", title).replace("%BODY%", body);
    let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{page}", page.len());
}

/// Waits for Google to send the browser back with `?code=…&state=…`.
/// `product` names what is being connected on the page the browser shows.
pub(crate) fn wait_for_code(listener: &TcpListener, state: &str, product: &str) -> Res<String> {
    listener.set_nonblocking(true).map_err(|e| err("storage", e.to_string()))?;
    let deadline = Instant::now() + Duration::from_secs(180);
    while Instant::now() < deadline {
        match listener.accept() {
            Ok((mut stream, _)) => {
                let _ = stream.set_nonblocking(false);
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                let path = req.split_whitespace().nth(1).unwrap_or("");
                let query = path.split_once('?').map(|(_, q)| q).unwrap_or("");
                let param = |k: &str| query.split('&').find_map(|kv| kv.split_once('=').filter(|(a, _)| *a == k).map(|(_, v)| percent_decode(v)));
                // Only the browser we sent to Google carries our `state`. Anything
                // else (another program, a favicon request) is ignored, errors included.
                if param("state").as_deref() != Some(state) {
                    respond(&mut stream, "Things 3", "Waiting for Google…");
                    continue;
                }
                if let Some(e) = param("error") {
                    respond(&mut stream, &format!("{product} wasn't connected"), "You can close this tab and try again in Things 3.");
                    return Err(err("rejected", if e == "access_denied" { format!("You declined access to {product}.") } else { format!("Google returned: {e}") }));
                }
                match param("code") {
                    Some(code) => {
                        respond(&mut stream, &format!("{product} is connected"), "You can close this tab and go back to Things 3.");
                        return Ok(code);
                    }
                    None => respond(&mut stream, "Things 3", "Waiting for Google…"),
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(150)),
            Err(e) => return Err(err("storage", e.to_string())),
        }
    }
    Err(err("uncertain", "Timed out waiting for Google. Try connecting again."))
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                // Read the two hex digits as bytes: slicing the str could split a multi-byte character and panic.
                if let Some(v) = std::str::from_utf8(&bytes[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                    out.push(v);
                    i += 3;
                    continue;
                }
                out.push(b'%');
            }
            b'+' => out.push(b' '),
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_and_decodes() {
        assert_eq!(urlencode("a b/c"), "a%20b%2Fc");
        assert_eq!(percent_decode("4%2F0Ab%2Bx"), "4/0Ab+x");
        assert_eq!(percent_decode("a+b"), "a b");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%aé%41"), "%aéA", "a % followed by half a character must not panic");
    }

    #[test]
    fn pkce_challenge_is_base64url_sha256() {
        // RFC 7636 appendix B.
        let v = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(b64url(&Sha256::digest(v.as_bytes())), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }
}
