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

use std::collections::{BTreeMap, HashMap};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::drive::{b64url, http, open_in_browser, urlencode, wait_for_code};

const SERVICE: &str = "Things 3 (Google Calendar)";
const ACCOUNT: &str = "google-calendar";
const SCOPES: &str = "openid email https://www.googleapis.com/auth/calendar.readonly";
const API: &str = "https://www.googleapis.com/calendar/v3";
/// Cached events further than this from today are dropped.
const CACHE_DAYS: i64 = 400;

/// Same build-time client as Drive, if the app was built with one.
const BUILT_IN_CLIENT_ID: Option<&str> = option_env!("TINGS3_GOOGLE_CLIENT_ID");
const BUILT_IN_CLIENT_SECRET: Option<&str> = option_env!("TINGS3_GOOGLE_CLIENT_SECRET");

type Res<T> = Result<T, Value>;

fn err(code: &str, message: impl Into<String>) -> Value {
    json!({ "code": code, "message": message.into() })
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

pub struct GCal {
    cache_path: PathBuf,
    stored: Mutex<Option<Stored>>,
    access: Mutex<Option<Access>>,
    cache: Mutex<Option<Cache>>,
    /// Google's palette for per-event colours ("colorId" → hex).
    palette: Mutex<Option<HashMap<String, String>>>,
    last_error: Mutex<Option<String>>,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn str_of(v: &Value) -> Option<String> {
    v.as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

/// Converts one item from Google's events list. Cancelled items are skipped.
fn parse_event(calendar: &CalendarInfo, item: &Value, palette: &HashMap<String, String>) -> Option<CalEvent> {
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
        color: item["colorId"].as_str().and_then(|c| palette.get(c).cloned()).unwrap_or_else(|| calendar.color.clone()),
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

impl GCal {
    pub fn new(data_dir: PathBuf) -> Self {
        GCal {
            cache_path: data_dir.join("calendar-cache.json"),
            stored: Mutex::new(None),
            access: Mutex::new(None),
            cache: Mutex::new(None),
            palette: Mutex::new(None),
            last_error: Mutex::new(None),
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

    // ---------- cache ----------

    fn with_cache<T>(&self, f: impl FnOnce(&mut Cache) -> T) -> T {
        let mut slot = self.cache.lock().unwrap();
        if slot.is_none() {
            *slot = Some(std::fs::read(&self.cache_path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default());
        }
        f(slot.as_mut().unwrap())
    }

    fn save_cache(&self) {
        let body = self.with_cache(|c| serde_json::to_vec(c).unwrap_or_default());
        if let Some(dir) = self.cache_path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let tmp = self.cache_path.with_extension("tmp");
        if std::fs::write(&tmp, body).is_ok() {
            let _ = std::fs::rename(tmp, &self.cache_path);
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
        if let Some(token) = self.load().refresh_token {
            let _ = http().post("https://oauth2.googleapis.com/revoke").form(&[("token", token.as_str())]).send();
        }
        self.update(|s| {
            s.refresh_token = None;
            s.email = None;
            s.visibility.clear();
        })?;
        *self.access.lock().unwrap() = None;
        *self.last_error.lock().unwrap() = None;
        self.with_cache(|c| *c = Cache::default());
        let _ = std::fs::remove_file(&self.cache_path);
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
        let refresh = self.load().refresh_token.ok_or_else(|| err("noAccount", "Connect Google Calendar first."))?;
        let (client_id, client_secret) = self.client().ok_or_else(|| err("noAccount", "Google Calendar isn't set up."))?;
        let resp: Value = http()
            .post("https://oauth2.googleapis.com/token")
            .form(&[("client_id", client_id.as_str()), ("client_secret", client_secret.as_str()), ("refresh_token", refresh.as_str()), ("grant_type", "refresh_token")])
            .send()
            .and_then(|r| r.json())
            .map_err(|e| err("offline", format!("Couldn't reach Google: {e}")))?;
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
        let r = http().get(url).bearer_auth(self.token()?).send().map_err(|e| err("offline", format!("Couldn't reach Google Calendar: {e}")))?;
        let status = r.status();
        if status.is_success() {
            return r.json().map_err(|e| err("sync", e.to_string()));
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
        let vis = self.load().visibility;
        let mut out = Vec::new();
        let mut page: Option<String> = None;
        loop {
            let mut url = format!("{API}/users/me/calendarList?maxResults=250&minAccessRole=reader&fields=items(id,summary,summaryOverride,backgroundColor,primary,selected,hidden),nextPageToken");
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
                    color: str_of(&c["backgroundColor"]).unwrap_or_else(|| "#4285f4".into()),
                    primary: c["primary"] == true,
                    visible: vis.get(&id).copied().unwrap_or(c["selected"] == true || c["primary"] == true),
                    id,
                });
            }
            page = str_of(&v["nextPageToken"]);
            if page.is_none() {
                break;
            }
        }
        // Primary first, then by name.
        out.sort_by(|a, b| b.primary.cmp(&a.primary).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
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

    fn palette(&self) -> HashMap<String, String> {
        if let Some(p) = self.palette.lock().unwrap().as_ref() {
            return p.clone();
        }
        let p: HashMap<String, String> = self
            .get_json(&format!("{API}/colors"))
            .ok()
            .and_then(|v| v["event"].as_object().map(|o| o.iter().filter_map(|(k, c)| str_of(&c["background"]).map(|bg| (k.clone(), bg))).collect()))
            .unwrap_or_default();
        if !p.is_empty() {
            *self.palette.lock().unwrap() = Some(p.clone());
        }
        p
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
        self.remember_error(&fresh);
        match fresh {
            Ok(events) => Ok(EventsResult { events, stale: false, fetched_at: self.with_cache(|c| c.fetched_at) }),
            Err(e) if e["code"] == "offline" => {
                let visible: Vec<String> = self.with_cache(|c| c.calendars.iter().filter(|c| c.visible).map(|c| c.id.clone()).collect());
                let events = self.with_cache(|c| c.events.values().filter(|ev| visible.contains(&ev.calendar_id) && overlaps(ev, min, max)).cloned().collect());
                Ok(EventsResult { events, stale: true, fetched_at: self.with_cache(|c| c.fetched_at) })
            }
            Err(e) => Err(e),
        }
    }

    fn fetch_events(&self, min: chrono::DateTime<chrono::Utc>, max: chrono::DateTime<chrono::Utc>) -> Res<Vec<CalEvent>> {
        let token = self.token()?;
        let calendars = {
            let cached = self.with_cache(|c| c.calendars.clone());
            if cached.is_empty() {
                self.fetch_calendars()?
            } else {
                cached
            }
        };
        let palette = self.palette();
        let visible: Vec<&CalendarInfo> = calendars.iter().filter(|c| c.visible).collect();
        let tmin = min.to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        let tmax = max.to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        // One request per calendar, side by side.
        let results: Vec<Res<Vec<CalEvent>>> = std::thread::scope(|scope| {
            let jobs: Vec<_> = visible
                .iter()
                .map(|cal| {
                    let (token, palette, tmin, tmax) = (&token, &palette, &tmin, &tmax);
                    scope.spawn(move || fetch_calendar_events(token, cal, palette, tmin, tmax))
                })
                .collect();
            jobs.into_iter().map(|j| j.join().unwrap_or_else(|_| Err(err("sync", "internal error")))).collect()
        });
        let mut events = Vec::new();
        let mut first_err = None;
        for r in results {
            match r {
                Ok(mut list) => events.append(&mut list),
                // A calendar that disappeared shouldn't hide the others.
                Err(e) if e["code"] == "notFound" => {}
                Err(e) => first_err = first_err.or(Some(e)),
            }
        }
        if let Some(e) = first_err {
            if events.is_empty() {
                return Err(e);
            }
        }
        events.sort_by(|a, b| a.start.cmp(&b.start));
        self.store_events(min, max, &events, &visible.iter().map(|c| c.id.clone()).collect::<Vec<_>>());
        Ok(events)
    }

    /// Replaces the cached events of these calendars in this range.
    fn store_events(&self, min: chrono::DateTime<chrono::Utc>, max: chrono::DateTime<chrono::Utc>, events: &[CalEvent], calendars: &[String]) {
        let now = chrono::Utc::now();
        let horizon = chrono::Duration::days(CACHE_DAYS);
        self.with_cache(|c| {
            c.events.retain(|_, e| !(calendars.contains(&e.calendar_id) && overlaps(e, min, max)) && overlaps(e, now - horizon, now + horizon));
            for e in events {
                c.events.insert(key(e), e.clone());
            }
            c.fetched_at = Some(now_ms());
        });
        self.save_cache();
    }
}

fn fetch_calendar_events(token: &str, cal: &CalendarInfo, palette: &HashMap<String, String>, tmin: &str, tmax: &str) -> Res<Vec<CalEvent>> {
    let mut out = Vec::new();
    let mut page: Option<String> = None;
    for _ in 0..10 {
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
        let r = http().get(&url).bearer_auth(token).send().map_err(|e| err("offline", format!("Couldn't reach Google Calendar: {e}")))?;
        let status = r.status();
        let v: Value = r.json().unwrap_or(Value::Null);
        if !status.is_success() {
            let msg = v["error"]["message"].as_str().unwrap_or("Google Calendar returned an error").to_string();
            return Err(err(if status.as_u16() == 404 { "notFound" } else if status.as_u16() == 401 { "noAccount" } else { "sync" }, msg));
        }
        out.extend(v["items"].as_array().into_iter().flatten().filter_map(|item| parse_event(cal, item, palette)));
        page = str_of(&v["nextPageToken"]);
        if page.is_none() {
            break;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cal() -> CalendarInfo {
        CalendarInfo { id: "me@example.com".into(), name: "Me".into(), color: "#039be5".into(), primary: true, visible: true }
    }

    #[test]
    fn parses_timed_and_all_day_events() {
        let palette = HashMap::from([("11".to_string(), "#dc2127".to_string())]);
        let timed = json!({
            "id": "a1", "status": "confirmed", "summary": " Standup ", "htmlLink": "https://www.google.com/calendar/event?eid=x",
            "start": { "dateTime": "2026-10-20T09:00:00-05:00" }, "end": { "dateTime": "2026-10-20T09:15:00-05:00" },
            "colorId": "11", "attendees": [{ "self": true, "responseStatus": "declined" }, { "email": "b@x.com" }],
            "organizer": { "email": "boss@example.com" }
        });
        let e = parse_event(&cal(), &timed, &palette).unwrap();
        assert_eq!(e.title, "Standup");
        assert!(!e.all_day);
        assert_eq!(e.color, "#dc2127");
        assert!(e.declined);
        assert_eq!(e.attendees, 2);
        assert_eq!(e.organizer.as_deref(), Some("boss@example.com"));

        let all_day = json!({ "id": "b2", "start": { "date": "2026-10-21" }, "end": { "date": "2026-10-22" }, "transparency": "transparent", "htmlLink": "javascript:alert(1)" });
        let e = parse_event(&cal(), &all_day, &palette).unwrap();
        assert!(e.all_day && e.free);
        assert_eq!(e.title, "(No title)");
        assert_eq!(e.color, "#039be5");
        assert_eq!(e.link, None, "only https links are kept");

        assert!(parse_event(&cal(), &json!({ "id": "c", "status": "cancelled" }), &palette).is_none());
    }

    #[test]
    fn range_overlap() {
        let mut e = parse_event(&cal(), &json!({ "id": "x", "start": { "dateTime": "2026-10-20T09:00:00Z" }, "end": { "dateTime": "2026-10-20T10:00:00Z" } }), &HashMap::new()).unwrap();
        let t = |s: &str| chrono::DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&chrono::Utc);
        assert!(overlaps(&e, t("2026-10-20T00:00:00Z"), t("2026-10-21T00:00:00Z")));
        assert!(!overlaps(&e, t("2026-10-20T10:00:00Z"), t("2026-10-21T00:00:00Z")));
        e.all_day = true;
        e.start = "2026-10-25".into();
        e.end = "2026-10-26".into();
        assert!(overlaps(&e, t("2026-10-25T05:00:00Z"), t("2026-10-26T05:00:00Z")));
        assert!(!overlaps(&e, t("2026-11-01T00:00:00Z"), t("2026-11-02T00:00:00Z")));
    }
}
