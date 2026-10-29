//! Google Calendar side panel: a read-only view of the user's calendars.
//!
//! Deliberately separate from the to-do side of the app: it has its own
//! Google sign-in (scope `calendar.readonly` — the app can never change an
//! event), its own Credential Manager entry and its own on-disk cache. Nothing
//! here touches Things Cloud, and nothing in the sync engine knows it exists.
//!
//! Sign-in reuses the installed-app flow from the Drive backup (PKCE and a
//! one-time loopback redirect). The last events seen are kept in
//! `%LOCALAPPDATA%\…\calendar-cache.json` so the panel opens instantly and
//! works offline; disconnecting deletes it.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::drive::{b64url, http, open_in_browser, revoke, urlencode, wait_for_code};

const SERVICE: &str = "Things 3 (Google Calendar)";
const ACCOUNT: &str = "google-calendar";
const SCOPES: &str = "openid email https://www.googleapis.com/auth/calendar.readonly";
const API: &str = "https://www.googleapis.com/calendar/v3";
/// Cached events further than this from today are dropped.
const CACHE_DAYS: i64 = 400;
/// Calendars fetched side by side for one request.
const WORKERS: usize = 4;
/// Requests to Google in flight at once, across every month being loaded.
const MAX_IN_FLIGHT: usize = 6;
/// Pages (of up to 2500 events) read per calendar and range before giving up.
const MAX_PAGES: usize = 20;

/// Same build-time client as Drive, if the app was built with one.
const BUILT_IN_CLIENT_ID: Option<&str> = option_env!("TINGS3_GOOGLE_CLIENT_ID");
const BUILT_IN_CLIENT_SECRET: Option<&str> = option_env!("TINGS3_GOOGLE_CLIENT_SECRET");

type Res<T> = Result<T, Value>;

fn err(code: &str, message: impl Into<String>) -> Value {
    json!({ "code": code, "message": message.into() })
}

// ---------- colours ----------
//
// Google's API still reports colours from its original ("classic") palette,
// but calendar.google.com shows a newer, deeper version of each one. These
// tables translate, so the panel matches what the user sees in Google Calendar.
// A calendar with a custom colour keeps exactly that colour.

/// Event colours: colorId → colour shown in Google Calendar today.
const EVENT_COLORS: [(&str, &str, &str); 11] = [
    ("1", "#a4bdfc", "#7986cb"),  // Lavender
    ("2", "#7ae7bf", "#33b679"),  // Sage
    ("3", "#dbadff", "#8e24aa"),  // Grape
    ("4", "#ff887c", "#e67c73"),  // Flamingo
    ("5", "#fbd75b", "#f6bf26"),  // Banana
    ("6", "#ffb878", "#f4511e"),  // Tangerine
    ("7", "#46d6db", "#039be5"),  // Peacock
    ("8", "#e1e1e1", "#616161"),  // Graphite
    ("9", "#5484ed", "#3f51b5"),  // Blueberry
    ("10", "#51b749", "#0b8043"), // Basil
    ("11", "#dc2127", "#d50000"), // Tomato
];

/// Calendar colours: colorId, classic hex the API returns, colour shown today.
const CALENDAR_COLORS: [(&str, &str, &str); 24] = [
    ("1", "#ac725e", "#795548"),  // Cocoa
    ("2", "#d06b64", "#e67c73"),  // Flamingo
    ("3", "#f83a22", "#d50000"),  // Tomato
    ("4", "#fa573c", "#f4511e"),  // Tangerine
    ("5", "#ff7537", "#ef6c00"),  // Pumpkin
    ("6", "#ffad46", "#f09300"),  // Mango
    ("7", "#42d692", "#009688"),  // Eucalyptus
    ("8", "#16a765", "#0b8043"),  // Basil
    ("9", "#7bd148", "#7cb342"),  // Pistachio
    ("10", "#b3dc6c", "#c0ca33"), // Avocado
    ("11", "#fbe983", "#e4c441"), // Citron
    ("12", "#fad165", "#f6bf26"), // Banana
    ("13", "#92e1c0", "#33b679"), // Sage
    ("14", "#9fe1e7", "#039be5"), // Peacock
    ("15", "#9fc6e7", "#4285f4"), // Cobalt
    ("16", "#4986e7", "#3f51b5"), // Blueberry
    ("17", "#9a9cff", "#7986cb"), // Lavender
    ("18", "#b99aff", "#b39ddb"), // Wisteria
    ("19", "#c2c2c2", "#616161"), // Graphite
    ("20", "#cabdbf", "#a79b8e"), // Birch
    ("21", "#cca6ac", "#ad1457"), // Radicchio
    ("22", "#f691b2", "#d81b60"), // Cherry Blossom
    ("23", "#cd74e6", "#8e24aa"), // Grape
    ("24", "#a47ae2", "#9e69af"), // Amethyst
];

/// The colour Google Calendar shows for an event's own colorId, if it has one.
fn event_color(color_id: &str) -> Option<&'static str> {
    EVENT_COLORS.iter().find(|(id, ..)| *id == color_id).map(|(_, _, shown)| *shown)
}

/// The colour Google Calendar shows for a calendar: its backgroundColor,
/// translated when it is one of the preset (classic) colours.
fn calendar_color(color_id: Option<&str>, background: Option<&str>) -> String {
    match background {
        Some(bg) => modern(bg),
        None => color_id
            .and_then(|id| CALENDAR_COLORS.iter().find(|(i, ..)| *i == id))
            .map(|(_, _, shown)| shown.to_string())
            .unwrap_or_else(|| "#4285f4".into()),
    }
}

/// Translates any classic palette colour to today's; other colours pass through.
fn modern(hex: &str) -> String {
    let hex = hex.trim();
    CALENDAR_COLORS
        .iter()
        .chain(EVENT_COLORS.iter())
        .find(|(_, classic, _)| classic.eq_ignore_ascii_case(hex))
        .map(|(_, _, shown)| shown.to_string())
        .unwrap_or_else(|| hex.to_ascii_lowercase())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalStatus {
    pub configured: bool,
    pub built_in_client: bool,
    pub connected: bool,
    pub email: Option<String>,
    /// Epoch ms of the last successful fetch from Google.
    pub last_sync_at: Option<i64>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarInfo {
    pub id: String,
    pub name: String,
    pub color: String,
    pub primary: bool,
    pub visible: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CalEvent {
    pub id: String,
    pub calendar_id: String,
    pub title: String,
    /// "YYYY-MM-DD" for all-day events (end is exclusive), RFC 3339 otherwise.
    pub start: String,
    pub end: String,
    pub all_day: bool,
    pub location: Option<String>,
    /// As Google stores it: plain text or simple HTML. The UI shows it as text.
    pub description: Option<String>,
    /// The event on calendar.google.com.
    pub link: Option<String>,
    /// Google Meet / video call link.
    pub meet: Option<String>,
    pub color: String,
    /// The user declined the invitation.
    pub declined: bool,
    /// Shows as "free" (doesn't block time).
    pub free: bool,
    pub organizer: Option<String>,
    pub attendees: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventsResult {
    pub events: Vec<CalEvent>,
    /// Google couldn't be reached; these come from the cache.
    pub stale: bool,
    /// Some calendars couldn't be fetched; their events come from the cache.
    pub partial: bool,
    pub fetched_at: Option<i64>,
}

/// Secrets and preferences, kept together in Credential Manager.
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Stored {
    client_id: Option<String>,
    client_secret: Option<String>,
    refresh_token: Option<String>,
    email: Option<String>,
    /// Calendars the user turned on or off in the panel (otherwise Google's own choice).
    visibility: HashMap<String, bool>,
}

/// What's on disk: no secrets, just what to show offline.
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Cache {
    calendars: Vec<CalendarInfo>,
    /// Events by "calendarId\u{1f}eventId".
    events: BTreeMap<String, CalEvent>,
    fetched_at: Option<i64>,
}

struct Access {
    token: String,
    expires: Instant,
}

/// Caps the number of requests to Google in flight at once.
struct Gate {
    busy: Mutex<usize>,
    freed: Condvar,
}

struct GatePass<'a>(&'a Gate);

impl Gate {
    fn enter(&self) -> GatePass<'_> {
        let mut n = self.busy.lock().unwrap_or_else(|p| p.into_inner());
        while *n >= MAX_IN_FLIGHT {
            n = self.freed.wait(n).unwrap_or_else(|p| p.into_inner());
        }
        *n += 1;
        GatePass(self)
    }
}

impl Drop for GatePass<'_> {
    fn drop(&mut self) {
        *self.0.busy.lock().unwrap_or_else(|p| p.into_inner()) -= 1;
        self.0.freed.notify_one();
    }
}

pub struct GCal {
    cache_path: PathBuf,
    stored: Mutex<Option<Stored>>,
    /// Serializes read-modify-write of the stored record.
    update_lock: Mutex<()>,
    access: Mutex<Option<Access>>,
    cache: Mutex<Option<Cache>>,
    /// Serializes cache writes to disk.
    cache_write: Mutex<()>,
    last_error: Mutex<Option<String>>,
    /// Changes on connect, disconnect and client change. A fetch that started
    /// under an older account doesn't write into the new account's cache.
    account_gen: AtomicU64,
    gate: Gate,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn str_of(v: &Value) -> Option<String> {
    v.as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

/// Converts one item from Google's events list. Cancelled items are skipped.
fn parse_event(calendar: &CalendarInfo, item: &Value) -> Option<CalEvent> {
    if item["status"] == "cancelled" {
        return None;
    }
    let (start, end, all_day) = match (str_of(&item["start"]["dateTime"]), str_of(&item["start"]["date"])) {
        (Some(s), _) => (s, str_of(&item["end"]["dateTime"])?, false),
        (None, Some(d)) => (d, str_of(&item["end"]["date"])?, true),
        _ => return None,
    };
    let me = item["attendees"].as_array().and_then(|a| a.iter().find(|x| x["self"] == true));
    Some(CalEvent {
        id: str_of(&item["id"])?,
        calendar_id: calendar.id.clone(),
        title: str_of(&item["summary"]).unwrap_or_else(|| "(No title)".into()),
        start,
        end,
        all_day,
        location: str_of(&item["location"]),
        description: str_of(&item["description"]),
        link: str_of(&item["htmlLink"]).filter(|l| l.starts_with("https://")),
        meet: str_of(&item["hangoutLink"]).filter(|l| l.starts_with("https://")),
        // An event's own colour wins; otherwise it shows in its calendar's colour.
        color: item["colorId"].as_str().and_then(event_color).map(str::to_string).unwrap_or_else(|| calendar.color.clone()),
        declined: me.is_some_and(|m| m["responseStatus"] == "declined"),
        free: item["transparency"] == "transparent",
        organizer: str_of(&item["organizer"]["displayName"]).or_else(|| str_of(&item["organizer"]["email"])).filter(|_| item["organizer"]["self"] != true),
        attendees: item["attendees"].as_array().map(|a| a.len() as u32).unwrap_or(0),
    })
}

/// Start/end of an event as UTC instants, for range checks on cached events.
fn bounds(e: &CalEvent) -> Option<(chrono::DateTime<chrono::Utc>, chrono::DateTime<chrono::Utc>)> {
    let parse = |s: &str| -> Option<chrono::DateTime<chrono::Utc>> {
        if e.all_day {
            let d = chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()?;
            Some(d.and_hms_opt(0, 0, 0)?.and_utc())
        } else {
            chrono::DateTime::parse_from_rfc3339(s).ok().map(|d| d.with_timezone(&chrono::Utc))
        }
    };
    Some((parse(&e.start)?, parse(&e.end)?))
}

fn overlaps(e: &CalEvent, min: chrono::DateTime<chrono::Utc>, max: chrono::DateTime<chrono::Utc>) -> bool {
    // All-day dates have no time zone; a day of slack on each side keeps them
    // from falling off the edge of a range, and the UI places them by date.
    let slack = if e.all_day { chrono::Duration::days(1) } else { chrono::Duration::zero() };
    bounds(e).is_some_and(|(s, en)| s - slack < max && en + slack > min)
}

fn key(e: &CalEvent) -> String {
    format!("{}\u{1f}{}", e.calendar_id, e.id)
}

/// Writes `body` beside `path` under a unique name, flushes it, then renames it into place.
fn write_atomic(path: &std::path::Path, body: &[u8]) -> std::io::Result<()> {
    crate::settings::write_flushed(path, body)
}

impl GCal {
    pub fn new(data_dir: PathBuf) -> Self {
        GCal {
            cache_path: data_dir.join("calendar-cache.json"),
            stored: Mutex::new(None),
            update_lock: Mutex::new(()),
            access: Mutex::new(None),
            cache: Mutex::new(None),
            cache_write: Mutex::new(()),
            last_error: Mutex::new(None),
            account_gen: AtomicU64::new(0),
            gate: Gate { busy: Mutex::new(0), freed: Condvar::new() },
        }
    }

    // ---------- secrets ----------

    fn entry() -> Res<keyring::Entry> {
        keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| err("storage", format!("Secure storage is unavailable: {e}")))
    }

    fn load(&self) -> Stored {
        let mut slot = self.stored.lock().unwrap();
        if slot.is_none() {
            let s = Self::entry().ok().and_then(|e| e.get_password().ok()).and_then(|raw| serde_json::from_str::<Stored>(&raw).ok()).unwrap_or_default();
            *slot = Some(s);
        }
        slot.clone().unwrap_or_default()
    }

    fn update(&self, f: impl FnOnce(&mut Stored)) -> Res<()> {
        // One change at a time, so two quick changes can't overwrite each other.
        let _one = self.update_lock.lock().unwrap_or_else(|p| p.into_inner());
        let mut s = self.load();
        f(&mut s);
        let raw = serde_json::to_string(&s).unwrap_or_default();
        Self::entry()?.set_password(&raw).map_err(|e| err("storage", format!("Couldn't save to Credential Manager: {e}")))?;
        *self.stored.lock().unwrap() = Some(s);
        Ok(())
    }

    fn client(&self) -> Option<(String, String)> {
        let s = self.load();
        match (s.client_id, BUILT_IN_CLIENT_ID) {
            (Some(id), _) if !id.is_empty() => Some((id, s.client_secret.unwrap_or_default())),
            (_, Some(id)) => Some((id.to_string(), BUILT_IN_CLIENT_SECRET.unwrap_or_default().to_string())),
            _ => None,
        }
    }

    fn new_account_gen(&self) {
        self.account_gen.fetch_add(1, Ordering::AcqRel);
    }

    // ---------- cache ----------

    fn with_cache<T>(&self, f: impl FnOnce(&mut Cache) -> T) -> T {
        let mut slot = self.cache.lock().unwrap();
        if slot.is_none() {
            let mut cache: Cache = std::fs::read(&self.cache_path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
            // Caches written before colours were translated hold classic colours.
            for c in &mut cache.calendars {
                c.color = modern(&c.color);
            }
            for e in cache.events.values_mut() {
                e.color = modern(&e.color);
            }
            *slot = Some(cache);
        }
        f(slot.as_mut().unwrap())
    }

    fn save_cache(&self) {
        let _one = self.cache_write.lock().unwrap_or_else(|p| p.into_inner());
        let body = self.with_cache(|c| serde_json::to_vec(c).unwrap_or_default());
        if let Err(e) = write_atomic(&self.cache_path, &body) {
            log::warn!("calendar: could not save the cache: {e}");
        }
    }

    // ---------- account ----------

    pub fn status(&self) -> CalStatus {
        let s = self.load();
        CalStatus {
            configured: self.client().is_some(),
            built_in_client: BUILT_IN_CLIENT_ID.is_some(),
            connected: s.refresh_token.is_some(),
            email: s.email,
            last_sync_at: self.with_cache(|c| c.fetched_at),
            last_error: self.last_error.lock().unwrap().clone(),
        }
    }

    pub fn set_client(&self, client_id: String, client_secret: String) -> Res<CalStatus> {
        let id = client_id.trim().to_string();
        if !id.ends_with(".apps.googleusercontent.com") {
            return Err(err("invalid", "That doesn't look like a Google OAuth client ID (it ends with .apps.googleusercontent.com)."));
        }
        let changed = self.load().client_id.as_deref() != Some(id.as_str());
        self.update(|s| {
            if changed {
                s.refresh_token = None;
                s.email = None;
            }
            s.client_id = Some(id);
            s.client_secret = Some(client_secret.trim().to_string()).filter(|x| !x.is_empty());
        })?;
        if changed {
            self.new_account_gen();
            *self.access.lock().unwrap() = None;
        }
        Ok(self.status())
    }

    /// Opens Google's consent page and waits (up to 3 minutes) for the browser to come back.
    pub fn connect(&self) -> Res<CalStatus> {
        let (client_id, client_secret) = self.client().ok_or_else(|| err("invalid", "Add your Google OAuth client ID first."))?;
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
        let code = wait_for_code(&listener, &state, "Google Calendar")?;
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
            .map_err(|e| err("offline", format!("Couldn't reach Google: {e}")))?;
        let refresh = resp["refresh_token"].as_str().ok_or_else(|| {
            err("rejected", format!("Google didn't grant access: {}", resp["error_description"].as_str().or(resp["error"].as_str()).unwrap_or("no refresh token")))
        })?;
        let granted = resp["scope"].as_str().unwrap_or(SCOPES);
        if !granted.contains("calendar.readonly") {
            return Err(err("rejected", "Calendar access wasn't granted. Connect again and tick “See your calendars”."));
        }
        self.new_account_gen();
        self.set_access(&resp);
        let email = self.get_json("https://openidconnect.googleapis.com/v1/userinfo").ok().and_then(|v| str_of(&v["email"]));
        self.update(|s| {
            s.refresh_token = Some(refresh.to_string());
            s.email = email;
        })?;
        // A different account's events must not linger.
        self.with_cache(|c| *c = Cache::default());
        self.save_cache();
        *self.last_error.lock().unwrap() = None;
        Ok(self.status())
    }

    pub fn disconnect(&self) -> Res<CalStatus> {
        let revoked = self.load().refresh_token.map(|t| revoke(&t)).unwrap_or(Ok(()));
        self.new_account_gen();
        self.update(|s| {
            s.refresh_token = None;
            s.email = None;
            s.visibility.clear();
        })?;
        *self.access.lock().unwrap() = None;
        self.with_cache(|c| *c = Cache::default());
        let removed = {
            let _one = self.cache_write.lock().unwrap_or_else(|p| p.into_inner());
            match std::fs::remove_file(&self.cache_path) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
                _ => Ok(()),
            }
        };
        // Signed out on this PC either way; say what didn't finish, if anything.
        let mut problems = Vec::new();
        if let Err(e) = revoked {
            problems.push(format!("Google didn't confirm that access was removed ({e}); you can remove it at myaccount.google.com/permissions"));
        }
        if let Err(e) = removed {
            problems.push(format!("the saved events couldn't be deleted from {} ({e})", self.cache_path.display()));
        }
        *self.last_error.lock().unwrap() = (!problems.is_empty()).then(|| format!("Disconnected on this PC, but {}.", problems.join(", and ")));
        Ok(self.status())
    }

    fn set_access(&self, resp: &Value) {
        let token = resp["access_token"].as_str().unwrap_or_default().to_string();
        let expires = resp["expires_in"].as_u64().unwrap_or(3000);
        *self.access.lock().unwrap() = Some(Access { token, expires: Instant::now() + Duration::from_secs(expires.saturating_sub(60)) });
    }

    fn token(&self) -> Res<String> {
        if let Some(a) = self.access.lock().unwrap().as_ref() {
            if a.expires > Instant::now() {
                return Ok(a.token.clone());
            }
        }
        let gen = self.account_gen.load(Ordering::Acquire);
        let refresh = self.load().refresh_token.ok_or_else(|| err("noAccount", "Connect Google Calendar first."))?;
        let (client_id, client_secret) = self.client().ok_or_else(|| err("noAccount", "Google Calendar isn't set up."))?;
        let resp: Value = http()
            .post("https://oauth2.googleapis.com/token")
            .form(&[("client_id", client_id.as_str()), ("client_secret", client_secret.as_str()), ("refresh_token", refresh.as_str()), ("grant_type", "refresh_token")])
            .send()
            .and_then(|r| r.json())
            .map_err(|e| err("offline", format!("Couldn't reach Google: {e}")))?;
        if gen != self.account_gen.load(Ordering::Acquire) {
            return Err(err("noAccount", "The Google account changed. Try again."));
        }
        if resp["access_token"].as_str().is_none() {
            if resp["error"] == "invalid_grant" {
                let _ = self.update(|s| s.refresh_token = None);
                return Err(err("noAccount", "Calendar access expired or was removed. Connect Google Calendar again."));
            }
            return Err(err("sync", "Google didn't accept the sign-in. Try connecting Google Calendar again."));
        }
        self.set_access(&resp);
        Ok(resp["access_token"].as_str().unwrap_or_default().to_string())
    }

    fn get_json(&self, url: &str) -> Res<Value> {
        let token = self.token()?;
        let _pass = self.gate.enter();
        get_google_json(&token, url)
    }

    fn remember_error<T>(&self, r: &Res<T>) {
        *self.last_error.lock().unwrap() = r.as_ref().err().and_then(|e| e["message"].as_str().map(str::to_string));
    }

    // ---------- calendars ----------

    /// The user's calendars, freshly from Google, or from the cache when offline.
    pub fn calendars(&self) -> Res<Vec<CalendarInfo>> {
        let fresh = self.fetch_calendars();
        self.remember_error(&fresh);
        match fresh {
            Ok(list) => Ok(list),
            Err(e) if e["code"] == "offline" => {
                let cached = self.with_cache(|c| c.calendars.clone());
                if cached.is_empty() {
                    Err(e)
                } else {
                    Ok(cached)
                }
            }
            Err(e) => Err(e),
        }
    }

    fn fetch_calendars(&self) -> Res<Vec<CalendarInfo>> {
        let gen = self.account_gen.load(Ordering::Acquire);
        let vis = self.load().visibility;
        let mut out = Vec::new();
        let mut page: Option<String> = None;
        for _ in 0..MAX_PAGES {
            let mut url = format!("{API}/users/me/calendarList?maxResults=250&minAccessRole=reader&fields=items(id,summary,summaryOverride,colorId,backgroundColor,primary,selected,hidden),nextPageToken");
            if let Some(p) = &page {
                url.push_str(&format!("&pageToken={}", urlencode(p)));
            }
            let v = self.get_json(&url)?;
            for c in v["items"].as_array().into_iter().flatten() {
                let Some(id) = str_of(&c["id"]) else { continue };
                if c["hidden"] == true {
                    continue;
                }
                out.push(CalendarInfo {
                    name: str_of(&c["summaryOverride"]).or_else(|| str_of(&c["summary"])).unwrap_or_else(|| id.clone()),
                    color: calendar_color(c["colorId"].as_str(), c["backgroundColor"].as_str()),
                    primary: c["primary"] == true,
                    visible: vis.get(&id).copied().unwrap_or(c["selected"] == true || c["primary"] == true),
                    id,
                });
            }
            match str_of(&v["nextPageToken"]) {
                Some(next) if Some(&next) != page.as_ref() => page = Some(next),
                _ => {
                    page = None;
                    break;
                }
            }
        }
        if page.is_some() {
            return Err(err("sync", "Google returned more calendars than expected. Try again later."));
        }
        // Primary first, then by name.
        out.sort_by(|a, b| b.primary.cmp(&a.primary).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
        if gen != self.account_gen.load(Ordering::Acquire) {
            return Err(err("noAccount", "The Google account changed. Try again."));
        }
        self.with_cache(|c| c.calendars = out.clone());
        self.save_cache();
        Ok(out)
    }

    pub fn set_visible(&self, id: String, visible: bool) -> Res<Vec<CalendarInfo>> {
        self.update(|s| {
            s.visibility.insert(id.clone(), visible);
        })?;
        let list = self.with_cache(|c| {
            for cal in c.calendars.iter_mut().filter(|cal| cal.id == id) {
                cal.visible = visible;
            }
            c.calendars.clone()
        });
        self.save_cache();
        Ok(list)
    }

    // ---------- events ----------

    /// Events on the visible calendars between two RFC 3339 instants.
    /// When Google can't be reached, returns what the cache has (`stale`).
    pub fn events(&self, time_min: String, time_max: String) -> Res<EventsResult> {
        let min = chrono::DateTime::parse_from_rfc3339(&time_min).map_err(|_| err("invalid", "Bad start time."))?.with_timezone(&chrono::Utc);
        let max = chrono::DateTime::parse_from_rfc3339(&time_max).map_err(|_| err("invalid", "Bad end time."))?.with_timezone(&chrono::Utc);
        if max <= min || max - min > chrono::Duration::days(400) {
            return Err(err("invalid", "That date range is too long."));
        }
        let fresh = self.fetch_events(min, max);
        self.remember_error(&fresh.as_ref().map(|_| ()).map_err(Clone::clone));
        match fresh {
            Ok((events, failed)) => {
                if let Some(e) = &failed {
                    *self.last_error.lock().unwrap() = e["message"].as_str().map(|m| format!("Some calendars couldn't be updated: {m}"));
                }
                Ok(EventsResult { events, stale: false, partial: failed.is_some(), fetched_at: self.with_cache(|c| c.fetched_at) })
            }
            Err(e) if e["code"] == "offline" => {
                let visible: HashSet<String> = self.with_cache(|c| c.calendars.iter().filter(|c| c.visible).map(|c| c.id.clone()).collect());
                let events = self.cached_events(&visible, min, max);
                Ok(EventsResult { events, stale: true, partial: false, fetched_at: self.with_cache(|c| c.fetched_at) })
            }
            Err(e) => Err(e),
        }
    }

    fn cached_events(&self, calendars: &HashSet<String>, min: chrono::DateTime<chrono::Utc>, max: chrono::DateTime<chrono::Utc>) -> Vec<CalEvent> {
        self.with_cache(|c| c.events.values().filter(|ev| calendars.contains(&ev.calendar_id) && overlaps(ev, min, max)).cloned().collect())
    }

    /// Fresh events, plus the first error if some (not all) calendars failed.
    /// Failed calendars keep their cached events, so nothing vanishes because of one bad request.
    fn fetch_events(&self, min: chrono::DateTime<chrono::Utc>, max: chrono::DateTime<chrono::Utc>) -> Res<(Vec<CalEvent>, Option<Value>)> {
        let gen = self.account_gen.load(Ordering::Acquire);
        let token = self.token()?;
        let calendars = {
            let cached = self.with_cache(|c| c.calendars.clone());
            if cached.is_empty() {
                self.fetch_calendars()?
            } else {
                cached
            }
        };
        let visible: Vec<&CalendarInfo> = calendars.iter().filter(|c| c.visible).collect();
        let tmin = min.to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        let tmax = max.to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        // A few workers share the calendars; the gate caps requests across all months.
        let next = AtomicUsize::new(0);
        let results: Mutex<Vec<(usize, Res<Vec<CalEvent>>)>> = Mutex::new(Vec::with_capacity(visible.len()));
        std::thread::scope(|scope| {
            for _ in 0..visible.len().min(WORKERS) {
                scope.spawn(|| loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    let Some(cal) = visible.get(i) else { break };
                    let r = fetch_calendar_events(&self.gate, &token, cal, &tmin, &tmax);
                    results.lock().unwrap_or_else(|p| p.into_inner()).push((i, r));
                });
            }
        });
        let results = results.into_inner().unwrap_or_else(|p| p.into_inner());
        let mut events = Vec::new();
        let mut done: Vec<String> = Vec::new();
        let mut failed: HashSet<String> = HashSet::new();
        let mut first_err: Option<Value> = None;
        for (i, r) in results {
            let cal = visible[i];
            match r {
                Ok(mut list) => {
                    events.append(&mut list);
                    done.push(cal.id.clone());
                }
                // A calendar that disappeared shouldn't hide the others.
                Err(e) if e["code"] == "notFound" => done.push(cal.id.clone()),
                Err(e) => {
                    failed.insert(cal.id.clone());
                    first_err = first_err.or(Some(e));
                }
            }
        }
        if let Some(e) = &first_err {
            // Signed out, or nothing at all came back: report it rather than show a partial picture.
            if e["code"] == "noAccount" || done.is_empty() {
                return Err(e.clone());
            }
        }
        if gen != self.account_gen.load(Ordering::Acquire) {
            return Err(err("noAccount", "The Google account changed. Try again."));
        }
        events.extend(self.cached_events(&failed, min, max));
        events.sort_by(|a, b| a.start.cmp(&b.start));
        self.store_events(min, max, &events, &done);
        Ok((events, first_err))
    }

    /// Replaces the cached events of these (successfully fetched) calendars in this range.
    fn store_events(&self, min: chrono::DateTime<chrono::Utc>, max: chrono::DateTime<chrono::Utc>, events: &[CalEvent], calendars: &[String]) {
        let now = chrono::Utc::now();
        let horizon = chrono::Duration::days(CACHE_DAYS);
        self.with_cache(|c| {
            c.events.retain(|_, e| !(calendars.contains(&e.calendar_id) && overlaps(e, min, max)) && overlaps(e, now - horizon, now + horizon));
            for e in events.iter().filter(|e| calendars.contains(&e.calendar_id)) {
                c.events.insert(key(e), e.clone());
            }
            c.fetched_at = Some(now_ms());
        });
        self.save_cache();
    }
}

/// GET a Google API URL; errors are mapped to the panel's codes. A success
/// response that isn't valid JSON is an error, never an empty result.
fn get_google_json(token: &str, url: &str) -> Res<Value> {
    let r = http().get(url).bearer_auth(token).send().map_err(|e| err("offline", format!("Couldn't reach Google Calendar: {e}")))?;
    let status = r.status();
    if status.is_success() {
        return r.json().map_err(|e| err("sync", format!("Google Calendar sent a reply that couldn't be read: {e}")));
    }
    let v: Value = r.json().unwrap_or(Value::Null);
    let msg = v["error"]["message"].as_str().unwrap_or("Google Calendar returned an error").to_string();
    let code = match status.as_u16() {
        401 => "noAccount",
        403 if msg.contains("has not been used") || msg.contains("disabled") => "invalid",
        404 => "notFound",
        _ => "sync",
    };
    Err(err(code, msg))
}

fn fetch_calendar_events(gate: &Gate, token: &str, cal: &CalendarInfo, tmin: &str, tmax: &str) -> Res<Vec<CalEvent>> {
    let mut out = Vec::new();
    let mut page: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let mut url = format!(
            "{API}/calendars/{}/events?singleEvents=true&orderBy=startTime&maxResults=2500&timeMin={}&timeMax={}&fields={}",
            urlencode(&cal.id),
            urlencode(tmin),
            urlencode(tmax),
            urlencode("items(id,status,summary,description,location,htmlLink,hangoutLink,colorId,start,end,transparency,attendees(self,responseStatus),organizer(displayName,email,self)),nextPageToken")
        );
        if let Some(p) = &page {
            url.push_str(&format!("&pageToken={}", urlencode(p)));
        }
        let v = {
            let _pass = gate.enter();
            get_google_json(token, &url)?
        };
        let Some(items) = v["items"].as_array() else {
            return Err(err("sync", format!("Google Calendar sent an incomplete reply for {}.", cal.name)));
        };
        out.extend(items.iter().filter_map(|item| parse_event(cal, item)));
        match str_of(&v["nextPageToken"]) {
            Some(next) if Some(&next) != page.as_ref() => page = Some(next),
            Some(_) => return Err(err("sync", format!("Google Calendar kept repeating the same page for {}.", cal.name))),
            None => return Ok(out),
        }
    }
    // Never silently cut a calendar short: the caller keeps its cached events instead.
    Err(err("sync", format!("{} has too many events in this range to load.", cal.name)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cal() -> CalendarInfo {
        CalendarInfo { id: "me@example.com".into(), name: "Me".into(), color: "#039be5".into(), primary: true, visible: true }
    }

    #[test]
    fn parses_timed_and_all_day_events() {
        let timed = json!({
            "id": "a1", "status": "confirmed", "summary": " Standup ", "htmlLink": "https://www.google.com/calendar/event?eid=x",
            "start": { "dateTime": "2026-10-20T09:00:00-05:00" }, "end": { "dateTime": "2026-10-20T09:15:00-05:00" },
            "colorId": "11", "attendees": [{ "self": true, "responseStatus": "declined" }, { "email": "b@x.com" }],
            "organizer": { "email": "boss@example.com" }
        });
        let e = parse_event(&cal(), &timed).unwrap();
        assert_eq!(e.title, "Standup");
        assert!(!e.all_day);
        assert_eq!(e.color, "#d50000", "Tomato as Google Calendar shows it, not the API's classic #dc2127");
        assert!(e.declined);
        assert_eq!(e.attendees, 2);
        assert_eq!(e.organizer.as_deref(), Some("boss@example.com"));

        let all_day = json!({ "id": "b2", "start": { "date": "2026-10-21" }, "end": { "date": "2026-10-22" }, "transparency": "transparent", "htmlLink": "javascript:alert(1)" });
        let e = parse_event(&cal(), &all_day).unwrap();
        assert!(e.all_day && e.free);
        assert_eq!(e.title, "(No title)");
        assert_eq!(e.color, "#039be5", "no colorId: the calendar's colour");
        assert_eq!(e.link, None, "only https links are kept");

        assert!(parse_event(&cal(), &json!({ "id": "c", "status": "cancelled" })).is_none());
    }

    #[test]
    fn colours_match_google_calendar() {
        // Preset calendar colours arrive as classic hex values.
        assert_eq!(calendar_color(Some("14"), Some("#9fe1e7")), "#039be5"); // Peacock
        assert_eq!(calendar_color(Some("17"), Some("#9A9CFF")), "#7986cb"); // Lavender, any case
        assert_eq!(calendar_color(Some("24"), Some("#a47ae2")), "#9e69af"); // Amethyst
        // A custom colour stays exactly as chosen.
        assert_eq!(calendar_color(Some("14"), Some("#123ABC")), "#123abc");
        assert_eq!(calendar_color(Some("8"), None), "#0b8043");
        assert_eq!(calendar_color(None, None), "#4285f4");
        for (id, classic, shown) in EVENT_COLORS {
            assert_eq!(event_color(id), Some(shown));
            assert_eq!(modern(classic), shown, "cached classic colours are translated too");
        }
        assert_eq!(event_color("99"), None);
        // Translating twice changes nothing.
        for (_, _, shown) in CALENDAR_COLORS.iter().chain(EVENT_COLORS.iter()) {
            assert_eq!(modern(shown), *shown);
        }
    }

    #[test]
    fn range_overlap() {
        let mut e = parse_event(&cal(), &json!({ "id": "x", "start": { "dateTime": "2026-10-20T09:00:00Z" }, "end": { "dateTime": "2026-10-20T10:00:00Z" } })).unwrap();
        let t = |s: &str| chrono::DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&chrono::Utc);
        assert!(overlaps(&e, t("2026-10-20T00:00:00Z"), t("2026-10-21T00:00:00Z")));
        assert!(!overlaps(&e, t("2026-10-20T10:00:00Z"), t("2026-10-21T00:00:00Z")));
        e.all_day = true;
        e.start = "2026-10-25".into();
        e.end = "2026-10-26".into();
        assert!(overlaps(&e, t("2026-10-25T05:00:00Z"), t("2026-10-26T05:00:00Z")));
        assert!(!overlaps(&e, t("2026-11-01T00:00:00Z"), t("2026-11-02T00:00:00Z")));
    }

    #[test]
    fn a_failed_calendar_keeps_its_cached_events() {
        let dir = std::env::temp_dir().join(format!("gcal-test-{}", things_cloud::id::new_id()));
        let g = GCal::new(dir.clone());
        // Events today, so they sit inside the cache's time horizon.
        let start = chrono::Utc::now().format("%Y-%m-%dT09:00:00Z").to_string();
        let ev = |cal: &str, id: &str| CalEvent {
            id: id.into(),
            calendar_id: cal.into(),
            title: id.into(),
            start: start.clone(),
            end: start.replace("T09", "T10"),
            all_day: false,
            location: None,
            description: None,
            link: None,
            meet: None,
            color: "#039be5".into(),
            declined: false,
            free: false,
            organizer: None,
            attendees: 0,
        };
        let (keep, gone) = (ev("work", "standup"), ev("home", "old"));
        let (lo, hi) = (chrono::Utc::now() - chrono::Duration::days(1), chrono::Utc::now() + chrono::Duration::days(1));
        g.store_events(lo, hi, &[keep.clone(), gone], &["work".into(), "home".into()]);
        // Only "home" was fetched again (and is now empty); "work" failed and must keep its event.
        g.store_events(lo, hi, &[], &["home".into()]);
        let left = g.cached_events(&HashSet::from(["work".to_string(), "home".to_string()]), lo, hi);
        assert_eq!(left, vec![keep]);
        let _ = std::fs::remove_dir_all(dir);
    }
}
