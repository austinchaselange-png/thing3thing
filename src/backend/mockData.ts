// Sample data for tests only. The app itself starts with an empty list.
import type { Snapshot, Task } from "../types";
import { addDays, todayYmd } from "../lib/dates";

let seq = 0;
function id(prefix: string) {
  seq += 1;
  return `${prefix}${seq.toString(36).padStart(4, "0")}`;
}

export function mockSnapshot(today = todayYmd()): Snapshot {
  seq = 0;
  const d = (n: number) => addDays(today, n);
  const tags = [
    { id: "tagErrand", title: "Errand", shortcut: null, parentId: null, index: 1, rev: 1 },
    { id: "tagHome", title: "Home", shortcut: null, parentId: null, index: 2, rev: 1 },
    { id: "tagCalls", title: "Calls", shortcut: null, parentId: null, index: 3, rev: 1 },
    { id: "tagWaiting", title: "Waiting", shortcut: null, parentId: null, index: 4, rev: 1 },
    { id: "tagImportant", title: "Important", shortcut: null, parentId: null, index: 5, rev: 1 },
  ];
  const areas = [
    { id: "areaPersonal", title: "Personal", index: 0, rev: 1 },
    { id: "areaWork", title: "Work", index: 1, rev: 1 },
    { id: "areaHealth", title: "Health", index: 2, rev: 1 },
  ];
  const tasks: Task[] = [];
  let index = 0;
  const add = (p: Partial<Task> & { title: string }): Task => {
    index += 10;
    const t: Task = {
      id: id("t"),
      type: "task",
      notes: "",
      status: "open",
      start: "anytime",
      startDate: null,
      evening: false,
      deadline: null,
      reminder: null,
      reminderDate: null,
      areaId: null,
      projectId: null,
      headingId: null,
      tagIds: [],
      trashed: false,
      index,
      todayIndex: 0,
      createdAt: Date.now() - index * 60_000,
      modifiedAt: null,
      completedAt: null,
      repeat: null,
      rev: 1,
      ...p,
    };
    tasks.push(t);
    return t;
  };

  add({ title: "Look into a standing desk", start: "inbox" });
  add({ title: "Gift idea for Sam: film camera", start: "inbox", notes: "Check the used market first" });
  add({ title: "Read “The Design of Everyday Things”", start: "inbox" });

  add({ title: "Review Q3 budget draft", startDate: today, areaId: "areaWork", tagIds: ["tagImportant"], deadline: today, notes: "Focus on marketing spend vs. last quarter." });
  add({ title: "Pick up dry cleaning", startDate: today, areaId: "areaPersonal", tagIds: ["tagErrand"], reminder: "17:30", reminderDate: today });
  add({ title: "Call the dentist to reschedule", startDate: today, tagIds: ["tagCalls"] });
  add({ title: "Go for a run", startDate: today, areaId: "areaHealth", repeat: { templateId: "tpl1", summary: "Weekly on Mon, Thu" } });
  add({ title: "Plan weekend hike", startDate: today, evening: true, areaId: "areaPersonal" });
  add({ title: "Water the plants", startDate: today, evening: true, tagIds: ["tagHome"] });

  const trip = add({ title: "Trip to Lisbon", type: "project", areaId: "areaPersonal", deadline: d(24), notes: "Five days in late autumn. Budget ~€1,200." });
  const book = add({ title: "Book", type: "heading", projectId: trip.id });
  const pack = add({ title: "Packing", type: "heading", projectId: trip.id });
  add({ title: "Compare flight prices", projectId: trip.id, headingId: book.id, startDate: today, tagIds: ["tagImportant"] });
  add({ title: "Reserve apartment in Alfama", projectId: trip.id, headingId: book.id });
  add({ title: "Book Sintra day trip", projectId: trip.id, headingId: book.id, start: "someday", startDate: d(5) });
  const list = add({ title: "Packing list", projectId: trip.id, headingId: pack.id });
  add({ title: "Buy travel adapter", projectId: trip.id, headingId: pack.id, tagIds: ["tagErrand"] });
  add({ title: "Book train to Porto", projectId: trip.id, status: "completed", completedAt: Date.now() - 86_400_000 });

  const site = add({ title: "Website redesign", type: "project", areaId: "areaWork", deadline: d(10) });
  add({ title: "Send wireframes to Priya", projectId: site.id, startDate: today });
  add({ title: "Copy for the About page", projectId: site.id, tagIds: ["tagWaiting"], notes: "Asked on Monday" });
  add({ title: "Usability test with 5 people", projectId: site.id, start: "someday", startDate: d(3) });
  add({ title: "Pick a typeface", projectId: site.id });

  const clean = add({ title: "Spring cleaning", type: "project", areaId: "areaPersonal", start: "someday" });
  add({ title: "Donate old clothes", projectId: clean.id });
  add({ title: "Clear out the garage", projectId: clean.id });

  add({ title: "Annual check-up", areaId: "areaHealth", start: "someday", startDate: d(1) });
  add({ title: "Research running shoes", areaId: "areaHealth" });
  add({ title: "1:1 with Jordan", areaId: "areaWork", start: "someday", startDate: d(2), tagIds: ["tagCalls"] });
  add({ title: "Submit expense report", areaId: "areaWork", start: "someday", startDate: d(8) });
  add({ title: "Renew passport", start: "someday", startDate: d(15) });
  add({ title: "Learn to make sourdough", start: "someday" });
  add({ title: "Visit Japan in cherry blossom season", start: "someday", areaId: "areaPersonal" });
  add({ title: "Send invoice #1042", areaId: "areaWork", status: "completed", completedAt: Date.now() - 3_600_000 });
  add({ title: "Old idea", trashed: true, start: "inbox" });

  const checklist = ["Passport", "Chargers", "Rain jacket", "Walking shoes"].map((title, i) => ({
    id: id("c"),
    taskId: list.id,
    title,
    completed: i === 0,
    index: i,
    rev: 1,
  }));
  return { tasks, checklist, areas, tags, serverIndex: 1 };
}
