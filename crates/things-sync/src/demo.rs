//! Sample data for the offline demo account. Built with the same payload
//! builders as real writes, so the demo exercises the real pipeline.

use chrono::{Duration, NaiveDate};
use things_cloud::ops::{self, start, TaskCreate, TaskUpdate};
use things_cloud::recurrence::{self, RepeatSpec, RepeatUnit};
use things_cloud::state::TaskType;
use things_cloud::{id, Item};

struct Seed {
    items: Vec<Item>,
    ix: i64,
    now: f64,
}

impl Seed {
    fn add(&mut self, c: TaskCreate) -> String {
        let mut c = c;
        self.ix += 10;
        c.index = self.ix;
        c.id = id::new_id();
        let id = c.id.clone();
        self.items.push(c.build(self.now).expect("demo data is valid"));
        id
    }
}

fn task(title: &str) -> TaskCreate {
    TaskCreate { title: title.into(), st: start::ANYTIME, ..Default::default() }
}

pub fn seed(today: NaiveDate, now: f64) -> Vec<Vec<Item>> {
    let mut s = Seed { items: vec![], ix: 0, now };
    let d = |days: i64| today + Duration::days(days);

    let tag = |s: &mut Seed, title: &str| {
        let tid = id::new_id();
        s.items.push(ops::tag_create(&tid, title, None).unwrap());
        tid
    };
    let errand = tag(&mut s, "Errand");
    let home_tag = tag(&mut s, "Home");
    let calls = tag(&mut s, "Calls");
    let waiting = tag(&mut s, "Waiting");
    let important = tag(&mut s, "Important");

    let area = |s: &mut Seed, title: &str| {
        let aid = id::new_id();
        s.items.push(ops::area_create(&aid, title).unwrap());
        aid
    };
    let personal = area(&mut s, "Personal");
    let work = area(&mut s, "Work");
    let health = area(&mut s, "Health");

    // Inbox
    for (title, notes) in [
        ("Look into a standing desk", ""),
        ("Gift idea for Sam: film camera", "Check the used market first"),
        ("Read “The Design of Everyday Things”", ""),
    ] {
        s.add(TaskCreate { st: start::INBOX, notes: notes.into(), ..task(title) });
    }

    // Today & This Evening
    let review = s.add(TaskCreate {
        start_date: Some(today),
        tags: vec![important.clone()],
        areas: vec![work.clone()],
        deadline: Some(today),
        ..task("Review Q3 budget draft")
    });
    s.add(TaskCreate {
        start_date: Some(today),
        tags: vec![errand.clone()],
        areas: vec![personal.clone()],
        reminder: Some((today, 17 * 3600 + 30 * 60)),
        ..task("Pick up dry cleaning")
    });
    s.add(TaskCreate { start_date: Some(today), tags: vec![calls.clone()], ..task("Call the dentist to reschedule") });
    s.add(TaskCreate { start_date: Some(today), evening: true, areas: vec![personal.clone()], ..task("Plan weekend hike") });
    s.add(TaskCreate { start_date: Some(today), evening: true, tags: vec![home_tag.clone()], ..task("Water the plants") });

    // Projects with headings
    let trip = s.add(TaskCreate {
        task_type: TaskType::Project,
        areas: vec![personal.clone()],
        deadline: Some(d(24)),
        notes: "Five days in late autumn. Budget ~€1,200.".into(),
        ..task("Trip to Lisbon")
    });
    let book = s.add(TaskCreate { task_type: TaskType::Heading, projects: vec![trip.clone()], ..task("Book") });
    let pack = s.add(TaskCreate { task_type: TaskType::Heading, projects: vec![trip.clone()], ..task("Packing") });
    let flights = s.add(TaskCreate {
        headings: vec![book.clone()],
        start_date: Some(today),
        tags: vec![important.clone()],
        ..task("Compare flight prices")
    });
    s.add(TaskCreate { headings: vec![book.clone()], ..task("Reserve apartment in Alfama") });
    s.add(TaskCreate { headings: vec![book.clone()], start_date: Some(d(5)), st: start::SOMEDAY, ..task("Book Sintra day trip") });
    let packing_list = s.add(TaskCreate { headings: vec![pack.clone()], ..task("Packing list") });
    s.add(TaskCreate { headings: vec![pack.clone()], tags: vec![errand.clone()], ..task("Buy travel adapter") });

    let site =
        s.add(TaskCreate { task_type: TaskType::Project, areas: vec![work.clone()], deadline: Some(d(10)), ..task("Website redesign") });
    s.add(TaskCreate { projects: vec![site.clone()], start_date: Some(today), ..task("Send wireframes to Priya") });
    s.add(TaskCreate {
        projects: vec![site.clone()],
        tags: vec![waiting.clone()],
        notes: "Asked on Monday".into(),
        ..task("Copy for the About page")
    });
    s.add(TaskCreate { projects: vec![site.clone()], start_date: Some(d(3)), st: start::SOMEDAY, ..task("Usability test with 5 people") });
    s.add(TaskCreate { projects: vec![site.clone()], ..task("Pick a typeface") });

    let clean =
        s.add(TaskCreate { task_type: TaskType::Project, areas: vec![personal.clone()], st: start::SOMEDAY, ..task("Spring cleaning") });
    s.add(TaskCreate { projects: vec![clean.clone()], ..task("Donate old clothes") });
    s.add(TaskCreate { projects: vec![clean], ..task("Clear out the garage") });

    // Area tasks, Upcoming, Someday
    s.add(TaskCreate { areas: vec![health.clone()], start_date: Some(d(1)), st: start::SOMEDAY, ..task("Annual check-up") });
    s.add(TaskCreate { areas: vec![health.clone()], ..task("Research running shoes") });
    s.add(TaskCreate {
        areas: vec![work.clone()],
        start_date: Some(d(2)),
        st: start::SOMEDAY,
        tags: vec![calls],
        ..task("1:1 with Jordan")
    });
    s.add(TaskCreate { areas: vec![work.clone()], start_date: Some(d(8)), st: start::SOMEDAY, ..task("Submit expense report") });
    s.add(TaskCreate { start_date: Some(d(15)), st: start::SOMEDAY, ..task("Renew passport") });
    s.add(TaskCreate { st: start::SOMEDAY, ..task("Learn to make sourdough") });
    s.add(TaskCreate { st: start::SOMEDAY, areas: vec![personal.clone()], ..task("Visit Japan in cherry blossom season") });

    // Logbook
    let done = s.add(TaskCreate { areas: vec![work.clone()], ..task("Send invoice #1042") });
    let mut u = TaskUpdate::new(&done, now);
    u.completed(now - 3600.0);
    s.items.push(u.build().unwrap());

    let mut entries = vec![std::mem::take(&mut s.items)];

    // Checklist and notes
    let mut cl = vec![];
    for (i, line) in ["Passport", "Chargers", "Rain jacket", "Walking shoes"].iter().enumerate() {
        cl.push(ops::checklist_create(&id::new_id(), &packing_list, line, i as i64, now).unwrap());
    }
    cl.push(ops::checklist_create(&id::new_id(), &flights, "Check TAP and easyJet", 0, now).unwrap());
    let mut n = TaskUpdate::new(&review, now);
    n.notes("Focus on marketing spend vs. last quarter.\nNumbers are in the shared folder.");
    cl.push(n.build().unwrap());
    entries.push(cl);

    // A repeating to-do (template + instance), as Things models it.
    let rule =
        recurrence::build_rule(&RepeatSpec { unit: RepeatUnit::Week, interval: 1, weekdays: vec![1, 4], month_day: None }, today).unwrap();
    let c = TaskCreate { id: id::new_id(), index: 1, start_date: Some(today), areas: vec![health], ..task("Go for a run") };
    entries.push(c.build_recurring(&rule, today, now).unwrap());
    entries
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Snapshot;
    use things_cloud::State;

    #[test]
    fn demo_seed_is_valid_and_rich() {
        let today = NaiveDate::from_ymd_opt(2026, 10, 16).unwrap();
        let entries = seed(today, 1.0);
        let mut state = State::new();
        state.apply_entries(0, &entries).unwrap();
        let snap = Snapshot::from_state(&state);
        assert!(snap.tasks.len() > 25);
        assert_eq!(snap.areas.len(), 3);
        assert_eq!(snap.tags.len(), 5);
        assert!(snap.tasks.iter().any(|t| t.repeat.is_some()));
        assert!(snap.checklist.len() >= 5);
    }
}
