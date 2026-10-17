// Small summaries for the sidebar: today's progress, recent completions,
// streaks, and what's coming up next.
import type { Snapshot, Task } from "../types";
import { addDays, daysBetween, ymd } from "./dates";
import { type Index, isLive, isToday } from "./lists";

export interface DayCount {
  date: string;
  count: number;
}

export interface Progress {
  doneToday: number;
  /** Open to-dos still in Today. */
  remaining: number;
  /** Completions per day for the last 7 days, oldest first (last = today). */
  week: DayCount[];
  weekTotal: number;
  /** Consecutive days with at least one completion, ending today (or yesterday). */
  streak: number;
}

function completedOn(t: Task): string | null {
  return t.status === "completed" && !t.trashed && t.completedAt && t.type !== "heading" ? ymd(new Date(t.completedAt)) : null;
}

export function progress(s: Snapshot, ix: Index, today: string): Progress {
  const byDay = new Map<string, number>();
  for (const t of s.tasks) {
    const d = completedOn(t);
    if (d && t.type === "task") byDay.set(d, (byDay.get(d) ?? 0) + 1);
  }
  const week = Array.from({ length: 7 }, (_, i) => {
    const date = addDays(today, i - 6);
    return { date, count: byDay.get(date) ?? 0 };
  });
  let streak = 0;
  let cursor = byDay.get(today) ? today : addDays(today, -1);
  while (byDay.get(cursor)) {
    streak++;
    cursor = addDays(cursor, -1);
  }
  const remaining = s.tasks.filter((t) => t.type === "task" && isLive(t, ix) && isToday(t, today)).length;
  return { doneToday: byDay.get(today) ?? 0, remaining, week, weekTotal: week.reduce((n, d) => n + d.count, 0), streak };
}

export interface UpcomingItem {
  task: Task;
  date: string;
  kind: "deadline" | "start";
  /** Days from today; negative when overdue. */
  days: number;
}

/** Next deadlines and scheduled starts, soonest first. Overdue deadlines come first. */
export function comingUp(s: Snapshot, ix: Index, today: string, limit = 5, horizonDays = 60): UpcomingItem[] {
  const items: UpcomingItem[] = [];
  for (const t of s.tasks) {
    if (t.type === "heading" || !isLive(t, ix)) continue;
    if (t.deadline && daysBetween(today, t.deadline) <= horizonDays) {
      items.push({ task: t, date: t.deadline, kind: "deadline", days: daysBetween(today, t.deadline) });
    } else if (t.startDate && t.startDate > today && daysBetween(today, t.startDate) <= horizonDays) {
      items.push({ task: t, date: t.startDate, kind: "start", days: daysBetween(today, t.startDate) });
    }
  }
  items.sort((a, b) => a.days - b.days || (a.kind === b.kind ? 0 : a.kind === "deadline" ? -1 : 1) || a.task.title.localeCompare(b.task.title));
  return items.slice(0, limit);
}

/** "Today", "Tomorrow", "6d", "3d ago". */
export function countdown(days: number): string {
  if (days === 0) return "Today";
  if (days === 1) return "Tmrw";
  if (days < 0) return `${-days}d ago`;
  return `${days}d`;
}

/** Open, live to-dos per tag. */
export function tagCounts(s: Snapshot, ix: Index): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of s.tasks) {
    if (t.type === "heading" || !isLive(t, ix)) continue;
    for (const id of t.tagIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}
