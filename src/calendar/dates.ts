// Date helpers for the calendar panel. Days are local "YYYY-MM-DD" strings,
// months are "YYYY-MM". Weeks start on Sunday, like Google Calendar.
import type { CalEvent } from "./types";

export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function parseDay(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function addDay(s: string, n: number): string {
  const d = parseDay(s);
  d.setDate(d.getDate() + n);
  return dayKey(d);
}

export function monthKey(d: Date | string): string {
  const date = typeof d === "string" ? parseDay(d.length === 7 ? `${d}-01` : d) : d;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export function addMonth(key: string, n: number): string {
  const [y, m] = key.split("-").map(Number);
  return monthKey(new Date(y, m - 1 + n, 1));
}

/** Local midnight at the start of a month, and of the month after. */
export function monthRange(key: string): { start: Date; end: Date } {
  const [y, m] = key.split("-").map(Number);
  return { start: new Date(y, m - 1, 1), end: new Date(y, m, 1) };
}

/** 6×7 days for a month grid, Sunday first. */
export function monthDays(key: string): string[] {
  const { start } = monthRange(key);
  const first = new Date(start);
  first.setDate(1 - start.getDay());
  return Array.from({ length: 42 }, (_, i) => dayKey(new Date(first.getFullYear(), first.getMonth(), first.getDate() + i)));
}

/** The Sunday-to-Saturday week containing a day. */
export function weekOf(day: string): string[] {
  const d = parseDay(day);
  const sunday = addDay(day, -d.getDay());
  return Array.from({ length: 7 }, (_, i) => addDay(sunday, i));
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function monthTitle(key: string): { month: string; year: string } {
  const [y, m] = key.split("-").map(Number);
  return { month: MONTHS[m - 1], year: String(y) };
}

export const WEEKDAY_INITIALS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

/** "SUNDAY 6/4" (with the year when it isn't this year). */
export function agendaDayTitle(day: string, today: string): { weekday: string; date: string; relative: string | null } {
  const d = parseDay(day);
  const t = parseDay(today);
  const diff = Math.round((d.getTime() - t.getTime()) / 86_400_000);
  const relative = diff === 0 ? "Today" : diff === 1 ? "Tomorrow" : diff === -1 ? "Yesterday" : null;
  const date = `${d.getMonth() + 1}/${d.getDate()}${d.getFullYear() === t.getFullYear() ? "" : `/${String(d.getFullYear()).slice(2)}`}`;
  return { weekday: WEEKDAYS[d.getDay()].toUpperCase(), date, relative };
}

export function timeLabel(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** Local start and (exclusive) end of an event. All-day events run midnight to midnight. */
export function eventBounds(e: CalEvent): { start: Date; end: Date } {
  if (e.allDay) return { start: parseDay(e.start), end: parseDay(e.end) };
  return { start: new Date(e.start), end: new Date(e.end) };
}

/** Every local day an event touches. */
export function eventDays(e: CalEvent): string[] {
  const { start, end } = eventBounds(e);
  const days: string[] = [];
  let day = dayKey(start);
  // An event ending exactly at midnight doesn't spill into the next day.
  const lastMoment = new Date(Math.max(start.getTime(), end.getTime() - 1));
  const last = dayKey(lastMoment);
  for (let i = 0; i < 400 && day <= last; i++) {
    days.push(day);
    day = addDay(day, 1);
  }
  return days;
}

/** What the time column shows for an event on one of its days. */
export function timeOn(e: CalEvent, day: string): { label: string; allDay: boolean } {
  if (e.allDay) return { label: "All day", allDay: true };
  const { start, end } = eventBounds(e);
  const startDay = dayKey(start);
  const endDay = dayKey(new Date(end.getTime() - 1));
  if (startDay === day) return { label: timeLabel(start), allDay: false };
  if (endDay === day) return { label: `Until ${timeLabel(end)}`, allDay: false };
  return { label: "All day", allDay: true };
}

/** "Tue, Oct 20 · 9:00 – 10:30 AM", or a date range for longer events. */
export function rangeLabel(e: CalEvent): string {
  const { start, end } = eventBounds(e);
  const dateFmt: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" };
  if (e.allDay) {
    // The end date is exclusive: step back one calendar day (not 24 hours, which is wrong across DST changes).
    const lastDay = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 1);
    if (dayKey(lastDay) <= dayKey(start)) return `${start.toLocaleDateString(undefined, dateFmt)} · All day`;
    return `${start.toLocaleDateString(undefined, dateFmt)} – ${lastDay.toLocaleDateString(undefined, dateFmt)}`;
  }
  if (dayKey(start) === dayKey(new Date(end.getTime() - 1))) return `${start.toLocaleDateString(undefined, dateFmt)} · ${timeLabel(start)} – ${timeLabel(end)}`;
  return `${start.toLocaleDateString(undefined, dateFmt)} ${timeLabel(start)} – ${end.toLocaleDateString(undefined, dateFmt)} ${timeLabel(end)}`;
}

/** "45 min", "1 hr 30 min". */
export function durationLabel(e: CalEvent): string | null {
  if (e.allDay) return null;
  const { start, end } = eventBounds(e);
  const mins = Math.round((end.getTime() - start.getTime()) / 60_000);
  if (mins <= 0) return null;
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

/** Events grouped by the days they touch, each day sorted: all-day first, then by start. */
export function byDay(events: CalEvent[]): Map<string, CalEvent[]> {
  const map = new Map<string, CalEvent[]>();
  for (const e of events) for (const d of eventDays(e)) map.set(d, [...(map.get(d) ?? []), e]);
  for (const [d, list] of map) {
    list.sort((a, b) => {
      const ta = timeOn(a, d);
      const tb = timeOn(b, d);
      if (ta.allDay !== tb.allDay) return ta.allDay ? -1 : 1;
      return eventBounds(a).start.getTime() - eventBounds(b).start.getTime() || a.title.localeCompare(b.title);
    });
  }
  return map;
}

/** Google descriptions are often simple HTML; turn them into readable text. */
export function plainText(html: string): string {
  if (!/[<&]/.test(html)) return html;
  const withBreaks = html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|h\d)>/gi, "\n").replace(/<li[^>]*>/gi, "• ");
  const doc = new DOMParser().parseFromString(withBreaks, "text/html");
  return (doc.body.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
}
