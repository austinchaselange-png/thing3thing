// Parses quick-entry text such as "Pay rent friday at 9am #Home due oct 31".
// Only trailing phrases and #tags are interpreted, so ordinary titles are left
// alone ("Read Today magazine" stays a title unless "today" is the last word).
import type { Tag, When } from "../types";
import { addDays, parseYmd, ymd } from "./dates";

export interface Parsed {
  title: string;
  when: When | null;
  deadline: string | null;
  reminder: string | null;
  tagIds: string[];
  unknownTags: string[];
}

const WEEKDAYS: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};
const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4, jun: 5, june: 5,
  jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

function nextWeekday(today: string, wd: number): string {
  const cur = parseYmd(today).getDay();
  const diff = (wd - cur + 7) % 7 || 7;
  return addDays(today, diff);
}

function monthDay(month: number, day: number, today: string): string | null {
  const t = parseYmd(today);
  let d = new Date(t.getFullYear(), month, day);
  if (d.getMonth() !== month) return null;
  if (ymd(d) < today) d = new Date(t.getFullYear() + 1, month, day);
  return ymd(d);
}

/** Parses a date phrase (the whole string). Returns a When or null. */
export function parseWhenPhrase(phrase: string, today: string): When | null {
  const p = phrase.trim().toLowerCase().replace(/\s+/g, " ");
  if (p === "today") return { kind: "today" };
  if (p === "tonight" || p === "this evening" || p === "evening") return { kind: "evening" };
  if (p === "tomorrow" || p === "tmrw") return { kind: "date", date: addDays(today, 1) };
  if (p === "someday") return { kind: "someday" };
  if (p === "anytime") return { kind: "anytime" };
  if (p === "next week") return { kind: "date", date: nextWeekday(today, 1) };
  if (p in WEEKDAYS) return { kind: "date", date: nextWeekday(today, WEEKDAYS[p]) };
  const next = /^next (\w+)$/.exec(p);
  if (next && next[1] in WEEKDAYS) return { kind: "date", date: nextWeekday(today, WEEKDAYS[next[1]]) };
  const rel = /^in (\d{1,3}) (day|days|week|weeks|month|months)$/.exec(p);
  if (rel) {
    const n = Number(rel[1]);
    if (rel[2].startsWith("day")) return { kind: "date", date: addDays(today, n) };
    if (rel[2].startsWith("week")) return { kind: "date", date: addDays(today, n * 7) };
    const d = parseYmd(today);
    return { kind: "date", date: ymd(new Date(d.getFullYear(), d.getMonth() + n, d.getDate())) };
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(p);
  if (iso) {
    const d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return ymd(d) === p ? { kind: "date", date: p } : null;
  }
  const md = /^([a-z]+) (\d{1,2})$/.exec(p) ?? null;
  if (md && md[1] in MONTHS) {
    const d = monthDay(MONTHS[md[1]], Number(md[2]), today);
    return d ? { kind: "date", date: d } : null;
  }
  const dm = /^(\d{1,2}) ([a-z]+)$/.exec(p);
  if (dm && dm[2] in MONTHS) {
    const d = monthDay(MONTHS[dm[2]], Number(dm[1]), today);
    return d ? { kind: "date", date: d } : null;
  }
  return null;
}

function whenToDate(w: When, today: string): string | null {
  if (w.kind === "date") return w.date;
  if (w.kind === "today" || w.kind === "evening") return today;
  return null;
}

/** "5pm", "5:30 pm", "17:30" → "HH:MM". */
export function parseTime(s: string): string | null {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(s.trim().toLowerCase());
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    if (m[3] === "pm" && h !== 12) h += 12;
    if (m[3] === "am" && h === 12) h = 0;
  } else if (!m[2]) {
    return null; // a bare number is too ambiguous
  }
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

export function parseQuickEntry(input: string, tags: Tag[], today: string): Parsed {
  const tagIds: string[] = [];
  const unknownTags: string[] = [];
  let text = input.replace(/(^|\s)#([\p{L}\p{N}_-]+)/gu, (_m, lead: string, name: string) => {
    const tag = tags.find((t) => t.title.toLowerCase() === name.toLowerCase());
    if (tag) {
      if (!tagIds.includes(tag.id)) tagIds.push(tag.id);
    } else {
      unknownTags.push(name);
    }
    return lead;
  });

  let when: When | null = null;
  let deadline: string | null = null;
  let reminder: string | null = null;

  // Strip trailing phrases repeatedly: "due <date>", "at <time>", "<when>".
  for (let guard = 0; guard < 4; guard++) {
    const words = text.trim().split(/\s+/);
    let matched = false;
    for (let n = Math.min(3, words.length - 1); n >= 1 && !matched; n--) {
      const tail = words.slice(-n).join(" ");
      const head = words.slice(0, -n);
      const lead = head[head.length - 1]?.toLowerCase();
      if (lead === "due" && !deadline) {
        const w = parseWhenPhrase(tail, today);
        const d = w && whenToDate(w, today);
        if (d) {
          deadline = d;
          text = head.slice(0, -1).join(" ");
          matched = true;
          continue;
        }
      }
      if (lead === "at" && !reminder) {
        const t = parseTime(tail);
        if (t) {
          reminder = t;
          text = head.slice(0, -1).join(" ");
          matched = true;
          continue;
        }
      }
      if (!when && head.length > 0) {
        const w = parseWhenPhrase(tail, today);
        if (w) {
          when = w;
          text = (lead === "on" ? head.slice(0, -1) : head).join(" ");
          matched = true;
        }
      }
    }
    if (!matched) break;
  }
  if (reminder && !when) when = { kind: "today" };
  return { title: text.replace(/\s+/g, " ").trim(), when, deadline, reminder, tagIds, unknownTags };
}
