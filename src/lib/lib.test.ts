import { describe, expect, it } from "vitest";
import { mockSnapshot } from "../backend/mockData";
import { applyMutation, MutationError } from "./applyMutation";
import { addDays, deadlineLabel, monthGrid, relativeLabel } from "./dates";
import { belongsTo, buildIndex, countFor, groupsFor, projectProgress, search, sidebarTree } from "./lists";
import { parseQuickEntry, parseTime, parseWhenPhrase } from "./quickParse";

const TODAY = "2026-10-16"; // a Friday

describe("dates", () => {
  it("labels relative dates", () => {
    expect(relativeLabel(TODAY, TODAY)).toBe("Today");
    expect(relativeLabel(addDays(TODAY, 1), TODAY)).toBe("Tomorrow");
    expect(relativeLabel(addDays(TODAY, 3), TODAY)).toBe("Mon");
    expect(relativeLabel("2026-12-25", TODAY)).toBe("Dec 25");
    expect(relativeLabel("2027-01-02", TODAY)).toBe("Jan 2, 2027");
    expect(deadlineLabel(addDays(TODAY, -2), TODAY)).toMatchObject({ text: "2 days ago", overdue: true });
    expect(deadlineLabel(addDays(TODAY, 1), TODAY)).toMatchObject({ text: "1 day left", soon: true });
  });

  it("builds a Monday-first month grid", () => {
    const g = monthGrid(2026, 9);
    expect(g).toHaveLength(42);
    expect(g[0]).toBe("2026-09-28");
    expect(g).toContain("2026-10-31");
  });
});

describe("list semantics", () => {
  const snap = mockSnapshot(TODAY);
  const ix = buildIndex(snap);
  const titles = (list: Parameters<typeof belongsTo>[0]) =>
    snap.tasks.filter((t) => belongsTo(list, t, ix, TODAY)).map((t) => t.title);

  it("puts tasks in the right Things lists", () => {
    expect(titles("inbox")).toEqual(["Look into a standing desk", "Gift idea for Sam: film camera", "Read “The Design of Everyday Things”"]);
    expect(titles("today")).toContain("Plan weekend hike");
    expect(titles("today")).toContain("Compare flight prices");
    expect(titles("today")).not.toContain("Annual check-up");
    expect(titles("upcoming")).toContain("Annual check-up");
    expect(titles("someday")).toContain("Spring cleaning");
    expect(titles("someday")).toContain("Learn to make sourdough");
    expect(titles("anytime")).not.toContain("Donate old clothes"); // inside a Someday project
    expect(titles("anytime")).toContain("Research running shoes");
    expect(titles("logbook")).toContain("Send invoice #1042");
    expect(titles("trash")).toEqual(["Old idea"]);
    expect(countFor("inbox", snap, ix, TODAY)).toBe(3);
  });

  it("splits Today into day and evening", () => {
    const g = groupsFor({ kind: "list", id: "today" }, snap, ix, TODAY);
    expect(g.map((x) => x.key)).toEqual(["today", "evening"]);
    expect(g[1].tasks.map((t) => t.title)).toEqual(["Plan weekend hike", "Water the plants"]);
  });

  it("groups Upcoming by day then month", () => {
    const g = groupsFor({ kind: "list", id: "upcoming" }, snap, ix, TODAY);
    expect(g[0].subtitle).toBe("Tomorrow");
    expect(g[0].tasks.map((t) => t.title)).toEqual(["Annual check-up"]);
    expect(g.find((x) => x.title === "October")?.tasks.map((t) => t.title)).toEqual(["Submit expense report", "Renew passport"]);
  });

  it("lays out projects with headings", () => {
    const trip = snap.tasks.find((t) => t.title === "Trip to Lisbon")!;
    const g = groupsFor({ kind: "project", id: trip.id }, snap, ix, TODAY);
    expect(g.map((x) => x.title)).toEqual([null, "Book", "Packing", "Completed"]);
    expect(projectProgress(trip.id, snap)).toEqual({ done: 1, total: 6 });
  });

  it("builds the sidebar and searches", () => {
    const tree = sidebarTree(snap, ix);
    expect(tree.areas.find((a) => a.area.title === "Work")?.projects.map((p) => p.title)).toEqual(["Website redesign"]);
    expect(search("passport", snap, ix).map((t) => t.title)).toEqual(["Renew passport"]);
  });
});

describe("applyMutation", () => {
  const snap = mockSnapshot(TODAY);

  it("creates in the inbox by default and in Anytime inside containers", () => {
    const r = applyMutation(snap, { type: "createTask", title: "  New  " }, { today: TODAY });
    const t = r.snapshot.tasks.find((x) => x.id === r.created[0])!;
    expect(t).toMatchObject({ title: "New", start: "inbox" });
    const r2 = applyMutation(snap, { type: "createTask", title: "In area", areaId: "areaWork" }, { today: TODAY });
    expect(r2.snapshot.tasks.find((x) => x.id === r2.created[0])!.start).toBe("anytime");
  });

  it("schedules like Things", () => {
    const id = snap.tasks[0].id;
    const today = applyMutation(snap, { type: "schedule", id, baseRev: 1, when: { kind: "evening" } }, { today: TODAY }).snapshot.tasks.find((t) => t.id === id)!;
    expect(today).toMatchObject({ start: "anytime", startDate: TODAY, evening: true });
    const past = applyMutation(snap, { type: "schedule", id, baseRev: 1, when: { kind: "date", date: "2020-01-01" } }, { today: TODAY }).snapshot.tasks.find((t) => t.id === id)!;
    expect(past.startDate).toBe(TODAY);
    const future = applyMutation(snap, { type: "schedule", id, baseRev: 1, when: { kind: "date", date: "2026-11-01" } }, { today: TODAY }).snapshot.tasks.find((t) => t.id === id)!;
    expect(future).toMatchObject({ start: "someday", startDate: "2026-11-01" });
  });

  it("completes a project's children and guards destructive edits", () => {
    const trip = snap.tasks.find((t) => t.title === "Trip to Lisbon")!;
    const r = applyMutation(snap, { type: "setStatus", id: trip.id, baseRev: 1, status: "completed" }, { today: TODAY });
    expect(r.snapshot.tasks.filter((t) => t.projectId === trip.id && t.status === "open")).toHaveLength(0);
    expect(() => applyMutation(snap, { type: "deleteArea", id: "areaWork", confirm: "" })).toThrow(MutationError);
    expect(() => applyMutation(snap, { type: "deleteArea", id: "areaWork", confirm: "DELETE" })).toThrow(/still contains/);
    expect(() => applyMutation(snap, { type: "updateTask", id: "missing", baseRev: 1, title: "x" })).toThrow(/no longer exists/);
  });
});

describe("quick entry parsing", () => {
  const tags = mockSnapshot(TODAY).tags;

  it("parses trailing dates, times, deadlines and tags", () => {
    expect(parseQuickEntry("Call mom tomorrow at 5pm #calls", tags, TODAY)).toEqual({
      title: "Call mom",
      when: { kind: "date", date: "2026-10-17" },
      deadline: null,
      reminder: "17:00",
      tagIds: ["tagCalls"],
      unknownTags: [],
    });
    const p = parseQuickEntry("Pay rent due oct 31 #Home #nope", tags, TODAY);
    expect(p).toMatchObject({ title: "Pay rent", deadline: "2026-10-31", when: null, tagIds: ["tagHome"], unknownTags: ["nope"] });
    expect(parseQuickEntry("Water plants tonight", tags, TODAY).when).toEqual({ kind: "evening" });
    expect(parseQuickEntry("Dinner on friday", tags, TODAY).when).toEqual({ kind: "date", date: "2026-10-23" });
    expect(parseQuickEntry("Book trip in 2 weeks", tags, TODAY).when).toEqual({ kind: "date", date: "2026-10-30" });
  });

  it("leaves ordinary titles alone", () => {
    expect(parseQuickEntry("Today", tags, TODAY)).toMatchObject({ title: "Today", when: null });
    expect(parseQuickEntry("Read Today magazine", tags, TODAY)).toMatchObject({ title: "Read Today magazine", when: null });
    expect(parseQuickEntry("Buy 2 apples", tags, TODAY).title).toBe("Buy 2 apples");
    expect(parseWhenPhrase("feb 30", TODAY)).toBeNull();
    expect(parseTime("13pm")).toBeNull();
    expect(parseTime("17:45")).toBe("17:45");
  });
});
