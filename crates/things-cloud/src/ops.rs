//! Payload builders. These mirror `wbopan/things-cloud-mcp` field for field,
//! because that shape is the one known to be accepted by Things.app. Invariants
//! that crash Things.app if violated are enforced here:
//! * every id is canonical Base58,
//! * `md` is `null` on create,
//! * headings use `st = 1`,
//! * new items get a positive `ix`.

use chrono::NaiveDate;
use serde_json::{json, Map, Value};

use crate::state::TaskType;
use crate::wire::{action, kind, Item};
use crate::{dates, id, note};

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum OpError {
    #[error("invalid identifier {0:?}")]
    InvalidId(String),
    #[error("{0}")]
    Invalid(String),
}

fn check_ids<'a>(ids: impl IntoIterator<Item = &'a String>) -> Result<(), OpError> {
    for i in ids {
        if !id::is_valid(i) {
            return Err(OpError::InvalidId(i.clone()));
        }
    }
    Ok(())
}

/// Sort index strictly below `min_sibling`, never below 1. Things' sync
/// engine crashes on non-positive `ix` for tasks.
pub fn next_top_index_below(min_sibling: Option<i64>) -> i64 {
    match min_sibling {
        Some(m) if m - 1 >= 1 => m - 1,
        _ => 1,
    }
}

fn empty_extension() -> Value {
    json!({ "sn": {}, "_t": "oo" })
}

/// Start state values for `st`.
pub mod start {
    pub const INBOX: i64 = 0;
    pub const ANYTIME: i64 = 1;
    pub const SOMEDAY: i64 = 2;
}

#[derive(Debug, Clone, Default)]
pub struct TaskCreate {
    pub id: String,
    pub title: String,
    pub notes: String,
    pub task_type: TaskType,
    pub st: i64,
    pub start_date: Option<NaiveDate>,
    pub evening: bool,
    pub deadline: Option<NaiveDate>,
    pub areas: Vec<String>,
    pub projects: Vec<String>,
    pub headings: Vec<String>,
    pub tags: Vec<String>,
    pub index: i64,
    /// Reminder date and seconds after midnight.
    pub reminder: Option<(NaiveDate, i64)>,
}

impl TaskCreate {
    fn validate(&self) -> Result<(), OpError> {
        check_ids([&self.id])?;
        check_ids(self.areas.iter().chain(&self.projects).chain(&self.headings).chain(&self.tags))?;
        if self.title.trim().is_empty() {
            return Err(OpError::Invalid("title must not be empty".into()));
        }
        if self.index < 1 {
            return Err(OpError::Invalid("index must be positive".into()));
        }
        if !(0..=2).contains(&self.st) {
            return Err(OpError::Invalid("invalid start state".into()));
        }
        if self.task_type == TaskType::Heading && self.st != start::ANYTIME {
            return Err(OpError::Invalid("headings must use st=1".into()));
        }
        if self.task_type == TaskType::Heading && self.projects.len() != 1 {
            return Err(OpError::Invalid("a heading must belong to exactly one project".into()));
        }
        Ok(())
    }

    fn payload(&self, now: f64) -> Map<String, Value> {
        let date = self.start_date.map(dates::date_to_wire);
        let (rmd, ato) = match self.reminder {
            Some((d, secs)) => (json!(dates::date_to_wire(d)), json!(secs)),
            None => (Value::Null, Value::Null),
        };
        let tp = match self.task_type {
            TaskType::Task => 0,
            TaskType::Project => 1,
            TaskType::Heading => 2,
        };
        let v = json!({
            "tp": tp, "sr": date, "dds": null, "rt": [], "rmd": rmd, "ss": 0, "tr": false,
            "dl": [], "icp": false, "st": self.st, "ar": self.areas, "tt": self.title.trim(),
            "do": 0, "lai": null, "tir": date, "tg": self.tags, "agr": self.headings,
            "ix": self.index, "cd": now, "lt": false, "icc": 0, "md": null, "ti": 0,
            "dd": self.deadline.map(dates::date_to_wire), "ato": ato, "nt": note::wire(&self.notes),
            "icsd": null, "pr": self.projects, "rp": null, "acrd": null, "sp": null,
            "sb": if self.evening { 1 } else { 0 }, "rr": null, "xx": empty_extension(),
        });
        match v {
            Value::Object(m) => m,
            _ => unreachable!(),
        }
    }

    /// A plain create event.
    pub fn build(&self, now: f64) -> Result<Item, OpError> {
        self.validate()?;
        Ok(Item::new(&self.id, kind::TASK, action::CREATE, Value::Object(self.payload(now))))
    }

    /// A recurring create: hidden template (carries `rr`) plus the visible
    /// first instance pointing at it, as the reference MCP writes it.
    pub fn build_recurring(&self, rule: &Value, today: NaiveDate, now: f64) -> Result<Vec<Item>, OpError> {
        self.validate()?;
        let reference = self.start_date.unwrap_or(today);
        let next = crate::recurrence::next_after(rule, reference)
            .ok_or_else(|| OpError::Invalid("could not compute next repeat date".into()))?;
        let template_id = id::new_id();
        let mut template = self.payload(now);
        template.insert("rr".into(), rule.clone());
        template.insert("icsd".into(), json!(dates::date_to_wire(today)));
        template.insert("rt".into(), json!([]));
        template.insert("sr".into(), json!(dates::date_to_wire(next)));
        template.insert("tir".into(), json!(dates::date_to_wire(next)));
        template.insert("st".into(), json!(start::ANYTIME));
        template.insert("sb".into(), json!(0));
        let mut instance = self.payload(now);
        instance.insert("rt".into(), json!([template_id]));
        Ok(vec![
            Item::new(template_id, kind::TASK, action::CREATE, Value::Object(template)),
            Item::new(&self.id, kind::TASK, action::CREATE, Value::Object(instance)),
        ])
    }
}

/// Partial update for a task/project/heading. Always stamps `md` with a fresh
/// timestamp, which also serves as the fingerprint used to reconcile
/// uncertain commits.
#[derive(Debug, Clone)]
pub struct TaskUpdate {
    id: String,
    fields: Map<String, Value>,
}

impl TaskUpdate {
    pub fn new(task_id: &str, now: f64) -> Self {
        let mut fields = Map::new();
        fields.insert("md".into(), json!(now));
        TaskUpdate { id: task_id.to_string(), fields }
    }

    fn set(&mut self, k: &str, v: Value) -> &mut Self {
        self.fields.insert(k.into(), v);
        self
    }

    pub fn title(&mut self, s: &str) -> &mut Self {
        self.set("tt", json!(s.trim()))
    }
    pub fn notes(&mut self, s: &str) -> &mut Self {
        self.set("nt", note::wire(s))
    }
    pub fn completed(&mut self, now: f64) -> &mut Self {
        self.set("ss", json!(3)).set("sp", json!(now))
    }
    pub fn canceled(&mut self, now: f64) -> &mut Self {
        self.set("ss", json!(2)).set("sp", json!(now))
    }
    pub fn reopened(&mut self) -> &mut Self {
        self.set("ss", json!(0)).set("sp", Value::Null)
    }
    pub fn trashed(&mut self, trashed: bool) -> &mut Self {
        self.set("tr", json!(trashed))
    }
    pub fn deadline(&mut self, d: Option<NaiveDate>) -> &mut Self {
        self.set("dd", json!(d.map(dates::date_to_wire)))
    }
    /// `st`, `sr`/`tir` and `sb` together, as the official client writes them.
    pub fn schedule(&mut self, st: i64, date: Option<NaiveDate>, evening: bool) -> &mut Self {
        let d = json!(date.map(dates::date_to_wire));
        self.set("st", json!(st)).set("sr", d.clone()).set("tir", d).set("sb", json!(i64::from(evening)))
    }
    pub fn start_state(&mut self, st: i64) -> &mut Self {
        self.set("st", json!(st))
    }
    pub fn reminder(&mut self, r: Option<(NaiveDate, i64)>) -> &mut Self {
        match r {
            Some((d, secs)) => self.set("rmd", json!(dates::date_to_wire(d))).set("ato", json!(secs)),
            None => self.set("rmd", Value::Null).set("ato", Value::Null),
        }
    }
    /// Moves to exactly one container (or none). Mirrors the MCP: setting one
    /// of area/project/heading clears the other two.
    pub fn container(&mut self, area: Option<&str>, project: Option<&str>, heading: Option<&str>) -> &mut Self {
        let one = |o: Option<&str>| json!(o.map(|s| vec![s.to_string()]).unwrap_or_default());
        self.set("ar", one(area)).set("pr", one(project)).set("agr", one(heading))
    }
    pub fn tags(&mut self, tags: &[String]) -> &mut Self {
        self.set("tg", json!(tags))
    }
    /// Detaches an instance from its recurring template.
    pub fn detach_recurrence(&mut self) -> &mut Self {
        self.set("rt", json!([])).set("rr", Value::Null).set("icsd", Value::Null)
    }

    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.fields.keys().map(String::as_str).filter(|k| *k != "md")
    }

    pub fn build(&self) -> Result<Item, OpError> {
        check_ids([&self.id])?;
        for key in ["ar", "pr", "agr", "tg", "rt"] {
            if let Some(Value::Array(a)) = self.fields.get(key) {
                for v in a {
                    let s = v.as_str().unwrap_or_default().to_string();
                    check_ids([&s])?;
                }
            }
        }
        Ok(Item::new(&self.id, kind::TASK, action::MODIFY, Value::Object(self.fields.clone())))
    }
}

pub fn checklist_create(item_id: &str, task_id: &str, title: &str, index: i64, now: f64) -> Result<Item, OpError> {
    check_ids([&item_id.to_string(), &task_id.to_string()])?;
    if title.trim().is_empty() {
        return Err(OpError::Invalid("checklist item title must not be empty".into()));
    }
    Ok(Item::new(
        item_id,
        kind::CHECKLIST_ITEM,
        action::CREATE,
        json!({ "cd": now, "md": null, "tt": title.trim(), "ss": 0, "sp": null, "ix": index, "ts": [task_id], "lt": false, "xx": empty_extension() }),
    ))
}

pub fn checklist_update(item_id: &str, title: Option<&str>, completed: Option<bool>, now: f64) -> Result<Item, OpError> {
    check_ids([&item_id.to_string()])?;
    let mut p = Map::new();
    p.insert("md".into(), json!(now));
    if let Some(t) = title {
        if t.trim().is_empty() {
            return Err(OpError::Invalid("checklist item title must not be empty".into()));
        }
        p.insert("tt".into(), json!(t.trim()));
    }
    match completed {
        Some(true) => {
            p.insert("ss".into(), json!(3));
            p.insert("sp".into(), json!(now));
        }
        Some(false) => {
            p.insert("ss".into(), json!(0));
            p.insert("sp".into(), Value::Null);
        }
        None => {}
    }
    Ok(Item::new(item_id, kind::CHECKLIST_ITEM, action::MODIFY, Value::Object(p)))
}

pub fn checklist_delete(item_id: &str) -> Result<Item, OpError> {
    check_ids([&item_id.to_string()])?;
    Ok(Item::new(item_id, kind::CHECKLIST_ITEM, action::DELETE, json!({})))
}

pub fn area_create(area_id: &str, title: &str) -> Result<Item, OpError> {
    check_ids([&area_id.to_string()])?;
    if title.trim().is_empty() {
        return Err(OpError::Invalid("area name must not be empty".into()));
    }
    Ok(Item::new(area_id, kind::AREA, action::CREATE, json!({ "tt": title.trim(), "ix": 0, "tg": [], "xx": empty_extension() })))
}

pub fn area_rename(area_id: &str, title: &str) -> Result<Item, OpError> {
    check_ids([&area_id.to_string()])?;
    if title.trim().is_empty() {
        return Err(OpError::Invalid("area name must not be empty".into()));
    }
    Ok(Item::new(area_id, kind::AREA, action::MODIFY, json!({ "tt": title.trim() })))
}

pub fn area_delete(area_id: &str) -> Result<Item, OpError> {
    check_ids([&area_id.to_string()])?;
    Ok(Item::new(area_id, kind::AREA, action::DELETE, json!({})))
}

pub fn tag_create(tag_id: &str, title: &str, parent: Option<&str>) -> Result<Item, OpError> {
    check_ids([&tag_id.to_string()])?;
    if let Some(p) = parent {
        check_ids([&p.to_string()])?;
    }
    if title.trim().is_empty() {
        return Err(OpError::Invalid("tag name must not be empty".into()));
    }
    // `ix: -1237` is the value the reference MCP writes (taken from a capture).
    Ok(Item::new(
        tag_id,
        kind::TAG,
        action::CREATE,
        json!({ "tt": title.trim(), "ix": -1237, "sh": null, "pn": parent.map(|p| vec![p]).unwrap_or_default(), "xx": empty_extension() }),
    ))
}

pub fn tag_rename(tag_id: &str, title: &str) -> Result<Item, OpError> {
    check_ids([&tag_id.to_string()])?;
    if title.trim().is_empty() {
        return Err(OpError::Invalid("tag name must not be empty".into()));
    }
    Ok(Item::new(tag_id, kind::TAG, action::MODIFY, json!({ "tt": title.trim() })))
}

pub fn tag_delete(tag_id: &str) -> Result<Item, OpError> {
    check_ids([&tag_id.to_string()])?;
    Ok(Item::new(tag_id, kind::TAG, action::DELETE, json!({})))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::State;

    fn day(s: &str) -> NaiveDate {
        dates::parse_ymd(s).unwrap()
    }

    fn base(title: &str) -> TaskCreate {
        TaskCreate { id: id::new_id(), title: title.into(), st: start::INBOX, index: 1, ..Default::default() }
    }

    #[test]
    fn create_payload_matches_reference_shape() {
        let mut c = base("Buy milk");
        c.st = start::ANYTIME;
        c.start_date = Some(day("2026-02-10"));
        c.notes = "2%".into();
        let item = c.build(1770713623.47).unwrap();
        let p = item.payload.as_object().unwrap();
        // Every key the MCP's TaskCreatePayload sends.
        let expected = [
            "tp", "sr", "dds", "rt", "rmd", "ss", "tr", "dl", "icp", "st", "ar", "tt", "do", "lai", "tir", "tg", "agr", "ix", "cd",
            "lt", "icc", "md", "ti", "dd", "ato", "nt", "icsd", "pr", "rp", "acrd", "sp", "sb", "rr", "xx",
        ];
        assert_eq!(p.len(), expected.len());
        for k in expected {
            assert!(p.contains_key(k), "missing {k}");
        }
        assert_eq!(p["md"], Value::Null, "md must be null on create");
        assert_eq!(p["st"], 1);
        assert_eq!(p["sr"], 1770681600);
        assert_eq!(p["tir"], 1770681600);
        assert_eq!(p["nt"]["v"], "2%");
        assert_eq!(p["xx"], json!({"sn":{},"_t":"oo"}));
        assert_eq!(item.kind, "Task6");
        assert_eq!(item.action, 0);
        // The state engine accepts what we write.
        let mut s = State::new();
        s.apply_entries(0, &[vec![item.clone()]]).unwrap();
        assert_eq!(s.tasks[&item.uuid].title, "Buy milk");
    }

    #[test]
    fn create_enforces_crash_invariants() {
        let mut bad_id = base("x");
        bad_id.id = "AD55F048-9A28-4260-A07B-6BA5C0D39AC9".into();
        assert!(matches!(bad_id.build(0.0), Err(OpError::InvalidId(_))));
        let mut heading = base("Section");
        heading.task_type = TaskType::Heading;
        heading.projects = vec![id::new_id()];
        assert!(heading.build(0.0).is_err(), "heading with st=0 crashes Things");
        heading.st = start::ANYTIME;
        assert!(heading.build(0.0).is_ok());
        let mut zero_ix = base("x");
        zero_ix.index = 0;
        assert!(zero_ix.build(0.0).is_err());
        assert!(base("  ").build(0.0).is_err());
        let mut bad_ref = base("x");
        bad_ref.tags = vec!["not-base58!".into()];
        assert!(bad_ref.build(0.0).is_err());
        assert_eq!(next_top_index_below(Some(10)), 9);
        assert_eq!(next_top_index_below(Some(1)), 1);
        assert_eq!(next_top_index_below(Some(-5)), 1);
        assert_eq!(next_top_index_below(None), 1);
    }

    #[test]
    fn recurring_create_writes_template_and_instance() {
        let mut c = base("Water plants");
        c.st = start::ANYTIME;
        c.start_date = Some(day("2026-02-10"));
        let rule = crate::recurrence::build_rule(
            &crate::recurrence::RepeatSpec { unit: crate::recurrence::RepeatUnit::Day, interval: 1, weekdays: vec![], month_day: None },
            day("2026-02-10"),
        )
        .unwrap();
        let items = c.build_recurring(&rule, day("2026-02-10"), 1.0).unwrap();
        assert_eq!(items.len(), 2);
        let (template, instance) = (&items[0], &items[1]);
        assert_eq!(template.payload["rr"], rule);
        assert_eq!(template.payload["tir"], dates::date_to_wire(day("2026-02-11")));
        assert_eq!(instance.payload["rt"], json!([template.uuid]));
        assert_eq!(instance.payload["rr"], Value::Null);
        let mut s = State::new();
        s.apply_entries(0, &[items.clone()]).unwrap();
        assert!(s.tasks[&template.uuid].is_recurring_template());
        assert!(!s.tasks[&instance.uuid].is_recurring_template());
    }

    #[test]
    fn update_builder() {
        let tid = id::new_id();
        let area = id::new_id();
        let mut u = TaskUpdate::new(&tid, 5.5);
        u.title(" New ").schedule(start::ANYTIME, Some(day("2026-02-10")), true).container(Some(&area), None, None).completed(6.0);
        let item = u.build().unwrap();
        let p = &item.payload;
        assert_eq!(p["md"], 5.5);
        assert_eq!(p["tt"], "New");
        assert_eq!(p["sb"], 1);
        assert_eq!(p["ar"], json!([area]));
        assert_eq!(p["pr"], json!([]));
        assert_eq!(p["ss"], 3);
        assert!(u.keys().all(|k| k != "md"));
        let mut bad = TaskUpdate::new(&tid, 1.0);
        bad.tags(&["bad id".into()]);
        assert!(bad.build().is_err());
    }

    #[test]
    fn other_builders() {
        let t = id::new_id();
        let c = id::new_id();
        assert_eq!(checklist_create(&c, &t, "Step", 0, 1.0).unwrap().payload["ts"], json!([t]));
        assert_eq!(checklist_update(&c, None, Some(false), 2.0).unwrap().payload["sp"], Value::Null);
        assert_eq!(checklist_delete(&c).unwrap().action, action::DELETE);
        assert_eq!(area_create(&c, "Home").unwrap().kind, "Area3");
        assert!(area_create(&c, "").is_err());
        assert_eq!(tag_create(&c, "Errand", Some(&t)).unwrap().payload["pn"], json!([t]));
        assert_eq!(tag_delete(&c).unwrap().kind, "Tag4");
    }
}
