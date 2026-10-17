import { describe, expect, it } from "vitest";
import { mockSnapshot } from "../backend/mockData";
import type { Snapshot } from "../types";
import { addDays, parseYmd } from "./dates";
import { comingUp, countdown, progress, tagCounts } from "./insights";
import { buildIndex } from "./lists";

const TODAY = "2026-10-16";
const at = (d: string, h = 12) => parseYmd(d).getTime() + h * 3_600_000;

const template = mockSnapshot(TODAY).tasks.find((t) => t.type === "task")!;

/** Replaces the fixture's own (wall-clock based) completions with known ones. */
function withCompletions(snap: Snapshot, dates: string[]): Snapshot {
  const done = dates.map((d, i) => ({ ...template, id: `done${i}`, status: "completed" as const, completedAt: at(d), projectId: null, headingId: null }));
  return { ...snap, tasks: [...snap.tasks.filter((t) => t.status === "open"), ...done] };
}

describe("sidebar insights", () => {
  it("summarises today's progress, the last 7 days and the streak", () => {
    const snap = withCompletions(mockSnapshot(TODAY), [TODAY, TODAY, addDays(TODAY, -1), addDays(TODAY, -2), addDays(TODAY, -4), addDays(TODAY, -9)]);
    const p = progress(snap, buildIndex(snap), TODAY);
    expect(p.doneToday).toBe(2);
    expect(p.remaining).toBe(8);
    expect(p.week).toHaveLength(7);
    expect(p.week[6]).toEqual({ date: TODAY, count: 2 });
    expect(p.streak).toBe(3);
    expect(p.weekTotal).toBe(5);
  });

  it("keeps yesterday's streak alive until today ends", () => {
    const snap = withCompletions({ tasks: [], checklist: [], areas: [], tags: [], serverIndex: 0 }, [addDays(TODAY, -1), addDays(TODAY, -2)]);
    expect(progress(snap, buildIndex(snap), TODAY).streak).toBe(2);
    const empty: Snapshot = { tasks: [], checklist: [], areas: [], tags: [], serverIndex: 0 };
    expect(progress(empty, buildIndex(empty), TODAY)).toMatchObject({ doneToday: 0, remaining: 0, streak: 0, weekTotal: 0 });
  });

  it("lists what's coming up, soonest first, with countdowns", () => {
    const snap = mockSnapshot(TODAY);
    const items = comingUp(snap, buildIndex(snap), TODAY, 4);
    expect(items[0]).toMatchObject({ kind: "deadline", days: 0 });
    expect(items[0].task.title).toBe("Review Q3 budget draft");
    expect(items[1]).toMatchObject({ kind: "start", days: 1 });
    expect(items.map((i) => i.days)).toEqual([...items.map((i) => i.days)].sort((a, b) => a - b));
    expect(items).toHaveLength(4);
    expect([countdown(0), countdown(1), countdown(6), countdown(-2)]).toEqual(["Today", "Tmrw", "6d", "2d ago"]);
  });

  it("counts open to-dos per tag", () => {
    const snap = mockSnapshot(TODAY);
    const counts = tagCounts(snap, buildIndex(snap));
    expect(counts.get("tagErrand")).toBe(2);
    expect(counts.get("tagCalls")).toBe(2);
  });
});
