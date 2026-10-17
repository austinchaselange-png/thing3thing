//! Data sent to the UI. Recurring templates are hidden; their rule is shown on
//! the visible instances. Dates are `YYYY-MM-DD`, times are milliseconds.

use serde::Serialize;
use things_cloud::recurrence;
use things_cloud::state::{Start, Status, TaskType};
use things_cloud::{dates, State};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepeatDto {
    pub template_id: String,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskDto {
    pub id: String,
    #[serde(rename = "type")]
    pub task_type: TaskType,
    pub title: String,
    pub notes: String,
    pub status: Status,
    pub start: Start,
    pub start_date: Option<String>,
    pub evening: bool,
    pub deadline: Option<String>,
    /// Reminder time "HH:MM" (local).
    pub reminder: Option<String>,
    pub reminder_date: Option<String>,
    pub area_id: Option<String>,
    pub project_id: Option<String>,
    pub heading_id: Option<String>,
    pub tag_ids: Vec<String>,
    pub trashed: bool,
    pub index: i64,
    pub today_index: i64,
    pub created_at: Option<f64>,
    pub modified_at: Option<f64>,
    pub completed_at: Option<f64>,
    pub repeat: Option<RepeatDto>,
    pub rev: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChecklistDto {
    pub id: String,
    pub task_id: String,
    pub title: String,
    pub completed: bool,
    pub index: i64,
    pub rev: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AreaDto {
    pub id: String,
    pub title: String,
    pub index: i64,
    pub rev: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TagDto {
    pub id: String,
    pub title: String,
    pub shortcut: Option<String>,
    pub parent_id: Option<String>,
    pub index: i64,
    pub rev: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub tasks: Vec<TaskDto>,
    pub checklist: Vec<ChecklistDto>,
    pub areas: Vec<AreaDto>,
    pub tags: Vec<TagDto>,
    pub server_index: u64,
}

fn ms(ts: Option<f64>) -> Option<f64> {
    ts.map(|t| (t * 1000.0).round())
}

pub fn task_dto(state: &State, t: &things_cloud::state::Task) -> TaskDto {
    let repeat = t.recurrence_templates.first().and_then(|tid| {
        let template = state.tasks.get(tid)?;
        let rule = template.recurrence_rule.as_ref()?;
        Some(RepeatDto { template_id: tid.clone(), summary: recurrence::describe(rule) })
    });
    let heading_id = t.headings.first().cloned();
    TaskDto {
        id: t.id.clone(),
        task_type: t.task_type,
        title: t.title.clone(),
        notes: t.notes.clone(),
        status: t.status,
        start: t.start,
        start_date: t.effective_start_date().map(dates::format_ymd),
        evening: t.start_bucket == 1,
        deadline: t.deadline.map(dates::format_ymd),
        reminder: t.alarm_offset.map(|s| format!("{:02}:{:02}", s / 3600, (s % 3600) / 60)),
        reminder_date: t.reminder_date.or(t.effective_start_date()).filter(|_| t.alarm_offset.is_some()).map(dates::format_ymd),
        area_id: t.areas.first().cloned(),
        project_id: state.project_of(t),
        heading_id,
        tag_ids: t.tags.clone(),
        trashed: t.trashed,
        index: t.index,
        today_index: t.today_index,
        created_at: ms(t.created),
        modified_at: ms(t.modified),
        completed_at: ms(t.stopped),
        repeat,
        rev: t.revs.rev,
    }
}

impl Snapshot {
    pub fn from_state(state: &State) -> Self {
        let mut tasks: Vec<TaskDto> = state.tasks.values().filter(|t| !t.is_recurring_template()).map(|t| task_dto(state, t)).collect();
        tasks.sort_by(|a, b| a.index.cmp(&b.index).then_with(|| a.id.cmp(&b.id)));
        let mut checklist: Vec<ChecklistDto> = state
            .checklist
            .values()
            .filter_map(|c| {
                Some(ChecklistDto {
                    id: c.id.clone(),
                    task_id: c.tasks.first()?.clone(),
                    title: c.title.clone(),
                    completed: c.status != Status::Open,
                    index: c.index,
                    rev: c.revs.rev,
                })
            })
            .collect();
        checklist.sort_by(|a, b| a.index.cmp(&b.index).then_with(|| a.id.cmp(&b.id)));
        let mut areas: Vec<AreaDto> =
            state.areas.values().map(|a| AreaDto { id: a.id.clone(), title: a.title.clone(), index: a.index, rev: a.revs.rev }).collect();
        areas.sort_by(|a, b| a.index.cmp(&b.index).then_with(|| a.title.cmp(&b.title)));
        let mut tags: Vec<TagDto> = state
            .tags
            .values()
            .map(|t| TagDto {
                id: t.id.clone(),
                title: t.title.clone(),
                shortcut: t.shortcut.clone(),
                parent_id: t.parents.first().cloned(),
                index: t.index,
                rev: t.revs.rev,
            })
            .collect();
        tags.sort_by(|a, b| a.index.cmp(&b.index).then_with(|| a.title.cmp(&b.title)));
        Snapshot { tasks, checklist, areas, tags, server_index: state.applied_index }
    }
}

/// A due reminder, for Windows notifications.
#[derive(Debug, Clone, PartialEq)]
pub struct DueReminder {
    pub task_id: String,
    pub title: String,
    pub at: chrono::NaiveDateTime,
}

/// Open, untrashed tasks whose reminder falls within `(after, until]`
/// (local wall-clock time).
pub fn due_reminders(state: &State, after: chrono::NaiveDateTime, until: chrono::NaiveDateTime) -> Vec<DueReminder> {
    let mut out: Vec<DueReminder> = state
        .tasks
        .values()
        .filter(|t| t.status == Status::Open && !t.trashed && !t.is_recurring_template())
        .filter_map(|t| {
            let offset = t.alarm_offset?;
            let date = t.reminder_date.or(t.effective_start_date())?;
            let at = date.and_hms_opt(0, 0, 0)? + chrono::Duration::seconds(offset);
            (at > after && at <= until).then(|| DueReminder { task_id: t.id.clone(), title: t.title.clone(), at })
        })
        .collect();
    out.sort_by_key(|r| r.at);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use things_cloud::{id, Item};

    #[test]
    fn snapshot_hides_templates_and_describes_repeats() {
        let (tpl, inst, proj, head, leaf) = (id::new_id(), id::new_id(), id::new_id(), id::new_id(), id::new_id());
        let mut s = State::new();
        s.apply_entries(
            0,
            &[vec![
                Item::new(&tpl, "Task6", 0, json!({"tt":"Run","rr":{"fu":256,"fa":1,"of":[{"wd":1}]}})),
                Item::new(&inst, "Task6", 0, json!({"tt":"Run","rt":[tpl],"st":1,"sr":1770681600,"tir":1770768000,"ato":27000,"sb":1})),
                Item::new(&proj, "Task6", 0, json!({"tt":"P","tp":1})),
                Item::new(&head, "Task6", 0, json!({"tt":"H","tp":2,"pr":[proj]})),
                Item::new(&leaf, "Task6", 0, json!({"tt":"L","agr":[head],"cd":1.5})),
            ]],
        )
        .unwrap();
        let snap = Snapshot::from_state(&s);
        assert_eq!(snap.tasks.len(), 4);
        let i = snap.tasks.iter().find(|t| t.id == inst).unwrap();
        assert_eq!(i.repeat.as_ref().unwrap().summary, "Weekly on Mon");
        assert_eq!(i.start_date.as_deref(), Some("2026-02-11"), "tir wins over sr");
        assert_eq!(i.reminder.as_deref(), Some("07:30"));
        assert!(i.evening);
        let l = snap.tasks.iter().find(|t| t.id == leaf).unwrap();
        assert_eq!(l.project_id.as_deref(), Some(proj.as_str()));
        assert_eq!(l.heading_id.as_deref(), Some(head.as_str()));
        assert_eq!(l.created_at, Some(1500.0));
        let v = serde_json::to_value(l).unwrap();
        assert_eq!(v["type"], "task");
        assert_eq!(v["start"], "anytime");

        let d = |s: &str| chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M").unwrap();
        let due = due_reminders(&s, d("2026-02-11 07:00"), d("2026-02-11 08:00"));
        assert_eq!(due.len(), 1);
        assert!(due_reminders(&s, d("2026-02-11 07:30"), d("2026-02-11 08:00")).is_empty());
    }
}
