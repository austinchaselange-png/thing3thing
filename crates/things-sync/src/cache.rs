//! SQLite cache: the raw event log pulled from Things Cloud, the sync cursor,
//! settings for this account, and the write journal.
//!
//! No credentials are stored here. The history is bound to a fingerprint of
//! the history key so a different account's events are never mixed in.

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use things_cloud::Item;

#[derive(Debug, thiserror::Error)]
#[error("local cache error: {0}")]
pub struct CacheError(String);

impl From<rusqlite::Error> for CacheError {
    fn from(e: rusqlite::Error) -> Self {
        CacheError(e.to_string())
    }
}

impl From<serde_json::Error> for CacheError {
    fn from(e: serde_json::Error) -> Self {
        CacheError(e.to_string())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum JournalStatus {
    /// Recorded before the request was sent. Found at startup ⇒ uncertain.
    Sending,
    Committed,
    Rejected,
    /// Sent, outcome unknown. Blocks further writes until resolved.
    Uncertain,
    /// Uncertain write not found in the history after a full sync.
    Missing,
    /// The user acknowledged an uncertain/missing write.
    Dismissed,
}

impl JournalStatus {
    fn as_str(self) -> &'static str {
        match self {
            JournalStatus::Sending => "sending",
            JournalStatus::Committed => "committed",
            JournalStatus::Rejected => "rejected",
            JournalStatus::Uncertain => "uncertain",
            JournalStatus::Missing => "missing",
            JournalStatus::Dismissed => "dismissed",
        }
    }

    fn parse(s: &str) -> JournalStatus {
        match s {
            "sending" => JournalStatus::Sending,
            "committed" => JournalStatus::Committed,
            "rejected" => JournalStatus::Rejected,
            "missing" => JournalStatus::Missing,
            "dismissed" => JournalStatus::Dismissed,
            _ => JournalStatus::Uncertain,
        }
    }

    pub fn blocks_writes(self) -> bool {
        matches!(self, JournalStatus::Sending | JournalStatus::Uncertain | JournalStatus::Missing)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalEntry {
    pub id: i64,
    pub created_at: f64,
    pub summary: String,
    #[serde(skip)]
    pub mutation: String,
    #[serde(skip)]
    pub items: Vec<Item>,
    pub ancestor: u64,
    pub status: JournalStatus,
    pub detail: Option<String>,
}

pub struct Cache {
    conn: Connection,
}

impl Cache {
    pub fn open(path: &Path) -> Result<Cache, CacheError> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| CacheError(e.to_string()))?;
        }
        Self::init(Connection::open(path)?)
    }

    pub fn in_memory() -> Result<Cache, CacheError> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Cache, CacheError> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = FULL;
             CREATE TABLE IF NOT EXISTS events (
                 idx INTEGER NOT NULL, seq INTEGER NOT NULL, uuid TEXT NOT NULL,
                 kind TEXT NOT NULL, action INTEGER NOT NULL, payload TEXT NOT NULL,
                 PRIMARY KEY (idx, seq));
             CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS journal (
                 id INTEGER PRIMARY KEY AUTOINCREMENT, created_at REAL NOT NULL,
                 summary TEXT NOT NULL, mutation TEXT NOT NULL, items TEXT NOT NULL,
                 ancestor INTEGER NOT NULL, status TEXT NOT NULL, detail TEXT);",
        )?;
        Ok(Cache { conn })
    }

    pub fn meta(&self, key: &str) -> Result<Option<String>, CacheError> {
        Ok(self.conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0)).optional()?)
    }

    pub fn set_meta(&self, key: &str, value: &str) -> Result<(), CacheError> {
        self.conn.execute("INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2", [key, value])?;
        Ok(())
    }

    /// Number of history entries stored (the next index to pull).
    pub fn cursor(&self) -> Result<u64, CacheError> {
        Ok(self.meta("cursor")?.and_then(|v| v.parse().ok()).unwrap_or(0))
    }

    /// All stored entries in order, for replay at startup.
    pub fn load_entries(&self) -> Result<Vec<Vec<Item>>, CacheError> {
        let cursor = self.cursor()?;
        let mut stmt = self.conn.prepare("SELECT idx, uuid, kind, action, payload FROM events WHERE idx < ?1 ORDER BY idx, seq")?;
        let mut entries: Vec<Vec<Item>> = (0..cursor).map(|_| Vec::new()).collect();
        let rows = stmt.query_map([cursor as i64], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, u8>(3)?, r.get::<_, String>(4)?))
        })?;
        for row in rows {
            let (idx, uuid, kind, action, payload) = row?;
            let payload = serde_json::from_str(&payload)?;
            entries[idx as usize].push(Item { uuid, kind, action, payload });
        }
        Ok(entries)
    }

    /// Appends entries starting at `start` and advances the cursor, atomically.
    pub fn append_entries(&mut self, start: u64, entries: &[Vec<Item>]) -> Result<(), CacheError> {
        let cursor = self.cursor()?;
        if start != cursor {
            return Err(CacheError(format!("append at {start} but cache cursor is {cursor}")));
        }
        let tx = self.conn.transaction()?;
        {
            let mut stmt = tx.prepare("INSERT INTO events (idx, seq, uuid, kind, action, payload) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")?;
            for (offset, entry) in entries.iter().enumerate() {
                for (seq, item) in entry.iter().enumerate() {
                    stmt.execute(params![
                        (start + offset as u64) as i64,
                        seq as i64,
                        item.uuid,
                        item.kind,
                        item.action,
                        serde_json::to_string(&item.payload)?
                    ])?;
                }
            }
        }
        let next = start + entries.len() as u64;
        tx.execute("INSERT INTO meta (key, value) VALUES ('cursor', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1", [next.to_string()])?;
        tx.commit()?;
        Ok(())
    }

    /// Drops the event log (e.g. when the history key changed).
    pub fn reset_history(&mut self) -> Result<(), CacheError> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM events", [])?;
        tx.execute("DELETE FROM meta WHERE key = 'cursor'", [])?;
        tx.commit()?;
        Ok(())
    }

    pub fn journal_insert(&self, summary: &str, mutation: &str, items: &[Item], ancestor: u64, created_at: f64) -> Result<i64, CacheError> {
        self.conn.execute(
            "INSERT INTO journal (created_at, summary, mutation, items, ancestor, status) VALUES (?1, ?2, ?3, ?4, ?5, 'sending')",
            params![created_at, summary, mutation, serde_json::to_string(items)?, ancestor as i64],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn journal_set(&self, id: i64, status: JournalStatus, detail: Option<&str>) -> Result<(), CacheError> {
        self.conn
            .execute("UPDATE journal SET status = ?2, detail = COALESCE(?3, detail) WHERE id = ?1", params![id, status.as_str(), detail])?;
        Ok(())
    }

    pub fn journal_get(&self, id: i64) -> Result<Option<JournalEntry>, CacheError> {
        Ok(self.journal_query("WHERE id = ?1", params![id])?.into_iter().next())
    }

    /// Entries that block writes (sending / uncertain / missing).
    pub fn journal_open(&self) -> Result<Vec<JournalEntry>, CacheError> {
        self.journal_query("WHERE status IN ('sending', 'uncertain', 'missing')", [])
    }

    pub fn journal_recent(&self, limit: usize) -> Result<Vec<JournalEntry>, CacheError> {
        self.journal_query("ORDER BY id DESC LIMIT ?1", params![limit as i64])
    }

    fn journal_query(&self, clause: &str, p: impl rusqlite::Params) -> Result<Vec<JournalEntry>, CacheError> {
        let sql = format!("SELECT id, created_at, summary, mutation, items, ancestor, status, detail FROM journal {clause}");
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(p, |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, f64>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, i64>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, Option<String>>(7)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (id, created_at, summary, mutation, items, ancestor, status, detail) = row?;
            out.push(JournalEntry {
                id,
                created_at,
                summary,
                mutation,
                items: serde_json::from_str(&items)?,
                ancestor: ancestor as u64,
                status: JournalStatus::parse(&status),
                detail,
            });
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn stores_entries_and_cursor_atomically() {
        let mut c = Cache::in_memory().unwrap();
        let e = vec![vec![Item::new("A", "Area3", 0, json!({"tt":"x"})), Item::new("B", "Tag4", 0, json!({}))], vec![]];
        c.append_entries(0, &e).unwrap();
        assert_eq!(c.cursor().unwrap(), 2);
        assert!(c.append_entries(5, &e).is_err(), "gaps are refused");
        let loaded = c.load_entries().unwrap();
        assert_eq!(loaded, e);
        c.reset_history().unwrap();
        assert_eq!(c.cursor().unwrap(), 0);
        assert!(c.load_entries().unwrap().is_empty());
    }

    #[test]
    fn journal_lifecycle() {
        let c = Cache::in_memory().unwrap();
        let id = c.journal_insert("Create", "{}", &[Item::new("A", "Task6", 0, json!({}))], 3, 1.0).unwrap();
        assert_eq!(c.journal_open().unwrap().len(), 1);
        c.journal_set(id, JournalStatus::Uncertain, Some("timeout")).unwrap();
        let e = c.journal_get(id).unwrap().unwrap();
        assert_eq!(e.status, JournalStatus::Uncertain);
        assert_eq!(e.detail.as_deref(), Some("timeout"));
        assert_eq!(e.items.len(), 1);
        c.journal_set(id, JournalStatus::Committed, None).unwrap();
        assert!(c.journal_open().unwrap().is_empty());
        assert_eq!(c.journal_recent(5).unwrap()[0].detail.as_deref(), Some("timeout"));
    }
}
