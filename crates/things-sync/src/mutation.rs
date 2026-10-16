//! Semantic edits from the UI and their translation into wire items.
//!
//! The UI never builds wire payloads. Each [`Mutation`] is validated against
//! the current state and turned into a [`Plan`]: the items to commit, which
//! entity fields they touch (for conflict detection), and whether the edit is
//! destructive.

use chrono::NaiveDate;
use serde::{Deserialize, Deserializer, Serialize};
use things_cloud::ops::{self, start, OpError, TaskCreate, TaskUpdate};
use things_cloud::recurrence::{self, RepeatSpec};
use things_cloud::state::{Start, Status, Task, TaskType};
use things_cloud::{dates, id, Item, State};

/// Phrase the user must type to confirm a permanent deletion.
pub const CONFIRM_PHRASE: &str = "DELETE";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum When {
    Inbox,
    Today,
    Evening,
    Anytime,
    Someday,
    Date { date: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum NewKind {
    #[default]
    Task,
    Project,
    Heading,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StatusArg {
    Open,
    Completed,
    Canceled,
}

fn double_option<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Mutation {
    CreateTask {
        title: String,
        #[serde(default)]
        notes: String,
        #[serde(default)]
        when: Option<When>,
        #[serde(default)]
        deadline: Option<String>,
        #[serde(default)]
        area_id: Option<String>,
        #[serde(default)]
        project_id: Option<String>,
        #[serde(default)]
        heading_id: Option<String>,
        #[serde(default)]
        tag_ids: Vec<String>,
        #[serde(default)]
        checklist: Vec<String>,
        #[serde(default)]
        kind: NewKind,
        #[serde(default)]
        repeat: Option<RepeatSpec>,
        /// Reminder time "HH:MM" on the start date.
        #[serde(default)]
        reminder: Option<String>,
    },
    UpdateTask {
        id: String,
        base_rev: Option<u64>,
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        notes: Option<String>,
        #[serde(default, deserialize_with = "double_option")]
        deadline: Option<Option<String>>,
        #[serde(default)]
        tag_ids: Option<Vec<String>>,
    },
    Schedule {
        id: String,
        base_rev: Option<u64>,
        when: When,
        #[serde(default, deserialize_with = "double_option")]
        reminder: Option<Option<String>>,
    },
    Move {
        id: String,
        base_rev: Option<u64>,
        #[serde(default)]
        area_id: Option<String>,
        #[serde(default)]
        project_id: Option<String>,
        #[serde(default)]
        heading_id: Option<String>,
    },
    SetStatus {
        id: String,
        base_rev: Option<u64>,
        status: StatusArg,
    },
    SetTrashed {
        id: String,
        base_rev: Option<u64>,
        trashed: bool,
    },
    AddChecklistItem {
        task_id: String,
        title: String,
    },
    UpdateChecklistItem {
        id: String,
        base_rev: Option<u64>,
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        completed: Option<bool>,
    },
    DeleteChecklistItem {
        id: String,
    },
    CreateArea {
        title: String,
    },
    RenameArea {
        id: String,
        base_rev: Option<u64>,
        title: String,
    },
    DeleteArea {
        id: String,
        #[serde(default)]
        confirm: String,
    },
    CreateTag {
        title: String,
        #[serde(default)]
        parent_id: Option<String>,
    },
    RenameTag {
        id: String,
        base_rev: Option<u64>,
        title: String,
    },
    DeleteTag {
        id: String,
        #[serde(default)]
        confirm: String,
    },
    StopRepeating {
        id: String,
        #[serde(default)]
        confirm: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WriteClass {
    Normal,
    /// Permanent: cannot be undone from Trash.
    Destructive,
}

impl Mutation {
    pub fn class(&self) -> WriteClass {
        match self {
            Mutation::DeleteChecklistItem { .. }
            | Mutation::DeleteArea { .. }
            | Mutation::DeleteTag { .. }
            | Mutation::StopRepeating { .. } => WriteClass::Destructive,
            _ => WriteClass::Normal,
        }
    }
}

/// An existing entity a plan modifies, with the wire keys it sets.
#[derive(Debug, Clone, PartialEq)]
pub struct Touched {
    pub id: String,
    pub keys: Vec<String>,
    pub base_rev: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct Plan {
    pub items: Vec<Item>,
    pub touched: Vec<Touched>,
    pub created: Vec<String>,
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum PlanError {
    #[error("{0} no longer exists (it may have been deleted on another device)")]
    NotFound(String),
    #[error("{0}")]
    Invalid(String),
    #[error("type {CONFIRM_PHRASE} to confirm this permanent change")]
    ConfirmationRequired,
}

impl From<OpError> for PlanError {
    fn from(e: OpError) -> Self {
        PlanError::Invalid(e.to_string())
    }
}

pub struct Ctx {
    pub today: NaiveDate,
    pub now: f64,
}

fn invalid<T>(msg: impl Into<String>) -> Result<T, PlanError> {
    Err(PlanError::Invalid(msg.into()))
}

fn parse_date(s: &str) -> Result<NaiveDate, PlanError> {
    dates::parse_ymd(s).ok_or_else(|| PlanError::Invalid(format!("invalid date {s:?} (expected YYYY-MM-DD)")))
}

fn parse_time(s: &str) -> Result<i64, PlanError> {
    let (h, m) = s.split_once(':').ok_or_else(|| PlanError::Invalid(format!("invalid time {s:?}")))?;
    match (h.parse::<i64>(), m.parse::<i64>()) {
        (Ok(h), Ok(m)) if (0..24).contains(&h) && (0..60).contains(&m) => Ok(h * 3600 + m * 60),
        _ => invalid(format!("invalid time {s:?} (expected HH:MM)")),
    }
}

/// (st, date, evening) for a When choice.
fn resolve_when(when: &When, today: NaiveDate) -> Result<(i64, Option<NaiveDate>, bool), PlanError> {
    Ok(match when {
        When::Inbox => (start::INBOX, None, false),
        When::Today => (start::ANYTIME, Some(today), false),
        When::Evening => (start::ANYTIME, Some(today), true),
        When::Anytime => (start::ANYTIME, None, false),
        When::Someday => (start::SOMEDAY, None, false),
        When::Date { date } => {
            let d = parse_date(date)?;
            if d <= today {
                (start::ANYTIME, Some(today), false)
            } else {
                (start::SOMEDAY, Some(d), false)
            }
        }
    })
}

fn task<'a>(state: &'a State, id: &str) -> Result<&'a Task, PlanError> {
    state.tasks.get(id).ok_or_else(|| PlanError::NotFound(format!("item {id}")))
}

fn expect_type(state: &State, id: &str, ty: TaskType, label: &str) -> Result<(), PlanError> {
    let t = task(state, id)?;
    if t.task_type != ty || t.trashed {
        return invalid(format!("{label} {id} is not available"));
    }
    Ok(())
}

fn update_item(update: &TaskUpdate, base_rev: Option<u64>, id: &str, plan: &mut Plan) -> Result<(), PlanError> {
    plan.touched.push(Touched { id: id.to_string(), keys: update.keys().map(str::to_string).collect(), base_rev });
    plan.items.push(update.build()?);
    Ok(())
}

fn min_index(state: &State, pred: impl Fn(&Task) -> bool) -> Option<i64> {
    state.tasks.values().filter(|t| t.status == Status::Open && !t.trashed && pred(t)).map(|t| t.index).min()
}

pub fn plan(state: &State, m: &Mutation, ctx: &Ctx) -> Result<Plan, PlanError> {
    let mut plan = Plan { items: vec![], touched: vec![], created: vec![], summary: String::new() };
    match m {
        Mutation::CreateTask {
            title,
            notes,
            when,
            deadline,
            area_id,
            project_id,
            heading_id,
            tag_ids,
            checklist,
            kind,
            repeat,
            reminder,
        } => {
            let task_type = match kind {
                NewKind::Task => TaskType::Task,
                NewKind::Project => TaskType::Project,
                NewKind::Heading => TaskType::Heading,
            };
            for tag in tag_ids {
                if !state.tags.contains_key(tag) {
                    return Err(PlanError::NotFound(format!("tag {tag}")));
                }
            }
            if let Some(a) = area_id {
                if !state.areas.contains_key(a) {
                    return Err(PlanError::NotFound(format!("area {a}")));
                }
            }
            let mut c = TaskCreate {
                id: id::new_id(),
                title: title.clone(),
                notes: notes.clone(),
                task_type,
                tags: tag_ids.clone(),
                deadline: deadline.as_deref().map(parse_date).transpose()?,
                ..Default::default()
            };
            match task_type {
                TaskType::Heading => {
                    let p = project_id.as_deref().ok_or_else(|| PlanError::Invalid("a heading needs a project".into()))?;
                    expect_type(state, p, TaskType::Project, "project")?;
                    c.projects = vec![p.to_string()];
                    c.st = start::ANYTIME;
                    c.index = ops::next_top_index_below(min_index(state, |t| {
                        t.task_type == TaskType::Heading && t.projects.iter().any(|x| x == p)
                    }));
                }
                TaskType::Project => {
                    c.areas = area_id.iter().cloned().collect();
                    let (st, date, evening) = resolve_when(when.as_ref().unwrap_or(&When::Anytime), ctx.today)?;
                    c.st = if st == start::INBOX { start::ANYTIME } else { st };
                    c.start_date = date;
                    c.evening = evening;
                    c.index = ops::next_top_index_below(min_index(state, |t| t.task_type == TaskType::Project && t.areas == c.areas));
                }
                TaskType::Task => {
                    if let Some(h) = heading_id {
                        expect_type(state, h, TaskType::Heading, "heading")?;
                        c.headings = vec![h.clone()];
                    } else if let Some(p) = project_id {
                        expect_type(state, p, TaskType::Project, "project")?;
                        c.projects = vec![p.clone()];
                    } else if let Some(a) = area_id {
                        c.areas = vec![a.clone()];
                    }
                    let in_container = !(c.headings.is_empty() && c.projects.is_empty() && c.areas.is_empty());
                    let default_when = if in_container { When::Anytime } else { When::Inbox };
                    let (st, date, evening) = resolve_when(when.as_ref().unwrap_or(&default_when), ctx.today)?;
                    c.st = st;
                    c.start_date = date;
                    c.evening = evening;
                    let (projects, headings) = (c.projects.clone(), c.headings.clone());
                    c.index = ops::next_top_index_below(min_index(state, |t| {
                        t.task_type == TaskType::Task && t.projects == projects && t.headings == headings
                    }));
                }
            }
            if let Some(time) = reminder {
                let d = c.start_date.ok_or_else(|| PlanError::Invalid("a reminder needs a date".into()))?;
                c.reminder = Some((d, parse_time(time)?));
            }
            match repeat {
                Some(spec) if task_type != TaskType::Heading => {
                    let rule = recurrence::build_rule(spec, c.start_date.unwrap_or(ctx.today)).map_err(PlanError::Invalid)?;
                    plan.items.extend(c.build_recurring(&rule, ctx.today, ctx.now)?);
                }
                Some(_) => return invalid("headings cannot repeat"),
                None => plan.items.push(c.build(ctx.now)?),
            }
            for (i, line) in checklist.iter().filter(|l| !l.trim().is_empty()).enumerate() {
                let cid = id::new_id();
                plan.items.push(ops::checklist_create(&cid, &c.id, line, i as i64, ctx.now)?);
                plan.created.push(cid);
            }
            plan.created.insert(0, c.id.clone());
            plan.summary = format!("Create “{}”", c.title.trim());
        }
        Mutation::UpdateTask { id, base_rev, title, notes, deadline, tag_ids } => {
            let t = task(state, id)?;
            let mut u = TaskUpdate::new(id, ctx.now);
            if let Some(s) = title {
                if s.trim().is_empty() {
                    return invalid("title must not be empty");
                }
                u.title(s);
            }
            if let Some(n) = notes {
                u.notes(n);
            }
            if let Some(d) = deadline {
                u.deadline(d.as_deref().map(parse_date).transpose()?);
            }
            if let Some(tags) = tag_ids {
                for tag in tags {
                    if !state.tags.contains_key(tag) {
                        return Err(PlanError::NotFound(format!("tag {tag}")));
                    }
                }
                u.tags(tags);
            }
            if u.keys().next().is_none() {
                return invalid("nothing to change");
            }
            update_item(&u, *base_rev, id, &mut plan)?;
            plan.summary = format!("Edit “{}”", t.title);
        }
        Mutation::Schedule { id, base_rev, when, reminder } => {
            let t = task(state, id)?;
            if t.task_type == TaskType::Heading {
                return invalid("headings cannot be scheduled");
            }
            let (mut st, date, evening) = resolve_when(when, ctx.today)?;
            if t.task_type == TaskType::Project && st == start::INBOX {
                st = start::ANYTIME;
            }
            if st == start::INBOX && !(t.projects.is_empty() && t.headings.is_empty() && t.areas.is_empty()) {
                return invalid("move the item out of its project or area before sending it to the Inbox");
            }
            let mut u = TaskUpdate::new(id, ctx.now);
            u.schedule(st, date, evening);
            match reminder {
                Some(Some(time)) => {
                    let d = date.ok_or_else(|| PlanError::Invalid("a reminder needs a date".into()))?;
                    u.reminder(Some((d, parse_time(time)?)));
                }
                Some(None) => {
                    u.reminder(None);
                }
                None if date.is_none() && t.alarm_offset.is_some() => {
                    u.reminder(None);
                }
                None => {}
            }
            update_item(&u, *base_rev, id, &mut plan)?;
            plan.summary = format!("Schedule “{}”", t.title);
        }
        Mutation::Move { id, base_rev, area_id, project_id, heading_id } => {
            let t = task(state, id)?;
            let targets = [area_id.is_some(), project_id.is_some(), heading_id.is_some()].iter().filter(|b| **b).count();
            if targets > 1 {
                return invalid("choose one destination");
            }
            match t.task_type {
                TaskType::Heading => return invalid("headings cannot be moved between projects"),
                TaskType::Project if project_id.is_some() || heading_id.is_some() => {
                    return invalid("projects can only be moved into areas")
                }
                _ => {}
            }
            if let Some(a) = area_id {
                if !state.areas.contains_key(a) {
                    return Err(PlanError::NotFound(format!("area {a}")));
                }
            }
            if let Some(p) = project_id {
                if p == id {
                    return invalid("an item cannot contain itself");
                }
                expect_type(state, p, TaskType::Project, "project")?;
            }
            if let Some(h) = heading_id {
                expect_type(state, h, TaskType::Heading, "heading")?;
            }
            let mut u = TaskUpdate::new(id, ctx.now);
            u.container(area_id.as_deref(), project_id.as_deref(), heading_id.as_deref());
            if targets == 1 && t.start == Start::Inbox {
                u.start_state(start::ANYTIME);
            }
            update_item(&u, *base_rev, id, &mut plan)?;
            plan.summary = format!("Move “{}”", t.title);
        }
        Mutation::SetStatus { id, base_rev, status } => {
            let t = task(state, id)?;
            let mut u = TaskUpdate::new(id, ctx.now);
            match status {
                StatusArg::Open => u.reopened(),
                StatusArg::Completed => u.completed(ctx.now),
                StatusArg::Canceled => u.canceled(ctx.now),
            };
            update_item(&u, *base_rev, id, &mut plan)?;
            // Like Things, finishing a project finishes its remaining items.
            if t.task_type == TaskType::Project && *status != StatusArg::Open {
                let mut children: Vec<&Task> = state
                    .tasks
                    .values()
                    .filter(|c| {
                        c.status == Status::Open && !c.trashed && c.id != t.id && state.project_of(c).as_deref() == Some(id.as_str())
                    })
                    .collect();
                children.sort_by(|a, b| a.id.cmp(&b.id));
                for c in children {
                    let mut cu = TaskUpdate::new(&c.id, ctx.now);
                    match status {
                        StatusArg::Completed => cu.completed(ctx.now),
                        _ => cu.canceled(ctx.now),
                    };
                    update_item(&cu, None, &c.id, &mut plan)?;
                }
            }
            plan.summary = match status {
                StatusArg::Open => format!("Reopen “{}”", t.title),
                StatusArg::Completed => format!("Complete “{}”", t.title),
                StatusArg::Canceled => format!("Cancel “{}”", t.title),
            };
        }
        Mutation::SetTrashed { id, base_rev, trashed } => {
            let t = task(state, id)?;
            let mut u = TaskUpdate::new(id, ctx.now);
            u.trashed(*trashed);
            update_item(&u, *base_rev, id, &mut plan)?;
            plan.summary = if *trashed { format!("Move “{}” to Trash", t.title) } else { format!("Restore “{}”", t.title) };
        }
        Mutation::AddChecklistItem { task_id, title } => {
            let t = task(state, task_id)?;
            if t.task_type != TaskType::Task {
                return invalid("only to-dos have checklists");
            }
            let next = state.checklist_for(task_id).iter().map(|c| c.index).max().map_or(0, |m| m + 1);
            let cid = id::new_id();
            plan.items.push(ops::checklist_create(&cid, task_id, title, next, ctx.now)?);
            plan.created.push(cid);
            plan.summary = format!("Add checklist item to “{}”", t.title);
        }
        Mutation::UpdateChecklistItem { id, base_rev, title, completed } => {
            if !state.checklist.contains_key(id) {
                return Err(PlanError::NotFound(format!("checklist item {id}")));
            }
            if title.is_none() && completed.is_none() {
                return invalid("nothing to change");
            }
            let item = ops::checklist_update(id, title.as_deref(), *completed, ctx.now)?;
            let keys = item.payload.as_object().map(|m| m.keys().filter(|k| *k != "md").cloned().collect()).unwrap_or_default();
            plan.touched.push(Touched { id: id.clone(), keys, base_rev: *base_rev });
            plan.items.push(item);
            plan.summary = "Edit checklist item".into();
        }
        Mutation::DeleteChecklistItem { id } => {
            if !state.checklist.contains_key(id) {
                return Err(PlanError::NotFound(format!("checklist item {id}")));
            }
            plan.items.push(ops::checklist_delete(id)?);
            plan.summary = "Delete checklist item".into();
        }
        Mutation::CreateArea { title } => {
            let aid = id::new_id();
            plan.items.push(ops::area_create(&aid, title)?);
            plan.created.push(aid);
            plan.summary = format!("Create area “{}”", title.trim());
        }
        Mutation::RenameArea { id, base_rev, title } => {
            if !state.areas.contains_key(id) {
                return Err(PlanError::NotFound(format!("area {id}")));
            }
            plan.items.push(ops::area_rename(id, title)?);
            plan.touched.push(Touched { id: id.clone(), keys: vec!["tt".into()], base_rev: *base_rev });
            plan.summary = format!("Rename area to “{}”", title.trim());
        }
        Mutation::DeleteArea { id, confirm } => {
            let area = state.areas.get(id).ok_or_else(|| PlanError::NotFound(format!("area {id}")))?;
            if confirm != CONFIRM_PHRASE {
                return Err(PlanError::ConfirmationRequired);
            }
            let contents = state.tasks.values().filter(|t| !t.trashed && t.areas.iter().any(|a| a == id)).count();
            if contents > 0 {
                return invalid(format!(
                    "“{}” still contains {contents} item(s). Move them or put them in the Trash first — deleting the area would leave them orphaned.",
                    area.title
                ));
            }
            plan.items.push(ops::area_delete(id)?);
            plan.summary = format!("Delete area “{}”", area.title);
        }
        Mutation::CreateTag { title, parent_id } => {
            if let Some(p) = parent_id {
                if !state.tags.contains_key(p) {
                    return Err(PlanError::NotFound(format!("tag {p}")));
                }
            }
            let tid = id::new_id();
            plan.items.push(ops::tag_create(&tid, title, parent_id.as_deref())?);
            plan.created.push(tid);
            plan.summary = format!("Create tag “{}”", title.trim());
        }
        Mutation::RenameTag { id, base_rev, title } => {
            if !state.tags.contains_key(id) {
                return Err(PlanError::NotFound(format!("tag {id}")));
            }
            plan.items.push(ops::tag_rename(id, title)?);
            plan.touched.push(Touched { id: id.clone(), keys: vec!["tt".into()], base_rev: *base_rev });
            plan.summary = format!("Rename tag to “{}”", title.trim());
        }
        Mutation::DeleteTag { id, confirm } => {
            let tag = state.tags.get(id).ok_or_else(|| PlanError::NotFound(format!("tag {id}")))?;
            if confirm != CONFIRM_PHRASE {
                return Err(PlanError::ConfirmationRequired);
            }
            if state.tags.values().any(|t| t.parents.iter().any(|p| p == id)) {
                return invalid(format!("“{}” has child tags; delete or move them first", tag.title));
            }
            plan.items.push(ops::tag_delete(id)?);
            plan.summary = format!("Delete tag “{}”", tag.title);
        }
        Mutation::StopRepeating { id, confirm } => {
            let t = task(state, id)?;
            if confirm != CONFIRM_PHRASE {
                return Err(PlanError::ConfirmationRequired);
            }
            let template_id =
                t.recurrence_templates.first().cloned().ok_or_else(|| PlanError::Invalid("this item does not repeat".into()))?;
            let template = state.tasks.get(&template_id);
            if !template.is_some_and(Task::is_recurring_template) {
                return invalid("the repeat rule for this item could not be found");
            }
            let mut u = TaskUpdate::new(id, ctx.now);
            u.detach_recurrence();
            update_item(&u, None, id, &mut plan)?;
            let mut tu = TaskUpdate::new(&template_id, ctx.now);
            tu.trashed(true);
            update_item(&tu, None, &template_id, &mut plan)?;
            plan.summary = format!("Stop repeating “{}”", t.title);
        }
    }
    Ok(plan)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use things_cloud::wire::Item;

    fn day(s: &str) -> NaiveDate {
        dates::parse_ymd(s).unwrap()
    }

    fn ctx() -> Ctx {
        Ctx { today: day("2026-02-10"), now: 1770713623.5 }
    }

    struct Fixture {
        state: State,
        area: String,
        project: String,
        heading: String,
        task: String,
        tag: String,
    }

    fn fixture() -> Fixture {
        let (area, project, heading, task, tag) = (id::new_id(), id::new_id(), id::new_id(), id::new_id(), id::new_id());
        let mut state = State::new();
        state
            .apply_entries(
                0,
                &[vec![
                    Item::new(&area, "Area3", 0, json!({"tt":"Home","ix":0})),
                    Item::new(&tag, "Tag4", 0, json!({"tt":"Errand"})),
                    Item::new(&project, "Task6", 0, json!({"tt":"Move","tp":1,"st":1,"ar":[area],"ix":5})),
                    Item::new(&heading, "Task6", 0, json!({"tt":"Packing","tp":2,"st":1,"pr":[project],"ix":3})),
                    Item::new(&task, "Task6", 0, json!({"tt":"Buy boxes","tp":0,"st":0,"ix":7,"ato":32400,"sr":null})),
                ]],
            )
            .unwrap();
        Fixture { state, area, project, heading, task, tag }
    }

    fn parse(v: serde_json::Value) -> Mutation {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn deserialises_ui_payloads() {
        let m = parse(json!({"type":"updateTask","id":"x","baseRev":3,"deadline":null}));
        assert_eq!(
            m,
            Mutation::UpdateTask { id: "x".into(), base_rev: Some(3), title: None, notes: None, deadline: Some(None), tag_ids: None }
        );
        let m = parse(json!({"type":"schedule","id":"x","baseRev":null,"when":{"kind":"date","date":"2026-03-01"}}));
        assert!(matches!(m, Mutation::Schedule { when: When::Date { .. }, reminder: None, .. }));
        assert_eq!(parse(json!({"type":"deleteTag","id":"x"})).class(), WriteClass::Destructive);
    }

    #[test]
    fn create_defaults_and_containers() {
        let f = fixture();
        let p = plan(&f.state, &parse(json!({"type":"createTask","title":"Inbox thing"})), &ctx()).unwrap();
        assert_eq!(p.items[0].payload["st"], 0);
        assert_eq!(p.items[0].payload["ix"], 6, "sorts above the existing top-level task");

        let p = plan(
            &f.state,
            &parse(json!({"type":"createTask","title":"Tape","headingId":f.heading,"tagIds":[f.tag],"checklist":["a","","b"]})),
            &ctx(),
        )
        .unwrap();
        let payload = &p.items[0].payload;
        assert_eq!(payload["agr"], json!([f.heading]));
        assert_eq!(payload["pr"], json!([]));
        assert_eq!(payload["st"], 1, "items in containers skip the Inbox");
        assert_eq!(p.items.len(), 3, "task + 2 non-empty checklist items");
        assert_eq!(p.created.len(), 3);

        let p = plan(
            &f.state,
            &parse(json!({"type":"createTask","title":"Later","when":{"kind":"date","date":"2026-02-20"},"reminder":"09:30"})),
            &ctx(),
        )
        .unwrap();
        assert_eq!(p.items[0].payload["st"], 2);
        assert_eq!(p.items[0].payload["ato"], 34200);

        let p =
            plan(&f.state, &parse(json!({"type":"createTask","title":"Past","when":{"kind":"date","date":"2026-01-01"}})), &ctx()).unwrap();
        assert_eq!(p.items[0].payload["sr"], dates::date_to_wire(day("2026-02-10")), "past dates mean today");

        let p =
            plan(&f.state, &parse(json!({"type":"createTask","title":"Section","kind":"heading","projectId":f.project})), &ctx()).unwrap();
        assert_eq!(p.items[0].payload["tp"], 2);
        assert_eq!(p.items[0].payload["st"], 1);
        assert_eq!(p.items[0].payload["ix"], 2);

        assert!(plan(&f.state, &parse(json!({"type":"createTask","title":"x","kind":"heading"})), &ctx()).is_err());
        assert!(matches!(
            plan(&f.state, &parse(json!({"type":"createTask","title":"x","tagIds":["nope"]})), &ctx()),
            Err(PlanError::NotFound(_))
        ));
        assert!(plan(&f.state, &parse(json!({"type":"createTask","title":"x","reminder":"09:00"})), &ctx()).is_err());
        assert!(plan(&f.state, &parse(json!({"type":"createTask","title":"x","projectId":f.area})), &ctx()).is_err());

        let p =
            plan(&f.state, &parse(json!({"type":"createTask","title":"Daily","when":{"kind":"today"},"repeat":{"unit":"day"}})), &ctx())
                .unwrap();
        assert_eq!(p.items.len(), 2, "template + instance");
        assert_eq!(p.created[0], p.items[1].uuid, "the visible instance is reported as created");
    }

    #[test]
    fn schedule_and_move_follow_things_rules() {
        let f = fixture();
        let p = plan(&f.state, &parse(json!({"type":"schedule","id":f.task,"baseRev":0,"when":{"kind":"evening"}})), &ctx()).unwrap();
        assert_eq!(p.items[0].payload["sb"], 1);
        assert_eq!(p.touched[0].keys, vec!["st", "sr", "tir", "sb"]);

        let p = plan(&f.state, &parse(json!({"type":"schedule","id":f.task,"baseRev":0,"when":{"kind":"someday"}})), &ctx()).unwrap();
        assert_eq!(p.items[0].payload["ato"], serde_json::Value::Null, "dateless items lose their reminder");

        assert!(plan(&f.state, &parse(json!({"type":"schedule","id":f.heading,"baseRev":0,"when":{"kind":"today"}})), &ctx()).is_err());

        let p = plan(&f.state, &parse(json!({"type":"move","id":f.task,"baseRev":0,"projectId":f.project})), &ctx()).unwrap();
        assert_eq!(p.items[0].payload["pr"], json!([f.project]));
        assert_eq!(p.items[0].payload["st"], 1, "leaves the Inbox");
        assert!(p.items[0].payload.get("sr").is_none(), "does not clear the schedule");

        assert!(plan(&f.state, &parse(json!({"type":"move","id":f.project,"baseRev":0,"projectId":f.project})), &ctx()).is_err());
        assert!(
            plan(&f.state, &parse(json!({"type":"move","id":f.task,"baseRev":0,"areaId":f.area,"projectId":f.project})), &ctx()).is_err()
        );
        assert!(
            plan(&f.state, &parse(json!({"type":"schedule","id":f.project,"baseRev":0,"when":{"kind":"inbox"}})), &ctx()).unwrap().items[0]
                .payload["st"]
                == 1
        );
    }

    #[test]
    fn completing_a_project_completes_children() {
        let mut f = fixture();
        let child = id::new_id();
        f.state.apply_entries(1, &[vec![Item::new(&child, "Task6", 0, json!({"tt":"Label","agr":[f.heading]}))]]).unwrap();
        let p = plan(&f.state, &parse(json!({"type":"setStatus","id":f.project,"baseRev":0,"status":"completed"})), &ctx()).unwrap();
        let ids: Vec<_> = p.items.iter().map(|i| i.uuid.clone()).collect();
        assert!(ids.contains(&f.heading) && ids.contains(&child) && ids[0] == f.project);
        assert!(p.items.iter().all(|i| i.payload["ss"] == 3));
    }

    #[test]
    fn destructive_operations_need_confirmation_and_guards() {
        let f = fixture();
        assert_eq!(plan(&f.state, &parse(json!({"type":"deleteArea","id":f.area})), &ctx()).unwrap_err(), PlanError::ConfirmationRequired);
        let err = plan(&f.state, &parse(json!({"type":"deleteArea","id":f.area,"confirm":"DELETE"})), &ctx()).unwrap_err();
        assert!(err.to_string().contains("still contains 1"), "{err}");
        assert!(plan(&f.state, &parse(json!({"type":"deleteTag","id":f.tag,"confirm":"DELETE"})), &ctx()).is_ok());
        assert!(plan(&f.state, &parse(json!({"type":"stopRepeating","id":f.task,"confirm":"DELETE"})), &ctx()).is_err());
    }

    #[test]
    fn stop_repeating_detaches_and_trashes_template() {
        let mut f = fixture();
        let template = id::new_id();
        let inst = id::new_id();
        f.state
            .apply_entries(
                1,
                &[vec![
                    Item::new(&template, "Task6", 0, json!({"tt":"Water","rr":{"fu":16,"fa":1}})),
                    Item::new(&inst, "Task6", 0, json!({"tt":"Water","rt":[template]})),
                ]],
            )
            .unwrap();
        let p = plan(&f.state, &parse(json!({"type":"stopRepeating","id":inst,"confirm":"DELETE"})), &ctx()).unwrap();
        assert_eq!(p.items[0].payload["rt"], json!([]));
        assert_eq!(p.items[1].uuid, template);
        assert_eq!(p.items[1].payload["tr"], true);
    }
}
