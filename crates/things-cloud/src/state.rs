//! Aggregated state built by replaying history events in server order.
//!
//! Every event is a partial patch: keys that are present overwrite, an explicit
//! `null` clears, absent keys are untouched. For conflict detection we record,
//! per entity and per wire key, the server index of the last event that set it.

use std::collections::HashMap;

use chrono::NaiveDate;
use serde::Serialize;
use serde_json::{Map, Value};

use crate::wire::{action, is_legacy_kind, Family, Item};
use crate::{dates, id, note};

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum StateError {
    #[error("item {uuid} has unsupported kind {kind:?}")]
    UnknownKind { uuid: String, kind: String },
    #[error("item {uuid} ({kind}) has unsupported action {action}")]
    UnknownAction { uuid: String, kind: String, action: u8 },
    #[error("item {uuid} ({kind}): {reason}")]
    Malformed { uuid: String, kind: String, reason: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum TaskType {
    #[default]
    Task,
    Project,
    Heading,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    #[default]
    Open,
    Canceled,
    Completed,
}

/// The `st` field: 0 Inbox, 1 Anytime (Today when dated), 2 Someday (Upcoming when dated).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Start {
    Inbox,
    #[default]
    Anytime,
    Someday,
}

/// Server index of the last change, overall and per wire key.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Revs {
    pub rev: u64,
    pub fields: HashMap<String, u64>,
}

impl Revs {
    fn touch(&mut self, index: u64, payload: Option<&Map<String, Value>>) {
        self.rev = index;
        if let Some(map) = payload {
            for key in map.keys() {
                self.fields.insert(key.clone(), index);
            }
        }
    }

    /// Wire keys among `keys` changed after `base`.
    pub fn changed_since<'a>(&self, base: u64, keys: impl IntoIterator<Item = &'a str>) -> Vec<String> {
        keys.into_iter()
            .filter(|k| self.fields.get(*k).is_some_and(|r| *r > base))
            .map(str::to_string)
            .collect()
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Task {
    pub id: String,
    pub task_type: TaskType,
    pub title: String,
    pub notes: String,
    pub status: Status,
    pub start: Start,
    /// `sr`: scheduled start date.
    pub start_date: Option<NaiveDate>,
    /// `tir`: date the item shows in Today; advances for recurring instances.
    pub today_date: Option<NaiveDate>,
    /// `sb`: 1 = This Evening.
    pub start_bucket: i64,
    pub deadline: Option<NaiveDate>,
    pub reminder_date: Option<NaiveDate>,
    /// `ato`: reminder time as seconds after local midnight.
    pub alarm_offset: Option<i64>,
    pub created: Option<f64>,
    pub modified: Option<f64>,
    pub stopped: Option<f64>,
    pub index: i64,
    pub today_index: i64,
    pub areas: Vec<String>,
    pub projects: Vec<String>,
    pub headings: Vec<String>,
    pub tags: Vec<String>,
    /// `rt`: recurring template this instance belongs to.
    pub recurrence_templates: Vec<String>,
    /// `rr`: present only on recurring templates.
    pub recurrence_rule: Option<Value>,
    pub trashed: bool,
    pub revs: Revs,
}

impl Task {
    pub fn is_recurring_template(&self) -> bool {
        self.recurrence_rule.as_ref().is_some_and(|v| !v.is_null())
    }

    /// The date the visible occurrence is scheduled for (`tir`, else `sr`).
    pub fn effective_start_date(&self) -> Option<NaiveDate> {
        self.today_date.or(self.start_date)
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Area {
    pub id: String,
    pub title: String,
    pub index: i64,
    pub tags: Vec<String>,
    pub revs: Revs,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Tag {
    pub id: String,
    pub title: String,
    pub shortcut: Option<String>,
    pub parents: Vec<String>,
    pub index: i64,
    pub revs: Revs,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ChecklistItem {
    pub id: String,
    pub title: String,
    pub status: Status,
    pub index: i64,
    pub tasks: Vec<String>,
    pub created: Option<f64>,
    pub stopped: Option<f64>,
    pub revs: Revs,
}

#[derive(Debug, Clone, Default)]
pub struct State {
    pub tasks: HashMap<String, Task>,
    pub areas: HashMap<String, Area>,
    pub tags: HashMap<String, Tag>,
    pub checklist: HashMap<String, ChecklistItem>,
    /// Entities deleted remotely, with the index of the deletion.
    pub deleted: HashMap<String, u64>,
    /// Number of history entries applied (equals the next start index).
    pub applied_index: u64,
}

#[derive(Clone, Copy)]
enum Ty {
    Str,
    Int,
    Num,
    Bool,
    StrArray,
    Any,
}

fn task_key_type(key: &str) -> Ty {
    match key {
        "tt" => Ty::Str,
        "tp" | "ss" | "st" | "ix" | "ti" | "sb" | "ato" | "do" | "icc" => Ty::Int,
        "sr" | "tir" | "dd" | "rmd" | "icsd" | "cd" | "md" | "sp" | "dds" | "lai" | "acrd" => Ty::Num,
        "tr" | "icp" | "lt" => Ty::Bool,
        "ar" | "pr" | "agr" | "tg" | "rt" | "dl" => Ty::StrArray,
        _ => Ty::Any,
    }
}

fn area_key_type(key: &str) -> Ty {
    match key {
        "tt" => Ty::Str,
        "ix" => Ty::Int,
        "tg" => Ty::StrArray,
        _ => Ty::Any,
    }
}

fn tag_key_type(key: &str) -> Ty {
    match key {
        "tt" | "sh" => Ty::Str,
        "ix" => Ty::Int,
        "pn" => Ty::StrArray,
        _ => Ty::Any,
    }
}

fn checklist_key_type(key: &str) -> Ty {
    match key {
        "tt" => Ty::Str,
        "ss" | "ix" => Ty::Int,
        "cd" | "md" | "sp" => Ty::Num,
        "lt" => Ty::Bool,
        "ts" => Ty::StrArray,
        _ => Ty::Any,
    }
}

fn type_ok(ty: Ty, v: &Value) -> bool {
    if v.is_null() {
        return true;
    }
    match ty {
        Ty::Str => v.is_string(),
        Ty::Int => v.is_i64() || v.is_u64() || v.as_f64().is_some_and(|f| f.fract() == 0.0),
        Ty::Num => v.is_number(),
        Ty::Bool => v.is_boolean() || v.as_i64().is_some_and(|i| i == 0 || i == 1),
        Ty::StrArray => v.as_array().is_some_and(|a| a.iter().all(Value::is_string)),
        Ty::Any => true,
    }
}

fn as_i64(v: &Value) -> Option<i64> {
    v.as_i64().or_else(|| v.as_f64().map(|f| f as i64))
}

fn as_bool(v: &Value) -> bool {
    v.as_bool().unwrap_or_else(|| v.as_i64() == Some(1))
}

fn as_date(v: &Value) -> Option<NaiveDate> {
    v.as_f64().and_then(dates::wire_to_date)
}

fn as_ids(v: &Value, legacy: bool) -> Vec<String> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(|s| if legacy { id::normalize(s) } else { s.to_string() })
                .collect()
        })
        .unwrap_or_default()
}

impl State {
    pub fn new() -> Self {
        Self::default()
    }

    /// Validates one history entry without changing state.
    pub fn validate_entry(entry: &[Item]) -> Result<(), StateError> {
        for item in entry {
            validate_item(item)?;
        }
        Ok(())
    }

    /// Validates then applies a page of entries starting at `start_index`.
    /// All-or-nothing: on error nothing is applied.
    pub fn apply_entries(&mut self, start_index: u64, entries: &[Vec<Item>]) -> Result<(), StateError> {
        for entry in entries {
            Self::validate_entry(entry)?;
        }
        for (offset, entry) in entries.iter().enumerate() {
            let index = start_index + offset as u64;
            for item in entry {
                self.apply_validated(index, item);
            }
            self.applied_index = self.applied_index.max(index + 1);
        }
        Ok(())
    }

    fn apply_validated(&mut self, index: u64, item: &Item) {
        let family = Family::of(&item.kind).expect("validated");
        let legacy = is_legacy_kind(&item.kind);
        let uuid = if legacy { id::normalize(&item.uuid) } else { item.uuid.clone() };
        let payload = item.payload_obj();

        if item.action == action::DELETE && family != Family::Tombstone {
            self.remove(&uuid, index);
            return;
        }

        match family {
            Family::Settings => {}
            Family::Tombstone => {
                if let Some(oid) = payload.and_then(|p| p.get("dloid")).and_then(Value::as_str) {
                    let oid = if legacy { id::normalize(oid) } else { oid.to_string() };
                    self.remove(&oid, index);
                }
            }
            Family::Task => {
                let t = self.tasks.entry(uuid.clone()).or_insert_with(|| Task { id: uuid.clone(), ..Default::default() });
                if let Some(p) = payload {
                    for (k, v) in p {
                        apply_task_field(t, k, v, legacy);
                    }
                }
                t.revs.touch(index, payload);
                self.deleted.remove(&uuid);
            }
            Family::Area => {
                let a = self.areas.entry(uuid.clone()).or_insert_with(|| Area { id: uuid.clone(), ..Default::default() });
                if let Some(p) = payload {
                    for (k, v) in p {
                        match k.as_str() {
                            "tt" => a.title = v.as_str().unwrap_or("").to_string(),
                            "ix" => a.index = as_i64(v).unwrap_or(0),
                            "tg" => a.tags = as_ids(v, legacy),
                            _ => {}
                        }
                    }
                }
                a.revs.touch(index, payload);
                self.deleted.remove(&uuid);
            }
            Family::Tag => {
                let t = self.tags.entry(uuid.clone()).or_insert_with(|| Tag { id: uuid.clone(), ..Default::default() });
                if let Some(p) = payload {
                    for (k, v) in p {
                        match k.as_str() {
                            "tt" => t.title = v.as_str().unwrap_or("").to_string(),
                            "sh" => t.shortcut = v.as_str().filter(|s| !s.is_empty()).map(str::to_string),
                            "ix" => t.index = as_i64(v).unwrap_or(0),
                            "pn" => t.parents = as_ids(v, legacy),
                            _ => {}
                        }
                    }
                }
                t.revs.touch(index, payload);
                self.deleted.remove(&uuid);
            }
            Family::ChecklistItem => {
                let c = self
                    .checklist
                    .entry(uuid.clone())
                    .or_insert_with(|| ChecklistItem { id: uuid.clone(), ..Default::default() });
                if let Some(p) = payload {
                    for (k, v) in p {
                        match k.as_str() {
                            "tt" => c.title = v.as_str().unwrap_or("").to_string(),
                            "ss" => c.status = status_from(as_i64(v).unwrap_or(0)),
                            "ix" => c.index = as_i64(v).unwrap_or(0),
                            "ts" => c.tasks = as_ids(v, legacy),
                            "cd" => c.created = v.as_f64(),
                            "sp" => c.stopped = v.as_f64(),
                            _ => {}
                        }
                    }
                }
                c.revs.touch(index, payload);
                self.deleted.remove(&uuid);
            }
        }
    }

    fn remove(&mut self, uuid: &str, index: u64) {
        let existed = self.tasks.remove(uuid).is_some()
            | self.areas.remove(uuid).is_some()
            | self.tags.remove(uuid).is_some()
            | self.checklist.remove(uuid).is_some();
        if existed {
            self.deleted.insert(uuid.to_string(), index);
        }
    }

    /// Revision record for any entity id.
    pub fn revs(&self, uuid: &str) -> Option<&Revs> {
        self.tasks
            .get(uuid)
            .map(|t| &t.revs)
            .or_else(|| self.areas.get(uuid).map(|a| &a.revs))
            .or_else(|| self.tags.get(uuid).map(|t| &t.revs))
            .or_else(|| self.checklist.get(uuid).map(|c| &c.revs))
    }

    /// Project a task belongs to, directly or through its heading.
    pub fn project_of(&self, task: &Task) -> Option<String> {
        if let Some(p) = task.projects.first() {
            return Some(p.clone());
        }
        let heading = self.tasks.get(task.headings.first()?)?;
        heading.projects.first().cloned()
    }

    /// Area a task belongs to, directly or through its project.
    pub fn area_of(&self, task: &Task) -> Option<String> {
        if let Some(a) = task.areas.first() {
            return Some(a.clone());
        }
        let project = self.tasks.get(&self.project_of(task)?)?;
        project.areas.first().cloned()
    }

    /// Open, untrashed checklist items for a task, sorted.
    pub fn checklist_for(&self, task_id: &str) -> Vec<&ChecklistItem> {
        let mut v: Vec<_> = self.checklist.values().filter(|c| c.tasks.iter().any(|t| t == task_id)).collect();
        v.sort_by(|a, b| a.index.cmp(&b.index).then(a.id.cmp(&b.id)));
        v
    }
}

pub(crate) fn status_from(ss: i64) -> Status {
    match ss {
        3 => Status::Completed,
        2 => Status::Canceled,
        _ => Status::Open,
    }
}

fn apply_task_field(t: &mut Task, key: &str, v: &Value, legacy: bool) {
    match key {
        "tt" => t.title = v.as_str().unwrap_or("").to_string(),
        "tp" => {
            t.task_type = match as_i64(v) {
                Some(1) => TaskType::Project,
                Some(2) => TaskType::Heading,
                _ => TaskType::Task,
            }
        }
        "ss" => t.status = status_from(as_i64(v).unwrap_or(0)),
        "st" => {
            t.start = match as_i64(v) {
                Some(0) => Start::Inbox,
                Some(2) => Start::Someday,
                _ => Start::Anytime,
            }
        }
        "sr" => t.start_date = as_date(v),
        "tir" => t.today_date = as_date(v),
        "dd" => t.deadline = as_date(v),
        "rmd" => t.reminder_date = as_date(v),
        "ato" => t.alarm_offset = as_i64(v),
        "sb" => t.start_bucket = as_i64(v).unwrap_or(0),
        "cd" => t.created = v.as_f64(),
        "md" => t.modified = v.as_f64(),
        "sp" => t.stopped = v.as_f64(),
        "ix" => t.index = as_i64(v).unwrap_or(0),
        "ti" => t.today_index = as_i64(v).unwrap_or(0),
        "tr" => t.trashed = as_bool(v),
        "ar" => t.areas = as_ids(v, legacy),
        "pr" => t.projects = as_ids(v, legacy),
        "agr" => t.headings = as_ids(v, legacy),
        "tg" => t.tags = as_ids(v, legacy),
        "rt" => t.recurrence_templates = as_ids(v, legacy),
        "rr" => t.recurrence_rule = if v.is_null() { None } else { Some(v.clone()) },
        "nt" => t.notes = note::apply(&t.notes, v),
        _ => {}
    }
}

fn validate_item(item: &Item) -> Result<(), StateError> {
    let family = Family::of(&item.kind)
        .ok_or_else(|| StateError::UnknownKind { uuid: item.uuid.clone(), kind: item.kind.clone() })?;
    if family == Family::Settings {
        return Ok(());
    }
    if item.action > action::DELETE {
        return Err(StateError::UnknownAction { uuid: item.uuid.clone(), kind: item.kind.clone(), action: item.action });
    }
    let malformed = |reason: String| StateError::Malformed { uuid: item.uuid.clone(), kind: item.kind.clone(), reason };
    if item.action == action::DELETE && family != Family::Tombstone {
        return Ok(());
    }
    let payload = match &item.payload {
        Value::Object(m) => m,
        Value::Null if item.action == action::MODIFY => return Ok(()),
        _ => return Err(malformed("payload is not an object".into())),
    };
    let key_type: fn(&str) -> Ty = match family {
        Family::Task => task_key_type,
        Family::Area => area_key_type,
        Family::Tag => tag_key_type,
        Family::ChecklistItem => checklist_key_type,
        Family::Tombstone => {
            return match payload.get("dloid") {
                Some(Value::String(_)) => Ok(()),
                _ => Err(malformed("tombstone without dloid".into())),
            };
        }
        Family::Settings => unreachable!(),
    };
    for (k, v) in payload {
        if !type_ok(key_type(k), v) {
            return Err(malformed(format!("field {k} has unexpected value {v}")));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn item(uuid: &str, kind: &str, action: u8, p: Value) -> Item {
        Item::new(uuid, kind, action, p)
    }

    #[test]
    fn replays_create_modify_and_null_clears() {
        let mut s = State::new();
        s.apply_entries(
            0,
            &[
                vec![item("T", "Task6", 0, json!({"tt":"Buy milk","st":1,"sr":1770681600,"tir":1770681600,"dd":1770854400,"nt":note::wire("2%"),"tg":["G"],"ix":5}))],
                vec![item("T", "Task6", 1, json!({"tt":"Buy oat milk","md":1.5}))],
                vec![item("T", "Task6", 1, json!({"dd":null,"sr":null,"tir":null,"st":2}))],
            ],
        )
        .unwrap();
        let t = &s.tasks["T"];
        assert_eq!(t.title, "Buy oat milk");
        assert_eq!(t.notes, "2%");
        assert_eq!(t.deadline, None);
        assert_eq!(t.start, Start::Someday);
        assert_eq!(t.start_date, None);
        assert_eq!(t.tags, vec!["G"]);
        assert_eq!(t.revs.rev, 2);
        assert_eq!(t.revs.fields["tt"], 1);
        assert_eq!(t.revs.fields["ix"], 0);
        assert_eq!(t.revs.changed_since(0, ["tt", "ix"]), vec!["tt"]);
        assert_eq!(s.applied_index, 3);
    }

    #[test]
    fn handles_deletes_and_tombstones() {
        let mut s = State::new();
        s.apply_entries(
            0,
            &[
                vec![item("A", "Area3", 0, json!({"tt":"Home"})), item("T", "Task6", 0, json!({"tt":"x"}))],
                vec![item("A", "Area3", 2, Value::Null)],
                vec![item("Z", "Tombstone2", 0, json!({"dloid":"T","dld":1.0}))],
            ],
        )
        .unwrap();
        assert!(s.areas.is_empty());
        assert!(s.tasks.is_empty());
        assert_eq!(s.deleted["A"], 1);
        assert_eq!(s.deleted["T"], 2);
    }

    #[test]
    fn rejects_bad_pages_atomically() {
        let mut s = State::new();
        let good = vec![item("T", "Task6", 0, json!({"tt":"ok"}))];
        let unknown = vec![item("X", "Task7", 0, json!({}))];
        assert!(matches!(s.apply_entries(0, &[good.clone(), unknown]), Err(StateError::UnknownKind { .. })));
        assert!(s.tasks.is_empty(), "nothing applied when a later entry is invalid");
        let wrong_type = vec![item("T", "Task6", 1, json!({"tt": 5}))];
        assert!(matches!(s.apply_entries(0, &[wrong_type]), Err(StateError::Malformed { .. })));
        let bad_action = vec![item("T", "Task6", 7, json!({}))];
        assert!(matches!(s.apply_entries(0, &[bad_action]), Err(StateError::UnknownAction { .. })));
        // Settings of any version are ignored.
        s.apply_entries(0, &[vec![item("S", "Settings5", 9, json!(1))]]).unwrap();
    }

    #[test]
    fn normalises_legacy_ids_and_references() {
        let mut s = State::new();
        s.apply_entries(
            0,
            &[
                vec![item("CC-Things-Tag-High", "Tag3", 0, json!({"tt":"High","sh":"1","pn":[]}))],
                vec![item("AD55F048-9A28-4260-A07B-6BA5C0D39AC9", "Task3", 0, json!({"tt":"A task","tg":["CC-Things-Tag-High"],"ss":3,"nt":null}))],
            ],
        )
        .unwrap();
        let tag_id = id::legacy("CC-Things-Tag-High");
        assert_eq!(s.tags[&tag_id].shortcut.as_deref(), Some("1"));
        let task = s.tasks.values().next().unwrap();
        assert!(id::is_valid(&task.id));
        assert_eq!(task.tags, vec![tag_id]);
        assert_eq!(task.status, Status::Completed);
    }

    #[test]
    fn resolves_project_and_area_through_headings() {
        let mut s = State::new();
        s.apply_entries(
            0,
            &[vec![
                item("P", "Task6", 0, json!({"tt":"Proj","tp":1,"ar":["A"]})),
                item("H", "Task6", 0, json!({"tt":"Head","tp":2,"pr":["P"]})),
                item("T", "Task6", 0, json!({"tt":"Leaf","agr":["H"]})),
            ]],
        )
        .unwrap();
        let t = &s.tasks["T"];
        assert_eq!(s.project_of(t).as_deref(), Some("P"));
        assert_eq!(s.area_of(t).as_deref(), Some("A"));
    }
}
