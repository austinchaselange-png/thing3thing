import { describe, expect, it } from "vitest";
import type { Snapshot, Task } from "../types";
import { buildIndex, EMPTY_LOGBOOK_FILTER, isLogbookFiltered, logbookMatcher, logbookStats, periodRange, type LogbookFilter } from "./lists";

const TODAY = "2026-10-21"; // a Wednesday

function task(p: Partial<Task>): Task {
  return {
    id: p.id ?? Math.random().toString(36).slice(2),
    type: "task",
    title: "",
    notes: "",
    status: "completed",
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
    index: 0,
    todayIndex: 0,
    createdAt: null,
    modifiedAt: null,
    completedAt: null,
    repeat: null,
    rev: 1,
    ...p,
  };
}

const at = (ymd: string, h = 12) => new Date(`${ymd}T${String(h).padStart(2, "0")}:00:00`).getTime();

function snap(): Snapshot {
  const tasks = [
    task({ id: "p1", type: "project", title: "Kitchen remodel", areaId: "a1", status: "open" }),
    task({ id: "t1", title: "Order tiles", projectId: "p1", completedAt: at("2026-10-21"), tagIds: ["g1"] }),
    task({ id: "t2", title: "Call plumber", projectId: "p1", status: "canceled", completedAt: at("2026-10-19") }),
    task({ id: "t3", title: "Renew passport", notes: "bring photos", completedAt: at("2026-10-12") }),
    task({ id: "t4", title: "Taxes", areaId: "a1", completedAt: at("2026-01-05") }),
    task({ id: "p2", type: "project", title: "Old project", completedAt: at("2026-10-20") }),
  ];
  return {
    tasks,
    checklist: [{ id: "c1", taskId: "t3", title: "find birth certificate", completed: true, index: 0, rev: 1 }],
    areas: [{ id: "a1", title: "Home", index: 0, rev: 1 }],
    tags: [{ id: "g1", title: "Errand", shortcut: null, parentId: null, index: 0, rev: 1 }],
    serverIndex: 1,
  };
}

const run = (f: Partial<LogbookFilter>) => {
  const s = snap();
  const match = logbookMatcher({ ...EMPTY_LOGBOOK_FILTER, ...f }, s, buildIndex(s), TODAY);
  return s.tasks.filter((t) => t.status !== "open").filter(match).map((t) => t.id);
};

describe("logbook filters", () => {
  it("computes period ranges with Monday weeks", () => {
    expect(periodRange({ period: "week", from: null, to: null }, TODAY)).toEqual({ from: "2026-10-19", to: TODAY });
    expect(periodRange({ period: "lastWeek", from: null, to: null }, TODAY)).toEqual({ from: "2026-10-12", to: "2026-10-18" });
    expect(periodRange({ period: "7d", from: null, to: null }, TODAY)).toEqual({ from: "2026-10-15", to: TODAY });
    expect(periodRange({ period: "month", from: null, to: null }, TODAY)).toEqual({ from: "2026-10-01", to: TODAY });
    expect(periodRange({ period: "custom", from: "2026-10-10", to: "2026-10-01" }, TODAY)).toEqual({ from: "2026-10-01", to: "2026-10-10" });
  });

  it("filters by period, status, type and container", () => {
    expect(run({})).toEqual(["t1", "t2", "t3", "t4", "p2"]);
    expect(run({ period: "week" })).toEqual(["t1", "t2", "p2"]);
    expect(run({ period: "today" })).toEqual(["t1"]);
    expect(run({ status: "canceled" })).toEqual(["t2"]);
    expect(run({ kind: "project" })).toEqual(["p2"]);
    expect(run({ container: "p1" })).toEqual(["t1", "t2"]);
    expect(run({ container: "a1" })).toEqual(["t1", "t2", "t4"]);
  });

  it("searches titles, notes, checklists, projects, areas and tags", () => {
    expect(run({ query: "tiles" })).toEqual(["t1"]);
    expect(run({ query: "photos" })).toEqual(["t3"]);
    expect(run({ query: "birth" })).toEqual(["t3"]);
    expect(run({ query: "kitchen" })).toEqual(["t1", "t2"]);
    expect(run({ query: "home taxes" })).toEqual(["t4"]);
    expect(run({ query: "errand" })).toEqual(["t1"]);
  });

  it("summarises", () => {
    const s = snap();
    const stats = logbookStats(s.tasks.filter((t) => t.status !== "open"));
    expect(stats).toMatchObject({ completed: 3, canceled: 1, projects: 1, days: 5 });
    expect(isLogbookFiltered(EMPTY_LOGBOOK_FILTER)).toBe(false);
    expect(isLogbookFiltered({ ...EMPTY_LOGBOOK_FILTER, query: " x " })).toBe(true);
  });
});
