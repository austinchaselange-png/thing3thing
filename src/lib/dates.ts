// Calendar dates are plain "YYYY-MM-DD" strings in the user's local calendar.
// Things stores them time-zone free, so we never convert them through UTC.

export function ymd(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export function parseYmd(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function todayYmd(now: Date = new Date()): string {
  return ymd(now);
}

export function addDays(s: string, days: number): string {
  const d = parseYmd(s);
  d.setDate(d.getDate() + days);
  return ymd(d);
}

export function daysBetween(from: string, to: string): number {
  const a = parseYmd(from);
  const b = parseYmd(to);
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function weekdayName(s: string, short = false): string {
  const n = WEEKDAYS[parseYmd(s).getDay()];
  return short ? n.slice(0, 3) : n;
}

export function monthName(monthIndex: number, short = false): string {
  const n = MONTHS[monthIndex];
  return short ? n.slice(0, 3) : n;
}

/** "Today", "Tomorrow", "Fri", "Oct 21", "Oct 21, 2027". */
export function relativeLabel(s: string, today: string): string {
  const diff = daysBetween(today, s);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  if (diff > 1 && diff < 7) return weekdayName(s, true);
  const d = parseYmd(s);
  const base = `${monthName(d.getMonth(), true)} ${d.getDate()}`;
  return d.getFullYear() === parseYmd(today).getFullYear() ? base : `${base}, ${d.getFullYear()}`;
}

/** Deadline badge text like Things: "3 days left", "today", "2 days ago". */
export function deadlineLabel(deadline: string, today: string): { text: string; overdue: boolean; soon: boolean } {
  const diff = daysBetween(today, deadline);
  if (diff === 0) return { text: "Due today", overdue: false, soon: true };
  if (diff < 0) return { text: `${-diff} day${diff === -1 ? "" : "s"} ago`, overdue: true, soon: false };
  if (diff < 7) return { text: `${diff} day${diff === 1 ? "" : "s"} left`, overdue: false, soon: diff <= 2 };
  return { text: relativeLabel(deadline, today), overdue: false, soon: false };
}

/** 6×7 grid of dates for a calendar month view, Monday first. */
export function monthGrid(year: number, month: number): string[] {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7;
  const start = new Date(year, month, 1 - offset);
  return Array.from({ length: 42 }, (_, i) => ymd(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)));
}
