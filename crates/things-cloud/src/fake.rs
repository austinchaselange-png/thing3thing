//! In-memory Things Cloud used for tests, the offline demo account and
//! failure simulation. Semantics follow what the real service is known to do:
//! an append-only list of entries, paging by index, commits that carry an
//! ancestor index. A demo instance can persist its history to a JSON file.

use std::path::PathBuf;
use std::sync::Mutex;

use crate::transport::{Account, HistoryHead, ItemsPage, Transport};
use crate::{id, CloudError, CommitError, Item, Secret, SUPPORTED_SCHEMA};

/// How the next commit should fail.
#[derive(Debug, Clone)]
pub enum FailMode {
    /// Server answers with an error; nothing is stored.
    Reject(CloudError),
    /// Connection drops after the server stored the commit.
    UncertainApplied,
    /// Connection drops before the server stored the commit.
    UncertainNotApplied,
}

struct Inner {
    email: String,
    password: Secret,
    key: Secret,
    history: Vec<Vec<Item>>,
    schema: u32,
    page_size: usize,
    fail_next_commit: Option<FailMode>,
    fail_reads: Option<CloudError>,
    commits_received: usize,
    persist: Option<PathBuf>,
}

pub struct FakeCloud {
    inner: Mutex<Inner>,
}

impl FakeCloud {
    pub fn new(email: &str, password: &str) -> Self {
        FakeCloud {
            inner: Mutex::new(Inner {
                email: email.to_string(),
                password: Secret::new(password),
                key: Secret::new(format!("fake-{}", id::new_id())),
                history: Vec::new(),
                schema: SUPPORTED_SCHEMA,
                page_size: 100,
                fail_next_commit: None,
                fail_reads: None,
                commits_received: 0,
                persist: None,
            }),
        }
    }

    /// Opens (or creates with `seed`) a fake whose history is saved to `path`.
    pub fn persistent(path: PathBuf, seed: impl FnOnce() -> Vec<Vec<Item>>) -> Self {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let fake = FakeCloud::new("demo@tings3.local", "demo");
        let history =
            std::fs::read(&path).ok().and_then(|bytes| serde_json::from_slice::<Vec<Vec<Item>>>(&bytes).ok()).unwrap_or_else(seed);
        {
            let mut inner = fake.inner.lock().unwrap();
            inner.history = history;
            inner.key = Secret::new("demo-history");
            inner.persist = Some(path);
        }
        fake.save();
        fake
    }

    fn save(&self) {
        let inner = self.inner.lock().unwrap();
        if let Some(path) = &inner.persist {
            if let Ok(bytes) = serde_json::to_vec(&inner.history) {
                let tmp = path.with_extension("tmp");
                if std::fs::write(&tmp, bytes).is_ok() {
                    let _ = std::fs::rename(&tmp, path);
                }
            }
        }
    }

    pub fn history_key(&self) -> Secret {
        self.inner.lock().unwrap().key.clone()
    }

    pub fn set_page_size(&self, n: usize) {
        self.inner.lock().unwrap().page_size = n.max(1);
    }

    pub fn set_schema(&self, schema: u32) {
        self.inner.lock().unwrap().schema = schema;
    }

    /// The whole local history: what an "On this PC" backup needs to restore exactly.
    pub fn history(&self) -> Vec<Vec<Item>> {
        self.inner.lock().unwrap().history.clone()
    }

    /// Simulates a change made by another device (e.g. Things on iPhone).
    pub fn push_remote(&self, entry: Vec<Item>) {
        self.inner.lock().unwrap().history.push(entry);
        self.save();
    }

    pub fn fail_next_commit(&self, mode: FailMode) {
        self.inner.lock().unwrap().fail_next_commit = Some(mode);
    }

    pub fn fail_reads(&self, err: Option<CloudError>) {
        self.inner.lock().unwrap().fail_reads = err;
    }

    pub fn entries(&self) -> Vec<Vec<Item>> {
        self.inner.lock().unwrap().history.clone()
    }

    /// Number of commit requests received (including failed ones).
    pub fn commits_received(&self) -> usize {
        self.inner.lock().unwrap().commits_received
    }

    fn check_key(inner: &Inner, key: &Secret) -> Result<(), CloudError> {
        if key != &inner.key {
            return Err(CloudError::Http { status: 404, things_response: None });
        }
        if let Some(e) = &inner.fail_reads {
            return Err(e.clone());
        }
        Ok(())
    }
}

impl Transport for FakeCloud {
    fn verify(&self, email: &str, password: &Secret) -> Result<Account, CloudError> {
        let inner = self.inner.lock().unwrap();
        if email != inner.email || password != &inner.password {
            return Err(CloudError::Unauthorized);
        }
        Ok(Account { email: email.to_string(), history_key: inner.key.clone(), status: "SYAccountStatusActive".into() })
    }

    fn history_head(&self, key: &Secret) -> Result<HistoryHead, CloudError> {
        let inner = self.inner.lock().unwrap();
        Self::check_key(&inner, key)?;
        Ok(HistoryHead { latest_server_index: inner.history.len() as u64, schema: inner.schema })
    }

    fn items(&self, key: &Secret, start_index: u64) -> Result<ItemsPage, CloudError> {
        let inner = self.inner.lock().unwrap();
        Self::check_key(&inner, key)?;
        let head = inner.history.len() as u64;
        if start_index > head {
            return Err(CloudError::Http { status: 500, things_response: None });
        }
        let start = start_index as usize;
        let end = (start + inner.page_size).min(inner.history.len());
        Ok(ItemsPage { start_index, entries: inner.history[start..end].to_vec(), current_item_index: head, schema: inner.schema })
    }

    fn commit(&self, key: &Secret, ancestor_index: u64, items: &[Item]) -> Result<u64, CommitError> {
        let result = {
            let mut inner = self.inner.lock().unwrap();
            inner.commits_received += 1;
            if key != &inner.key {
                return Err(CommitError::Rejected(CloudError::Http { status: 404, things_response: None }));
            }
            let head = inner.history.len() as u64;
            if ancestor_index > head {
                return Err(CommitError::Rejected(CloudError::Http { status: 409, things_response: None }));
            }
            match inner.fail_next_commit.take() {
                Some(FailMode::Reject(e)) => return Err(CommitError::Rejected(e)),
                Some(FailMode::UncertainNotApplied) => return Err(CommitError::Uncertain("connection reset (simulated)".into())),
                Some(FailMode::UncertainApplied) => {
                    inner.history.push(items.to_vec());
                    Err(CommitError::Uncertain("timed out waiting for response (simulated)".into()))
                }
                None => {
                    inner.history.push(items.to_vec());
                    Ok(inner.history.len() as u64)
                }
            }
        };
        self.save();
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn pages_and_commits() {
        let fake = FakeCloud::new("a@b.c", "pw");
        fake.set_page_size(2);
        let key = fake.verify("a@b.c", &Secret::new("pw")).unwrap().history_key;
        assert_eq!(fake.verify("a@b.c", &Secret::new("nope")).unwrap_err(), CloudError::Unauthorized);
        for i in 0..3 {
            fake.push_remote(vec![Item::new(format!("x{i}"), "Area3", 0, json!({"tt":"a"}))]);
        }
        let p = fake.items(&key, 0).unwrap();
        assert_eq!(p.entries.len(), 2);
        assert!(p.has_more());
        assert_eq!(fake.commit(&key, 3, &[Item::new("y", "Area3", 0, json!({}))]).unwrap(), 4);
        assert!(matches!(fake.commit(&key, 9, &[]), Err(CommitError::Rejected(_))));
        fake.fail_next_commit(FailMode::UncertainNotApplied);
        assert!(matches!(fake.commit(&key, 4, &[]), Err(CommitError::Uncertain(_))));
        assert_eq!(fake.history_head(&key).unwrap().latest_server_index, 4);
        assert_eq!(fake.commits_received(), 3);
    }

    #[test]
    fn persists_history() {
        let dir = std::env::temp_dir().join(format!("tings3-fake-{}", id::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("demo.json");
        let a = FakeCloud::persistent(path.clone(), || vec![vec![Item::new("s", "Area3", 0, json!({"tt":"Seed"}))]]);
        a.push_remote(vec![Item::new("t", "Area3", 0, json!({"tt":"Two"}))]);
        let b = FakeCloud::persistent(path, Vec::new);
        assert_eq!(b.entries().len(), 2);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
