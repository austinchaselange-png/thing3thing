//! App core: owns the sync engine for the active account (demo or Things
//! Cloud), runs the background sync worker, and publishes state to the UI.
//!
//! All engine access is serialised through one mutex, so a background sync
//! and a user write can never interleave.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::time::{Duration, Instant};

use chrono::Local;
use serde::Serialize;
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use things_cloud::fake::FakeCloud;
use things_cloud::http::HttpTransport;
use things_cloud::{CloudError, Item, Secret, Transport};
use things_sync::cache::{Cache, JournalEntry};
use things_sync::mutation::Ctx;
use things_sync::{Engine, EngineError, Mutation, Snapshot, WriteError, WritePolicy, WriteReport};

use crate::credentials::{CredentialStore, OsCredentialStore, StoredCredentials};
use crate::settings::{AccountMode, Settings, SettingsPatch};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Idle,
    Syncing,
    Error,
    Offline,
    RateLimited,
    SignedOut,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub phase: Phase,
    pub last_synced_at: Option<i64>,
    pub last_error: Option<String>,
    pub next_attempt_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountDto {
    pub mode: AccountMode,
    pub email: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformDto {
    pub os: &'static str,
    pub mica_available: bool,
    pub version: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStateDto {
    pub account: AccountDto,
    pub snapshot: Snapshot,
    pub sync: SyncStatus,
    pub policy: WritePolicy,
    pub issues: Vec<JournalEntry>,
    pub recent_writes: Vec<JournalEntry>,
    pub settings: Settings,
    pub platform: PlatformDto,
    /// Writes allowed right now: the policy permits them and the account has
    /// no data in a newer, unvalidated format.
    pub can_write: bool,
    pub format: FormatDto,
    /// Changes whenever the data may have changed; equal values mean the UI
    /// can keep what it already shows (status-only updates).
    pub data_rev: u64,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct KindCount {
    pub kind: String,
    pub count: u64,
    /// Field names that were ignored when reading this kind (never values).
    pub unfamiliar_fields: Vec<String>,
}

/// Things data formats this account uses that Things 3 only reads best-effort.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FormatDto {
    pub newer_kinds: Vec<KindCount>,
    /// Why writes are turned off (newer server schema, unreadable items,
    /// unexpected fields). Empty when everything was understood.
    pub problems: Vec<String>,
    /// Schema Things Cloud last reported.
    pub server_schema: Option<u32>,
    /// True when every newer-format item uses only understood fields, so
    /// writes are allowed (in that newer format).
    pub writes_supported: bool,
}

struct Inner {
    engine: Option<Engine>,
    fake: Option<Arc<FakeCloud>>,
    /// Consecutive failed syncs, for back-off.
    failures: u32,
    /// Polling stopped until the user acts (e.g. password changed).
    halted: bool,
}

pub struct Core {
    app: AppHandle,
    data_dir: PathBuf,
    settings_path: PathBuf,
    creds: Box<dyn CredentialStore>,
    inner: Mutex<Inner>,
    settings: Mutex<Settings>,
    status: Mutex<SyncStatus>,
    published: RwLock<Option<AppStateDto>>,
    wake: (Mutex<bool>, Condvar),
    pub visible: AtomicBool,
    /// Bumped whenever data (not just sync status) is published, so the
    /// backup loop can skip building a payload when nothing changed.
    data_rev: AtomicU64,
    /// Quit was chosen; set once.
    pub quitting: AtomicBool,
    /// The UI has saved any open edit and is ready for the app to exit.
    pub quit_ready: AtomicBool,
}

pub fn mica_available() -> bool {
    #[cfg(windows)]
    {
        windows_version::OsVersion::current().build >= 22000
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn ctx() -> Ctx {
    Ctx { today: Local::now().date_naive(), now: things_cloud::dates::now_ts() }
}

/// Serialises a write error for the UI: `{ code, message, ...details }`.
pub fn write_error(e: &WriteError) -> Value {
    let mut v = serde_json::to_value(e).unwrap_or_else(|_| json!({ "code": "storage" }));
    v["message"] = json!(e.to_string());
    v
}

fn plain_error(code: &str, message: impl Into<String>) -> Value {
    json!({ "code": code, "message": message.into() })
}

fn cloud_message(e: &CloudError) -> String {
    match e {
        CloudError::Unauthorized => "The email or password is incorrect.".into(),
        CloudError::Network(_) => "Could not reach Things Cloud. Check your internet connection.".into(),
        other => other.to_string(),
    }
}

impl Core {
    pub fn new(app: AppHandle) -> Arc<Core> {
        let data_dir = app.path().app_local_data_dir().expect("no local data directory");
        let settings_path = app.path().app_config_dir().expect("no config directory").join("settings.json");
        let settings = Settings::load(&settings_path);
        if let Err(e) = std::fs::create_dir_all(&data_dir) {
            log::error!("could not create data directory: {e}");
        }
        let core = Arc::new(Core {
            app,
            data_dir,
            settings_path,
            creds: Box::new(OsCredentialStore),
            inner: Mutex::new(Inner { engine: None, fake: None, failures: 0, halted: false }),
            settings: Mutex::new(settings),
            status: Mutex::new(SyncStatus { phase: Phase::Idle, last_synced_at: None, last_error: None, next_attempt_at: None }),
            published: RwLock::new(None),
            wake: (Mutex::new(false), Condvar::new()),
            visible: AtomicBool::new(true),
            data_rev: AtomicU64::new(0),
            quitting: AtomicBool::new(false),
            quit_ready: AtomicBool::new(false),
        });
        core.open_from_settings();
        core
    }

    pub fn settings(&self) -> Settings {
        self.settings.lock().unwrap().clone()
    }

    fn write_settings(&self, s: &Settings) -> Result<(), Value> {
        s.save(&self.settings_path).map_err(|e| plain_error("storage", format!("Couldn't save your settings: {e}")))
    }

    fn cache_path(&self, email: &str) -> PathBuf {
        let digest = Sha1::digest(email.trim().to_lowercase().as_bytes());
        let tag: String = digest.iter().take(6).map(|b| format!("{b:02x}")).collect();
        self.data_dir.join(format!("cache-{tag}.sqlite"))
    }

    fn open_from_settings(&self) {
        let settings = self.settings();
        let mut inner = self.lock_inner();
        let result = match (settings.mode, settings.email.as_deref()) {
            (AccountMode::Demo, _) => self.open_demo(&mut inner).map_err(|e| e.to_string()),
            (AccountMode::Cloud, Some(email)) => self.open_cloud(&mut inner, email),
            _ => Ok(()),
        };
        if let Err(msg) = result {
            log::error!("could not open account: {msg}");
            let mut st = self.status.lock().unwrap();
            st.phase = Phase::Error;
            st.last_error = Some(msg);
        }
        self.publish(&inner);
    }

    fn open_demo(&self, inner: &mut Inner) -> Result<(), EngineError> {
        // The local ("on this PC") account starts empty; no sample data is seeded.
        let fake = Arc::new(FakeCloud::persistent(self.data_dir.join("demo-history.json"), Vec::new));
        let cache = Cache::open(&self.data_dir.join("demo-cache.sqlite"))?;
        let mut engine = Engine::open(fake.clone(), fake.history_key(), cache, WritePolicy { writes: true, destructive: true })?;
        // The demo "server" is local, so load it right away.
        engine.sync()?;
        self.set_status(|s| s.last_synced_at = Some(now_ms()));
        inner.engine = Some(engine);
        inner.fake = Some(fake);
        inner.failures = 0;
        inner.halted = false;
        Ok(())
    }

    fn open_cloud(&self, inner: &mut Inner, email: &str) -> Result<(), String> {
        let creds = self
            .creds
            .load(email)
            .map_err(|e| e.to_string())?
            .ok_or("Saved credentials were not found in Windows Credential Manager. Please reconnect.")?;
        let transport: Arc<dyn Transport> = Arc::new(HttpTransport::new().map_err(|e| e.to_string())?);
        let cache = Cache::open(&self.cache_path(email)).map_err(|e| e.to_string())?;
        let engine = Engine::open(transport, creds.history_key, cache, WritePolicy::default()).map_err(|e| e.to_string())?;
        inner.engine = Some(engine);
        inner.fake = None;
        inner.failures = 0;
        inner.halted = false;
        Ok(())
    }

    /// Locks the engine, recovering if an earlier panic poisoned the lock, so
    /// one bug can't leave the app permanently unable to sync or save.
    fn lock_inner(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|poisoned| {
            log::error!("engine lock was poisoned by an earlier panic; recovering");
            self.inner.clear_poison();
            poisoned.into_inner()
        })
    }

    // ---------- Publishing ----------

    fn build_state(&self, inner: &Inner) -> AppStateDto {
        let settings = self.settings();
        let (snapshot, policy, issues, recent) = match &inner.engine {
            Some(e) => (e.snapshot(), e.policy(), e.issues().unwrap_or_default(), e.recent_writes(15).unwrap_or_default()),
            None => (Snapshot::default(), WritePolicy::default(), vec![], vec![]),
        };
        let format = inner
            .engine
            .as_ref()
            .map(|e| {
                let st = e.state();
                FormatDto {
                    newer_kinds: st
                        .newer_kinds
                        .iter()
                        .map(|(kind, count)| KindCount {
                            kind: kind.clone(),
                            count: *count,
                            unfamiliar_fields: st.unfamiliar_fields.get(kind).map(|f| f.iter().cloned().collect()).unwrap_or_default(),
                        })
                        .collect(),
                    problems: e.format_problems(),
                    server_schema: e.server_schema(),
                    writes_supported: e.format_problems().is_empty(),
                }
            })
            .unwrap_or(FormatDto { newer_kinds: vec![], problems: vec![], server_schema: None, writes_supported: true });
        let mut sync = self.status.lock().unwrap().clone();
        let mode = if inner.engine.is_none() { AccountMode::SignedOut } else { settings.mode };
        if mode == AccountMode::SignedOut && sync.phase != Phase::Error {
            sync.phase = Phase::SignedOut;
        }
        AppStateDto {
            account: AccountDto { mode, email: if mode == AccountMode::Cloud { settings.email.clone() } else { None } },
            snapshot,
            sync,
            policy,
            issues,
            recent_writes: recent,
            settings,
            platform: PlatformDto { os: std::env::consts::OS, mica_available: mica_available(), version: env!("CARGO_PKG_VERSION") },
            can_write: policy.writes && format.writes_supported,
            format,
            data_rev: self.data_rev.load(Ordering::Acquire),
        }
    }

    /// Changes whenever published data may have changed.
    pub fn data_rev(&self) -> u64 {
        self.data_rev.load(Ordering::Acquire)
    }

    fn publish(&self, inner: &Inner) {
        self.data_rev.fetch_add(1, Ordering::AcqRel);
        let state = self.build_state(inner);
        let _ = self.app.emit("state", &state);
        *self.published.write().unwrap() = Some(state);
    }

    /// Re-emits the cached state with a fresh sync status, without touching
    /// the engine (usable while another thread holds the engine lock).
    fn publish_status(&self) {
        let mut guard = self.published.write().unwrap();
        if let Some(state) = guard.as_mut() {
            state.sync = self.status.lock().unwrap().clone();
            let _ = self.app.emit("state", &*state);
        }
    }

    pub fn state(&self) -> AppStateDto {
        if let Some(s) = self.published.read().unwrap().clone() {
            return s;
        }
        let inner = self.lock_inner();
        self.publish(&inner);
        self.published.read().unwrap().clone().expect("just published")
    }

    fn set_status(&self, f: impl FnOnce(&mut SyncStatus)) {
        f(&mut self.status.lock().unwrap());
    }

    // ---------- Background worker ----------

    pub fn wake(&self) {
        let (lock, cv) = &self.wake;
        *lock.lock().unwrap() = true;
        cv.notify_all();
    }

    fn wait(&self, timeout: Duration) -> bool {
        let (lock, cv) = &self.wake;
        let guard = lock.lock().unwrap();
        let (mut guard, _) = cv.wait_timeout_while(guard, timeout, |woken| !*woken).unwrap();
        std::mem::replace(&mut *guard, false)
    }

    fn interval(&self, failures: u32) -> Duration {
        let base = self.settings().poll_seconds.max(30);
        let base = if self.visible.load(Ordering::Relaxed) { base } else { (base * 4).max(120) };
        let secs = if failures == 0 { base } else { (base.saturating_mul(1 << failures.min(5))).min(900) };
        Duration::from_secs(secs)
    }

    pub fn run_worker(self: Arc<Self>) {
        let mut next_sync = Instant::now();
        let mut last_reminder = Local::now().naive_local();
        let mut first = true;
        loop {
            let woken = if first { true } else { self.wait(Duration::from_secs(15)) };
            first = false;
            if woken || Instant::now() >= next_sync {
                // Keep the worker alive whatever happens, so syncing can resume.
                let failures = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.sync_once())).unwrap_or_else(|_| {
                    log::error!("sync worker recovered from a panic");
                    self.set_status(|s| {
                        s.phase = Phase::Error;
                        s.last_error = Some("Things 3 hit an internal error while syncing. It will try again shortly.".into());
                    });
                    self.publish_status();
                    1
                });
                next_sync = Instant::now() + self.interval(failures);
                if failures > 0 {
                    let at = now_ms() + self.interval(failures).as_millis() as i64;
                    self.set_status(|s| s.next_attempt_at = Some(at));
                    self.publish_status();
                }
            }
            let now = Local::now().naive_local();
            // Only move on once the window was actually checked; if the engine
            // was busy, the next pass covers these minutes too.
            if self.check_reminders(last_reminder, now) {
                last_reminder = now;
            }
        }
    }

    /// Pulls remote changes once. Returns the number of consecutive failures.
    fn sync_once(&self) -> u32 {
        let mut inner = self.lock_inner();
        if inner.engine.is_none() || inner.halted {
            return 0;
        }
        self.set_status(|s| s.phase = Phase::Syncing);
        self.publish_status();
        // A bug while reading must not kill the worker (and with it all
        // future syncs); report it instead.
        let engine = inner.engine.as_mut().unwrap();
        let schema_before = engine.server_schema();
        let result = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| engine.sync())) {
            Ok(r) => r,
            Err(panic) => {
                let what = panic
                    .downcast_ref::<&str>()
                    .map(|s| s.to_string())
                    .or_else(|| panic.downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| "unknown error".into());
                log::error!("sync panicked: {what}");
                inner.halted = true;
                inner.failures += 1;
                let msg = format!("Things 3 hit an internal error while syncing ({what}). Your data on Things Cloud was not changed.");
                self.set_status(|s| {
                    s.phase = Phase::Error;
                    s.last_error = Some(msg.clone());
                });
                self.notify("Things 3 stopped syncing", &msg);
                let failures = inner.failures;
                self.publish(&inner);
                return failures;
            }
        };
        // A poll that brought nothing new only refreshes the status line; the
        // full state (and the backup's change counter) stays as it was.
        let mut nothing_new = false;
        match result {
            Ok(report) => {
                let was_ok = inner.failures == 0 && !inner.halted;
                let schema_after = inner.engine.as_ref().and_then(|e| e.server_schema());
                nothing_new = was_ok
                    && report.new_entries == 0
                    && report.reconciled.is_empty()
                    && report.missing.is_empty()
                    && schema_before == schema_after;
                inner.failures = 0;
                self.set_status(|s| {
                    s.phase = Phase::Idle;
                    s.last_synced_at = Some(now_ms());
                    s.last_error = None;
                    s.next_attempt_at = None;
                });
                if !report.missing.is_empty() {
                    self.notify("A change may not have been saved", "Open Things 3 to review it.");
                }
            }
            Err(EngineError::Cloud(CloudError::Http { status: 401 | 403 | 404, .. }))
            | Err(EngineError::Cloud(CloudError::Unauthorized))
                if self.settings().mode == AccountMode::Cloud =>
            {
                // The history key may have changed; re-verify with the saved password.
                drop(inner);
                self.reverify();
                return 0;
            }
            Err(e) => {
                inner.failures += 1;
                let (phase, halt) = match &e {
                    EngineError::Cloud(CloudError::Network(_)) => (Phase::Offline, false),
                    EngineError::Cloud(CloudError::AbusePrevention) => {
                        inner.failures = inner.failures.max(4);
                        (Phase::RateLimited, false)
                    }
                    EngineError::Cloud(CloudError::UnsupportedSchema { .. }) | EngineError::State(_) => (Phase::Error, true),
                    _ => (Phase::Error, false),
                };
                inner.halted = halt;
                let msg = match &e {
                    EngineError::Cloud(c) => cloud_message(c),
                    other => other.to_string(),
                };
                log::warn!("sync failed: {msg}");
                self.set_status(|s| {
                    s.phase = phase;
                    s.last_error = Some(msg.clone());
                });
                if halt {
                    self.notify("Things 3 stopped syncing", &msg);
                }
            }
        }
        let failures = inner.failures;
        if nothing_new && self.published.read().map(|p| p.is_some()).unwrap_or(false) {
            self.publish_status();
        } else {
            self.publish(&inner);
        }
        failures
    }

    fn reverify(&self) {
        let Some(email) = self.settings().email else { return };
        let outcome = (|| -> Result<(), String> {
            let creds = self.creds.load(&email).map_err(|e| e.to_string())?.ok_or("credentials missing")?;
            let transport = HttpTransport::new().map_err(|e| e.to_string())?;
            let account = transport.verify(&email, &creds.password).map_err(|e| cloud_message(&e))?;
            self.creds
                .save(&email, &StoredCredentials { password: creds.password, history_key: account.history_key })
                .map_err(|e| e.to_string())?;
            let mut inner = self.lock_inner();
            self.open_cloud(&mut inner, &email)
        })();
        let mut inner = self.lock_inner();
        match outcome {
            Ok(()) => self.wake(),
            Err(msg) => {
                inner.halted = true;
                let msg = format!("Things Cloud no longer accepts the saved credentials ({msg}). Reconnect in Settings → Account.");
                self.set_status(|s| {
                    s.phase = Phase::Error;
                    s.last_error = Some(msg.clone());
                });
                self.notify("Things 3 needs you to sign in again", "Open Settings → Account to reconnect.");
            }
        }
        self.publish(&inner);
    }

    /// Shows reminders due in `(after, until]`. False when the engine was busy
    /// and nothing could be checked.
    fn check_reminders(&self, after: chrono::NaiveDateTime, until: chrono::NaiveDateTime) -> bool {
        if !self.settings().notifications {
            return true;
        }
        let due = match self.inner.try_lock() {
            Ok(inner) => inner.engine.as_ref().map(|e| e.due_reminders(after, until)).unwrap_or_default(),
            Err(_) => return false,
        };
        for r in due {
            self.notify(&r.title, &format!("Reminder · {}", r.at.format("%H:%M")));
            // The window shows it with Snooze buttons.
            let _ = self.app.emit_to("main", "reminder", json!({ "taskId": r.task_id, "title": r.title, "at": r.at.format("%H:%M").to_string() }));
        }
        true
    }

    fn notify(&self, title: &str, body: &str) {
        if let Err(e) = self.app.notification().builder().title(title).body(body).show() {
            log::warn!("notification failed: {e}");
        }
    }

    /// Waits (at most `max`) until no write is in flight, then runs `f` while
    /// holding the engine, so no new write can start before the app exits.
    pub fn when_idle(&self, max: Duration, f: impl FnOnce()) {
        let start = Instant::now();
        loop {
            match self.inner.try_lock() {
                Ok(_guard) => return f(),
                Err(std::sync::TryLockError::Poisoned(p)) => {
                    let _guard = p.into_inner();
                    return f();
                }
                Err(std::sync::TryLockError::WouldBlock) if start.elapsed() < max => std::thread::sleep(Duration::from_millis(100)),
                Err(std::sync::TryLockError::WouldBlock) => {
                    log::warn!("quitting while a change is still being sent");
                    return f();
                }
            }
        }
    }

    // ---------- Commands ----------

    pub fn sync_now(&self) {
        let mut inner = self.lock_inner();
        inner.halted = false;
        inner.failures = 0;
        drop(inner);
        self.wake();
    }

    pub fn apply(&self, m: Mutation, force: bool) -> Result<WriteReport, Value> {
        let mut inner = self.lock_inner();
        let engine = inner.engine.as_mut().ok_or_else(|| plain_error("noAccount", "Connect an account first."))?;
        let result = engine.apply(&m, force, &ctx());
        if let Err(WriteError::Uncertain { .. }) = &result {
            self.notify("A change may not have been saved", "Things 3 will not resend it automatically. Open Things 3 to review.");
        }
        if result.is_ok() {
            self.set_status(|s| {
                s.last_synced_at = Some(now_ms());
                s.phase = Phase::Idle;
                s.last_error = None;
            });
        }
        self.publish(&inner);
        result.map_err(|e| write_error(&e))
    }

    pub fn set_policy(&self, policy: WritePolicy) -> Result<(), Value> {
        let mut inner = self.lock_inner();
        if self.settings().mode != AccountMode::Cloud {
            return Err(plain_error("invalid", "The write policy applies to a connected Things Cloud account."));
        }
        let engine = inner.engine.as_mut().ok_or_else(|| plain_error("noAccount", "Connect an account first."))?;
        engine.set_policy(policy).map_err(|e| plain_error("storage", e.to_string()))?;
        log::info!("write policy changed: writes={} destructive={}", policy.writes, policy.destructive);
        self.publish(&inner);
        Ok(())
    }

    pub fn dismiss_issue(&self, id: i64) -> Result<(), Value> {
        let mut inner = self.lock_inner();
        let engine = inner.engine.as_mut().ok_or_else(|| plain_error("noAccount", "No account."))?;
        engine.dismiss_issue(id).map_err(|e| plain_error("storage", e.to_string()))?;
        self.publish(&inner);
        Ok(())
    }

    pub fn reapply_issue(&self, id: i64) -> Result<WriteReport, Value> {
        let mut inner = self.lock_inner();
        let engine = inner.engine.as_mut().ok_or_else(|| plain_error("noAccount", "No account."))?;
        if !engine.policy().writes {
            return Err(write_error(&WriteError::ReadOnly));
        }
        let r = engine.reapply_issue(id, &ctx());
        self.publish(&inner);
        r.map_err(|e| write_error(&e))
    }

    /// Verifies credentials, stores them securely, and opens the account
    /// read-only. The first download runs in the background worker.
    pub fn connect(&self, email: String, password: String) -> Result<(), Value> {
        let email = email.trim().to_string();
        let password = Secret::new(password);
        if email.is_empty() || password.is_empty() {
            return Err(plain_error("invalid", "Enter your email and password."));
        }
        let transport = HttpTransport::new().map_err(|e| plain_error("invalid", e.to_string()))?;
        let account = transport.verify(&email, &password).map_err(|e| plain_error("invalid", cloud_message(&e)))?;
        self.creds
            .save(&email, &StoredCredentials { password, history_key: account.history_key })
            .map_err(|e| plain_error("storage", e.to_string()))?;
        let mut inner = self.lock_inner();
        // Saved first: if settings can't be written, the next launch would
        // quietly open signed out, so report it instead of claiming success.
        {
            let mut next = self.settings();
            next.mode = AccountMode::Cloud;
            next.email = Some(email.clone());
            self.write_settings(&next)?;
        }
        if let Err(m) = self.open_cloud(&mut inner, &email) {
            let previous = self.settings.lock().unwrap().clone();
            let _ = self.write_settings(&previous);
            return Err(plain_error("storage", m));
        }
        {
            let mut s = self.settings.lock().unwrap();
            s.mode = AccountMode::Cloud;
            s.email = Some(email);
        }
        self.set_status(|s| {
            s.phase = Phase::Syncing;
            s.last_error = None;
            s.last_synced_at = None;
        });
        self.publish(&inner);
        drop(inner);
        self.wake();
        Ok(())
    }

    pub fn disconnect(&self, forget_cache: bool) -> Result<(), Value> {
        let mut inner = self.lock_inner();
        let email = self.settings().email;
        // Credentials go first: if Windows can't delete them, nothing else
        // changes and the account stays connected and working.
        if let Some(email) = &email {
            self.creds.delete(email).map_err(|e| plain_error("storage", format!("Couldn't remove the saved password: {e}")))?;
        }
        inner.engine = None;
        inner.fake = None;
        let mut leftovers = Vec::new();
        if let (Some(email), true) = (&email, forget_cache) {
            let path = self.cache_path(email);
            for suffix in ["", "-wal", "-shm"] {
                let file = PathBuf::from(format!("{}{suffix}", path.display()));
                match std::fs::remove_file(&file) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => {
                        log::warn!("could not delete {}: {e}", file.display());
                        leftovers.push(file.display().to_string());
                    }
                }
            }
        }
        let saved = {
            let mut s = self.settings.lock().unwrap();
            s.mode = AccountMode::SignedOut;
            s.email = None;
            self.write_settings(&s)
        };
        self.set_status(|s| {
            s.phase = Phase::SignedOut;
            s.last_error = None;
        });
        self.publish(&inner);
        saved?;
        if !leftovers.is_empty() {
            return Err(plain_error(
                "storage",
                format!("Signed out, but the local copy couldn't be deleted. You can remove it by hand: {}", leftovers.join(", ")),
            ));
        }
        Ok(())
    }

    /// Everything, as one JSON document for backups. "On this PC" accounts also
    /// include their full history so a restore is exact. None when there's
    /// nothing to back up (signed out, empty, or the engine is busy syncing).
    pub fn backup_payload(&self) -> Option<Vec<u8>> {
        let state = self.state();
        if matches!(self.settings().mode, AccountMode::SignedOut) {
            return None;
        }
        if state.snapshot.tasks.is_empty() && state.snapshot.areas.is_empty() && state.snapshot.tags.is_empty() {
            return None; // never replace a good backup with an empty one
        }
        let history = match self.inner.try_lock() {
            Ok(inner) => inner.fake.as_ref().map(|f| f.history()),
            Err(_) => return None,
        };
        // No timestamp inside: unchanged data must hash the same (Drive keeps the file's time).
        let body = json!({
            "format": "things3-windows-backup",
            "version": 1,
            "account": state.account,
            "snapshot": state.snapshot,
            "history": history,
        });
        serde_json::to_vec_pretty(&body).ok()
    }

    /// Replaces "On this PC" data with a backup. The current data is kept next
    /// to it as demo-history.before-restore-<time>.json.
    pub fn restore_local(&self, bytes: &[u8]) -> Result<(), Value> {
        if !matches!(self.settings().mode, AccountMode::Demo) {
            return Err(plain_error("invalid", "Restoring is only for lists stored on this PC. Things Cloud already keeps your data safe on its servers."));
        }
        let v: Value = serde_json::from_slice(bytes).map_err(|_| plain_error("invalid", "That backup file can't be read."))?;
        if v["format"] != "things3-windows-backup" {
            return Err(plain_error("invalid", "That isn't a Things 3 backup."));
        }
        let history: Vec<Vec<Item>> = serde_json::from_value(v["history"].clone())
            .map_err(|_| plain_error("invalid", "This backup came from a Things Cloud account, so it can't replace lists stored on this PC."))?;
        let body = serde_json::to_vec(&history).map_err(|e| plain_error("storage", e.to_string()))?;
        let path = self.data_dir.join("demo-history.json");
        // Everything that can fail happens before the current lists are touched:
        // the new history is written and flushed to a staging file, and the
        // current one is copied aside (that copy must succeed).
        let staged = self.data_dir.join(format!("demo-history.restoring-{}.json", things_cloud::id::new_id()));
        crate::settings::write_flushed(&staged, &body).map_err(|e| plain_error("storage", format!("Couldn't prepare the restore: {e}")))?;
        let keep = if path.exists() {
            let keep = self.data_dir.join(format!("demo-history.before-restore-{}-{}.json", Local::now().format("%Y%m%d-%H%M%S"), &things_cloud::id::new_id()[..6]));
            if let Err(e) = std::fs::copy(&path, &keep).and_then(|_| std::fs::File::open(&keep)?.sync_all()) {
                let _ = std::fs::remove_file(&staged);
                return Err(plain_error("storage", format!("Couldn't keep a copy of your current lists, so nothing was restored: {e}")));
            }
            Some(keep)
        } else {
            None
        };
        let mut inner = self.lock_inner();
        inner.engine = None;
        inner.fake = None;
        if let Err(e) = std::fs::rename(&staged, &path) {
            let _ = std::fs::remove_file(&staged);
            let reopened = self.open_demo(&mut inner);
            self.publish(&inner);
            drop(inner);
            log::error!("restore: could not replace history ({e}); reopened current lists: {}", reopened.is_ok());
            return Err(plain_error("storage", format!("Couldn't restore the backup: {e}. Your current lists are unchanged.")));
        }
        for ext in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(self.data_dir.join(format!("demo-cache.sqlite{ext}")));
        }
        if let Err(e) = self.open_demo(&mut inner) {
            // The restored history wouldn't open: put the previous one back.
            if let Some(keep) = &keep {
                let _ = std::fs::copy(keep, &path);
                for ext in ["", "-wal", "-shm"] {
                    let _ = std::fs::remove_file(self.data_dir.join(format!("demo-cache.sqlite{ext}")));
                }
                let _ = self.open_demo(&mut inner);
            }
            self.publish(&inner);
            return Err(plain_error("storage", format!("That backup couldn't be opened ({e}); your previous lists were put back.")));
        }
        self.publish(&inner);
        drop(inner);
        self.wake();
        Ok(())
    }

    pub fn use_demo(&self) -> Result<(), Value> {
        let mut inner = self.lock_inner();
        {
            let mut next = self.settings();
            next.mode = AccountMode::Demo;
            self.write_settings(&next)?;
        }
        if let Err(e) = self.open_demo(&mut inner) {
            let previous = self.settings.lock().unwrap().clone();
            let _ = self.write_settings(&previous);
            return Err(plain_error("storage", e.to_string()));
        }
        self.settings.lock().unwrap().mode = AccountMode::Demo;
        self.set_status(|s| {
            s.phase = Phase::Idle;
            s.last_error = None;
        });
        self.publish(&inner);
        drop(inner);
        self.wake();
        Ok(())
    }

    /// Demo only: appends an edit as if it came from Things on iPhone.
    pub fn simulate_remote_edit(&self) -> Result<String, Value> {
        let inner = self.lock_inner();
        let (Some(fake), Some(engine)) = (inner.fake.clone(), inner.engine.as_ref()) else {
            return Err(plain_error("invalid", "Only available with demo data."));
        };
        let snap = engine.snapshot();
        let task = snap
            .tasks
            .iter()
            .filter(|t| t.status == things_cloud::state::Status::Open && !t.trashed && t.task_type == things_cloud::state::TaskType::Task)
            .min_by_key(|t| t.index)
            .ok_or_else(|| plain_error("invalid", "No open to-do to edit."))?;
        let title = format!("{} (edited on iPhone)", task.title);
        fake.push_remote(vec![Item::new(&task.id, "Task6", 1, json!({ "tt": title, "md": things_cloud::dates::now_ts() }))]);
        drop(inner);
        self.wake();
        Ok(task.title.clone())
    }

    pub fn update_settings(&self, patch: SettingsPatch) -> Result<(), Value> {
        let previous = self.settings();
        let mut next = previous.clone();
        next.apply(patch);
        if next.quick_entry_shortcut != previous.quick_entry_shortcut {
            crate::shell::register_shortcut(&self.app, &previous.quick_entry_shortcut, &next.quick_entry_shortcut)
                .map_err(|e| plain_error("invalid", format!("That shortcut can't be used: {e}")))?;
        }
        if next.launch_at_login != previous.launch_at_login {
            crate::shell::set_autostart(&self.app, next.launch_at_login).map_err(|e| plain_error("storage", e))?;
        }
        // Saved to disk before anything reports success.
        if let Err(e) = self.write_settings(&next) {
            // Undo the side effects applied above so the UI, the OS and the file agree.
            if next.quick_entry_shortcut != previous.quick_entry_shortcut {
                let _ = crate::shell::register_shortcut(&self.app, &next.quick_entry_shortcut, &previous.quick_entry_shortcut);
            }
            if next.launch_at_login != previous.launch_at_login {
                let _ = crate::shell::set_autostart(&self.app, previous.launch_at_login);
            }
            return Err(e);
        }
        *self.settings.lock().unwrap() = next.clone();
        let inner = self.lock_inner();
        self.publish(&inner);
        Ok(())
    }
}
