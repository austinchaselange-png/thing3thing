//! Sync engine and the safe write pipeline.
//!
//! Reads are idempotent and retried freely by the caller. Writes go through
//! [`Engine::apply`], which:
//! 1. checks the write policy (read-only by default) and refuses while an
//!    earlier write has an unknown outcome;
//! 2. pulls remote changes;
//! 3. detects field-level conflicts against the revision the user saw;
//! 4. journals the write *before* sending it;
//! 5. commits exactly once — **never retried automatically**;
//! 6. on an uncertain outcome, reconciles by reading the history only.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use things_cloud::state::StateError;
use things_cloud::transport::validate_page;
use things_cloud::{CloudError, CommitError, Item, ItemsPage, Secret, State, Transport};

use crate::cache::{Cache, CacheError, JournalEntry, JournalStatus};
use crate::model::{self, Snapshot};
use crate::mutation::{self, Ctx, Mutation, PlanError, WriteClass};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WritePolicy {
    /// Allow writes to Things Cloud. Off until the user opts in.
    pub writes: bool,
    /// Allow permanent deletions. Separate opt-in.
    pub destructive: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error(transparent)]
    Cloud(#[from] CloudError),
    #[error("could not apply Things Cloud data: {0}")]
    State(#[from] StateError),
    #[error(transparent)]
    Cache(#[from] CacheError),
}

impl EngineError {
    pub fn is_transient(&self) -> bool {
        matches!(self, EngineError::Cloud(e) if e.is_transient())
    }
}

#[derive(Debug, Clone, PartialEq, thiserror::Error, Serialize)]
#[serde(tag = "code", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum WriteError {
    #[error("Writing to Things Cloud is turned off. Enable it in Settings → Sync.")]
    ReadOnly,
    #[error("Permanent deletions are turned off. Enable them in Settings → Sync.")]
    DestructiveDisabled,
    #[error("An earlier change has an unknown outcome. Resolve it before making more changes.")]
    Blocked { journal_id: i64 },
    #[error("This was changed on another device ({}).", fields.join(", "))]
    Conflict { entity_id: String, fields: Vec<String> },
    #[error("{message}")]
    NotFound { message: String },
    #[error("{message}")]
    Invalid { message: String },
    #[error("Type DELETE to confirm this permanent change.")]
    ConfirmationRequired,
    #[error("Could not check for remote changes before saving: {message}")]
    Sync { message: String },
    #[error("Things Cloud refused the change: {message}")]
    Rejected { message: String, journal_id: i64 },
    #[error("The change may or may not have been saved ({message}). It will not be retried automatically.")]
    Uncertain { message: String, journal_id: i64 },
    #[error("{message}")]
    Storage { message: String },
}

impl From<CacheError> for WriteError {
    fn from(e: CacheError) -> Self {
        WriteError::Storage { message: e.to_string() }
    }
}

impl From<PlanError> for WriteError {
    fn from(e: PlanError) -> Self {
        match e {
            PlanError::NotFound(_) => WriteError::NotFound { message: e.to_string() },
            PlanError::Invalid(m) => WriteError::Invalid { message: m },
            PlanError::ConfirmationRequired => WriteError::ConfirmationRequired,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub new_entries: u64,
    pub reconciled: Vec<i64>,
    pub missing: Vec<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteReport {
    pub created: Vec<String>,
    pub summary: String,
    pub server_index: u64,
    /// True when the commit outcome was uncertain but reading confirmed it.
    pub reconciled: bool,
}

pub struct Engine {
    transport: Arc<dyn Transport>,
    key: Secret,
    cache: Cache,
    state: State,
    policy: WritePolicy,
}

impl Engine {
    /// Opens the engine on a cache, replaying the stored event log so the
    /// UI can show data before any network access.
    pub fn open(transport: Arc<dyn Transport>, key: Secret, mut cache: Cache, default_policy: WritePolicy) -> Result<Engine, EngineError> {
        let digest = key.digest_hex();
        if cache.meta("history")?.as_deref() != Some(digest.as_str()) {
            cache.reset_history()?;
            cache.set_meta("history", &digest)?;
        }
        let policy = match cache.meta("policy")? {
            Some(json) => serde_json::from_str(&json).unwrap_or_default(),
            None => {
                cache.set_meta("policy", &serde_json::to_string(&default_policy).unwrap())?;
                default_policy
            }
        };
        let mut state = State::new();
        let entries = cache.load_entries()?;
        if let Err(e) = state.apply_entries(0, &entries) {
            log::warn!("cached history could not be replayed ({e}); starting a fresh download");
            cache.reset_history()?;
            state = State::new();
        }
        // A write recorded as "sending" means the app stopped mid-commit.
        for entry in cache.journal_open()? {
            if entry.status == JournalStatus::Sending {
                cache.journal_set(entry.id, JournalStatus::Uncertain, Some("The app closed while this change was being sent."))?;
            }
        }
        Ok(Engine { transport, key, cache, state, policy })
    }

    pub fn state(&self) -> &State {
        &self.state
    }

    pub fn snapshot(&self) -> Snapshot {
        Snapshot::from_state(&self.state)
    }

    pub fn policy(&self) -> WritePolicy {
        self.policy
    }

    pub fn set_policy(&mut self, policy: WritePolicy) -> Result<(), CacheError> {
        let policy = WritePolicy { writes: policy.writes, destructive: policy.writes && policy.destructive };
        self.cache.set_meta("policy", &serde_json::to_string(&policy).unwrap())?;
        self.policy = policy;
        Ok(())
    }

    /// Writes whose outcome is not known; they block further writes.
    pub fn issues(&self) -> Result<Vec<JournalEntry>, CacheError> {
        self.cache.journal_open()
    }

    pub fn recent_writes(&self, limit: usize) -> Result<Vec<JournalEntry>, CacheError> {
        self.cache.journal_recent(limit)
    }

    pub fn due_reminders(&self, after: chrono::NaiveDateTime, until: chrono::NaiveDateTime) -> Vec<model::DueReminder> {
        model::due_reminders(&self.state, after, until)
    }

    /// The user has checked (e.g. on their iPhone) and accepts the outcome.
    pub fn dismiss_issue(&mut self, journal_id: i64) -> Result<(), CacheError> {
        self.cache.journal_set(journal_id, JournalStatus::Dismissed, None)
    }

    /// User-initiated: dismiss an unresolved write and apply it again as a
    /// brand-new change (fresh timestamps), through the normal pipeline.
    pub fn reapply_issue(&mut self, journal_id: i64, ctx: &Ctx) -> Result<WriteReport, WriteError> {
        let entry = self.cache.journal_get(journal_id)?.ok_or(WriteError::NotFound { message: "change not found".into() })?;
        let m: Mutation = serde_json::from_str(&entry.mutation).map_err(|e| WriteError::Invalid { message: e.to_string() })?;
        self.cache.journal_set(journal_id, JournalStatus::Dismissed, Some("Re-applied by the user"))?;
        self.apply(&m, false, ctx)
    }

    /// Pulls every new history entry. Safe to call repeatedly.
    pub fn sync(&mut self) -> Result<SyncReport, EngineError> {
        let mut report = SyncReport::default();
        loop {
            let start = self.state.applied_index;
            let page = self.transport.items(&self.key, start)?;
            validate_page(&page)?;
            if page.start_index != start {
                return Err(CloudError::Protocol(format!("asked for index {start}, got {}", page.start_index)).into());
            }
            for entry in &page.entries {
                State::validate_entry(entry)?;
            }
            // Persist first; applying a validated page cannot fail.
            self.cache.append_entries(start, &page.entries)?;
            self.state.apply_entries(start, &page.entries)?;
            report.new_entries += page.entries.len() as u64;
            self.reconcile_page(&page, &mut report)?;
            if !page.has_more() {
                break;
            }
        }
        // Fully caught up: an uncertain write that never appeared was not stored.
        for entry in self.cache.journal_open()? {
            if entry.status == JournalStatus::Uncertain && entry.ancestor <= self.state.applied_index {
                self.cache.journal_set(
                    entry.id,
                    JournalStatus::Missing,
                    Some("This change was not found in Things Cloud after a full sync, so it was most likely not saved."),
                )?;
                report.missing.push(entry.id);
            }
        }
        Ok(report)
    }

    fn reconcile_page(&mut self, page: &ItemsPage, report: &mut SyncReport) -> Result<(), CacheError> {
        let open: Vec<JournalEntry> = self.cache.journal_open()?.into_iter().filter(|e| e.status != JournalStatus::Sending).collect();
        for entry in open {
            if page.entries.iter().any(|remote| contains_write(remote, &entry.items)) {
                self.cache.journal_set(entry.id, JournalStatus::Committed, Some("Confirmed by reading Things Cloud."))?;
                report.reconciled.push(entry.id);
            }
        }
        Ok(())
    }

    /// Applies one user edit. See the module docs for the safety steps.
    pub fn apply(&mut self, m: &Mutation, force: bool, ctx: &Ctx) -> Result<WriteReport, WriteError> {
        if !self.policy.writes {
            return Err(WriteError::ReadOnly);
        }
        if m.class() == WriteClass::Destructive && !self.policy.destructive {
            return Err(WriteError::DestructiveDisabled);
        }
        if let Some(open) = self.cache.journal_open()?.first() {
            return Err(WriteError::Blocked { journal_id: open.id });
        }

        self.sync().map_err(|e| WriteError::Sync { message: e.to_string() })?;
        // Sync may have reconciled/missed nothing new, but re-check the gate.
        if let Some(open) = self.cache.journal_open()?.first() {
            return Err(WriteError::Blocked { journal_id: open.id });
        }

        let plan = mutation::plan(&self.state, m, ctx)?;
        if !force {
            for t in &plan.touched {
                let Some(base) = t.base_rev else { continue };
                let revs = self
                    .state
                    .revs(&t.id)
                    .ok_or_else(|| WriteError::NotFound { message: "This item was deleted on another device.".into() })?;
                let changed = revs.changed_since(base, t.keys.iter().map(String::as_str));
                if !changed.is_empty() {
                    return Err(WriteError::Conflict { entity_id: t.id.clone(), fields: changed.iter().map(|k| field_label(k)).collect() });
                }
            }
        }
        // Our own payloads must pass the same validation as remote data.
        State::validate_entry(&plan.items).map_err(|e| WriteError::Invalid { message: format!("internal validation failed: {e}") })?;

        let ancestor = self.state.applied_index;
        let mutation_json = serde_json::to_string(m).unwrap_or_default();
        let journal_id = self.cache.journal_insert(&plan.summary, &mutation_json, &plan.items, ancestor, ctx.now)?;

        match self.transport.commit(&self.key, ancestor, &plan.items) {
            Ok(head) if head == ancestor + 1 => {
                self.cache.append_entries(ancestor, std::slice::from_ref(&plan.items))?;
                self.state
                    .apply_entries(ancestor, std::slice::from_ref(&plan.items))
                    .map_err(|e| WriteError::Storage { message: e.to_string() })?;
                self.cache.journal_set(journal_id, JournalStatus::Committed, None)?;
                Ok(WriteReport { created: plan.created, summary: plan.summary, server_index: head, reconciled: false })
            }
            Ok(head) => self.after_uncertain(journal_id, format!("server reported index {head}, expected {}", ancestor + 1), plan),
            Err(CommitError::Rejected(e)) => {
                let message = e.to_string();
                self.cache.journal_set(journal_id, JournalStatus::Rejected, Some(&message))?;
                Err(WriteError::Rejected { message, journal_id })
            }
            Err(CommitError::Uncertain(msg)) => self.after_uncertain(journal_id, msg, plan),
        }
    }

    fn after_uncertain(&mut self, journal_id: i64, message: String, plan: mutation::Plan) -> Result<WriteReport, WriteError> {
        self.cache.journal_set(journal_id, JournalStatus::Uncertain, Some(&message))?;
        log::warn!("write {journal_id} has an uncertain outcome: {message}; reconciling by reading");
        // Reading is safe. Resending is not.
        if let Ok(report) = self.sync() {
            if report.reconciled.contains(&journal_id) {
                return Ok(WriteReport {
                    created: plan.created,
                    summary: plan.summary,
                    server_index: self.state.applied_index,
                    reconciled: true,
                });
            }
        }
        Err(WriteError::Uncertain { message, journal_id })
    }
}

/// True when `remote` (one history entry) holds exactly our events, matched
/// by id, kind, action and the unique timestamp we stamped (`md`, or `cd`
/// for creates).
fn contains_write(remote: &[Item], expected: &[Item]) -> bool {
    !expected.is_empty()
        && expected.iter().all(|want| {
            remote.iter().any(|got| {
                got.uuid == want.uuid && got.kind == want.kind && got.action == want.action && stamp(&got.payload) == stamp(&want.payload)
            })
        })
}

fn stamp(payload: &Value) -> Option<f64> {
    payload.get("md").and_then(Value::as_f64).or_else(|| payload.get("cd").and_then(Value::as_f64))
}

fn field_label(key: &str) -> String {
    match key {
        "tt" => "title",
        "nt" => "notes",
        "st" | "sr" | "tir" | "sb" => "when",
        "dd" => "deadline",
        "ss" | "sp" => "status",
        "tr" => "trash",
        "ar" | "pr" | "agr" => "location",
        "tg" => "tags",
        "rmd" | "ato" => "reminder",
        "rt" | "rr" | "icsd" => "repeat",
        other => other,
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cache::Cache;
    use chrono::NaiveDate;
    use serde_json::json;
    use things_cloud::fake::{FailMode, FakeCloud};
    use things_cloud::id;

    fn ctx() -> Ctx {
        Ctx { today: NaiveDate::from_ymd_opt(2026, 2, 10).unwrap(), now: things_cloud::dates::now_ts() }
    }

    const WRITES: WritePolicy = WritePolicy { writes: true, destructive: false };

    struct Setup {
        fake: Arc<FakeCloud>,
        engine: Engine,
        task: String,
    }

    fn setup(policy: WritePolicy) -> Setup {
        let fake = Arc::new(FakeCloud::new("me@example.com", "pw"));
        let task = id::new_id();
        fake.push_remote(vec![Item::new(&task, "Task6", 0, json!({"tt":"Original","st":0,"ix":3}))]);
        let mut engine = Engine::open(fake.clone(), fake.history_key(), Cache::in_memory().unwrap(), policy).unwrap();
        engine.sync().unwrap();
        Setup { fake, engine, task }
    }

    fn rename(id: &str, base: u64, title: &str) -> Mutation {
        Mutation::UpdateTask { id: id.into(), base_rev: Some(base), title: Some(title.into()), notes: None, deadline: None, tag_ids: None }
    }

    #[test]
    fn read_only_by_default() {
        let mut s = setup(WritePolicy::default());
        let err = s.engine.apply(&rename(&s.task, 0, "x"), false, &ctx()).unwrap_err();
        assert_eq!(err, WriteError::ReadOnly);
        assert_eq!(s.fake.commits_received(), 0);
        let err = {
            s.engine.set_policy(WRITES).unwrap();
            s.engine.apply(&Mutation::DeleteChecklistItem { id: id::new_id() }, false, &ctx()).unwrap_err()
        };
        assert_eq!(err, WriteError::DestructiveDisabled);
        // Destructive cannot be on without writes.
        s.engine.set_policy(WritePolicy { writes: false, destructive: true }).unwrap();
        assert!(!s.engine.policy().destructive);
    }

    #[test]
    fn writes_commit_once_and_apply_locally() {
        let mut s = setup(WRITES);
        let r = s.engine.apply(&rename(&s.task, 0, "Renamed"), false, &ctx()).unwrap();
        assert_eq!(r.server_index, 2);
        assert_eq!(s.engine.state().tasks[&s.task].title, "Renamed");
        assert_eq!(s.fake.entries().len(), 2);
        assert_eq!(s.fake.commits_received(), 1);
        // A later sync does not double-apply our own entry.
        assert_eq!(s.engine.sync().unwrap().new_entries, 0);
        let created = s.engine.apply(&serde_json::from_value(json!({"type":"createTask","title":"New"})).unwrap(), false, &ctx()).unwrap();
        assert!(s.engine.state().tasks.contains_key(&created.created[0]));
    }

    #[test]
    fn detects_field_level_conflicts() {
        let mut s = setup(WRITES);
        // iPhone renames the task after the user opened it at rev 0.
        s.fake.push_remote(vec![Item::new(&s.task, "Task6", 1, json!({"tt":"From iPhone","md":2.0}))]);
        let err = s.engine.apply(&rename(&s.task, 0, "From Windows"), false, &ctx()).unwrap_err();
        assert_eq!(err, WriteError::Conflict { entity_id: s.task.clone(), fields: vec!["title".into()] });
        assert_eq!(s.fake.commits_received(), 0, "conflicts are detected before sending");
        assert_eq!(s.engine.state().tasks[&s.task].title, "From iPhone");

        // A change to a different field merges without asking.
        let notes = Mutation::UpdateTask {
            id: s.task.clone(),
            base_rev: Some(0),
            title: None,
            notes: Some("n".into()),
            deadline: None,
            tag_ids: None,
        };
        s.engine.apply(&notes, false, &ctx()).unwrap();
        assert_eq!(s.engine.state().tasks[&s.task].title, "From iPhone");

        // The user can explicitly choose to overwrite.
        s.engine.apply(&rename(&s.task, 0, "From Windows"), true, &ctx()).unwrap();
        assert_eq!(s.engine.state().tasks[&s.task].title, "From Windows");
    }

    #[test]
    fn remote_deletion_is_reported() {
        let mut s = setup(WRITES);
        s.fake.push_remote(vec![Item::new(id::new_id(), "Tombstone2", 0, json!({"dloid": s.task, "dld": 1.0}))]);
        let err = s.engine.apply(&rename(&s.task, 0, "x"), false, &ctx()).unwrap_err();
        assert!(matches!(err, WriteError::NotFound { .. }), "{err:?}");
        assert!(s.engine.snapshot().tasks.is_empty());
    }

    #[test]
    fn rejected_writes_are_not_retried() {
        let mut s = setup(WRITES);
        s.fake.fail_next_commit(FailMode::Reject(CloudError::Http { status: 400, things_response: None }));
        let err = s.engine.apply(&rename(&s.task, 0, "x"), false, &ctx()).unwrap_err();
        assert!(matches!(err, WriteError::Rejected { .. }));
        assert_eq!(s.fake.commits_received(), 1);
        assert_eq!(s.engine.state().tasks[&s.task].title, "Original");
        // Rejections do not block: the user may try again by hand.
        s.engine.apply(&rename(&s.task, 0, "x"), false, &ctx()).unwrap();
        assert_eq!(s.fake.commits_received(), 2);
    }

    #[test]
    fn uncertain_write_that_landed_is_reconciled_without_resending() {
        let mut s = setup(WRITES);
        s.fake.fail_next_commit(FailMode::UncertainApplied);
        let r = s.engine.apply(&rename(&s.task, 0, "Landed"), false, &ctx()).unwrap();
        assert!(r.reconciled);
        assert_eq!(s.fake.commits_received(), 1, "never resent");
        assert_eq!(s.fake.entries().len(), 2, "exactly one copy in the history");
        assert_eq!(s.engine.state().tasks[&s.task].title, "Landed");
        assert!(s.engine.issues().unwrap().is_empty());
    }

    #[test]
    fn uncertain_write_that_was_lost_blocks_until_user_decides() {
        let mut s = setup(WRITES);
        s.fake.fail_next_commit(FailMode::UncertainNotApplied);
        let err = s.engine.apply(&rename(&s.task, 0, "Lost"), false, &ctx()).unwrap_err();
        let WriteError::Uncertain { journal_id, .. } = err else { panic!("{err:?}") };
        assert_eq!(s.fake.commits_received(), 1);
        let issues = s.engine.issues().unwrap();
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].status, JournalStatus::Missing);
        // Further writes are blocked, and nothing is sent.
        assert_eq!(s.engine.apply(&rename(&s.task, 0, "Other"), false, &ctx()).unwrap_err(), WriteError::Blocked { journal_id });
        assert_eq!(s.fake.commits_received(), 1);
        // Explicit user action re-applies it as a new change.
        s.engine.reapply_issue(journal_id, &ctx()).unwrap();
        assert_eq!(s.engine.state().tasks[&s.task].title, "Lost");
        assert_eq!(s.fake.commits_received(), 2);
        assert!(s.engine.issues().unwrap().is_empty());
    }

    #[test]
    fn crash_during_send_is_recovered_as_uncertain() {
        let fake = Arc::new(FakeCloud::new("me@example.com", "pw"));
        let dir = std::env::temp_dir().join(format!("cairn-engine-{}", id::new_id()));
        let path = dir.join("cache.sqlite");
        let task = id::new_id();
        fake.push_remote(vec![Item::new(&task, "Task6", 0, json!({"tt":"A"}))]);
        let item = Item::new(&task, "Task6", 1, json!({"tt":"B","md":42.5}));
        {
            let mut e = Engine::open(fake.clone(), fake.history_key(), Cache::open(&path).unwrap(), WRITES).unwrap();
            e.sync().unwrap();
            // Simulate: journal written, request delivered, app killed before the reply.
            e.cache.journal_insert("Rename", "{}", std::slice::from_ref(&item), 1, 1.0).unwrap();
            fake.commit(&fake.history_key(), 1, &[item]).unwrap();
        }
        let mut e = Engine::open(fake.clone(), fake.history_key(), Cache::open(&path).unwrap(), WRITES).unwrap();
        assert_eq!(e.issues().unwrap()[0].status, JournalStatus::Uncertain);
        assert_eq!(e.state().tasks[&task].title, "A", "cache replayed offline");
        let report = e.sync().unwrap();
        assert_eq!(report.reconciled.len(), 1);
        assert!(e.issues().unwrap().is_empty());
        assert_eq!(e.state().tasks[&task].title, "B");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn sync_is_atomic_per_page_and_fails_closed() {
        let fake = Arc::new(FakeCloud::new("me@example.com", "pw"));
        fake.set_page_size(1);
        for i in 0..3 {
            fake.push_remote(vec![Item::new(id::new_id(), "Area3", 0, json!({"tt": format!("A{i}")}))]);
        }
        fake.push_remote(vec![Item::new(id::new_id(), "Task99", 0, json!({}))]);
        let mut e = Engine::open(fake.clone(), fake.history_key(), Cache::in_memory().unwrap(), WRITES).unwrap();
        assert!(matches!(e.sync(), Err(EngineError::State(_))));
        assert_eq!(e.state().applied_index, 3, "good pages kept, bad page not applied");
        assert_eq!(e.cache.cursor().unwrap(), 3);

        let fake2 = Arc::new(FakeCloud::new("me@example.com", "pw"));
        fake2.set_schema(302);
        let mut e2 = Engine::open(fake2.clone(), fake2.history_key(), Cache::in_memory().unwrap(), WRITES).unwrap();
        assert!(matches!(e2.sync(), Err(EngineError::Cloud(CloudError::UnsupportedSchema { .. }))));
        assert!(matches!(e2.apply(&Mutation::CreateArea { title: "x".into() }, false, &ctx()), Err(WriteError::Sync { .. })));
        assert_eq!(fake2.commits_received(), 0, "no writes against an unknown schema");
    }

    #[test]
    fn cache_is_bound_to_one_history() {
        let fake = Arc::new(FakeCloud::new("me@example.com", "pw"));
        fake.push_remote(vec![Item::new(id::new_id(), "Area3", 0, json!({"tt":"Mine"}))]);
        let dir = std::env::temp_dir().join(format!("cairn-bind-{}", id::new_id()));
        let path = dir.join("cache.sqlite");
        let mut e = Engine::open(fake.clone(), fake.history_key(), Cache::open(&path).unwrap(), WRITES).unwrap();
        e.sync().unwrap();
        drop(e);
        let other = Arc::new(FakeCloud::new("other@example.com", "pw"));
        let e = Engine::open(other.clone(), other.history_key(), Cache::open(&path).unwrap(), WRITES).unwrap();
        assert!(e.state().areas.is_empty(), "another history's data is discarded");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
