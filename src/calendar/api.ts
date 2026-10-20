// The calendar panel's own bridge to Rust (src-tauri/src/gcal.rs), plus a
// mock for the browser preview and tests. Independent of src/backend.
import { addDay, dayKey } from "./dates";
import type { CalendarInfo, CalEvent, CalStatus, EventsResult } from "./types";

export interface CalendarApi {
  status(): Promise<CalStatus>;
  setClient(clientId: string, clientSecret: string): Promise<CalStatus>;
  connect(): Promise<CalStatus>;
  disconnect(): Promise<CalStatus>;
  calendars(): Promise<CalendarInfo[]>;
  setVisible(id: string, visible: boolean): Promise<CalendarInfo[]>;
  events(timeMin: string, timeMax: string): Promise<EventsResult>;
  /** Opens an https link in the default browser. */
  openUrl(url: string): Promise<void>;
}

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

class TauriCalendarApi implements CalendarApi {
  private async call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(cmd, args);
  }
  status() {
    return this.call<CalStatus>("gcal_status");
  }
  setClient(clientId: string, clientSecret: string) {
    return this.call<CalStatus>("gcal_set_client", { clientId, clientSecret });
  }
  connect() {
    return this.call<CalStatus>("gcal_connect");
  }
  disconnect() {
    return this.call<CalStatus>("gcal_disconnect");
  }
  calendars() {
    return this.call<CalendarInfo[]>("gcal_calendars");
  }
  setVisible(id: string, visible: boolean) {
    return this.call<CalendarInfo[]>("gcal_set_visible", { id, visible });
  }
  events(timeMin: string, timeMax: string) {
    return this.call<EventsResult>("gcal_events", { timeMin, timeMax });
  }
  openUrl(url: string) {
    return this.call<void>("open_url", { url });
  }
}

/** In-memory stand-in with a believable week of events around today. */
export class MockCalendarApi implements CalendarApi {
  private s: CalStatus;
  private cals: CalendarInfo[] = [
    { id: "me@example.com", name: "Personal", color: "#039be5", primary: true, visible: true },
    { id: "work", name: "Work", color: "#33b679", primary: false, visible: true },
    { id: "holidays", name: "Holidays", color: "#7986cb", primary: false, visible: true },
    { id: "sports", name: "Sports", color: "#f4511e", primary: false, visible: false },
  ];
  constructor(connected = false, private now: () => Date = () => new Date()) {
    this.s = { configured: connected, builtInClient: false, connected, email: connected ? "you@example.com" : null, lastSyncAt: connected ? Date.now() : null, lastError: null };
  }
  async status() {
    return { ...this.s };
  }
  async setClient(clientId: string) {
    if (!clientId.trim().endsWith(".apps.googleusercontent.com")) throw { code: "invalid", message: "That doesn't look like a Google OAuth client ID (it ends with .apps.googleusercontent.com)." };
    this.s = { ...this.s, configured: true };
    return this.status();
  }
  async connect() {
    this.s = { ...this.s, connected: true, email: "you@example.com", lastSyncAt: Date.now() };
    return this.status();
  }
  async disconnect() {
    this.s = { ...this.s, connected: false, email: null, lastSyncAt: null };
    return this.status();
  }
  async calendars() {
    if (!this.s.connected) throw { code: "noAccount", message: "Connect Google Calendar first." };
    return this.cals.map((c) => ({ ...c }));
  }
  async setVisible(id: string, visible: boolean) {
    this.cals = this.cals.map((c) => (c.id === id ? { ...c, visible } : c));
    return this.calendars();
  }
  async events(timeMin: string, timeMax: string): Promise<EventsResult> {
    if (!this.s.connected) throw { code: "noAccount", message: "Connect Google Calendar first." };
    const min = new Date(timeMin).getTime();
    const max = new Date(timeMax).getTime();
    const visible = new Set(this.cals.filter((c) => c.visible).map((c) => c.id));
    const events = sampleEvents(this.now(), this.cals)
      .filter((e) => visible.has(e.calendarId))
      .filter((e) => {
        const s = e.allDay ? new Date(`${e.start}T00:00`).getTime() : new Date(e.start).getTime();
        const en = e.allDay ? new Date(`${e.end}T00:00`).getTime() : new Date(e.end).getTime();
        return s < max && en > min;
      });
    return { events, stale: false, fetchedAt: Date.now() };
  }
  async openUrl(url: string) {
    window.open(url, "_blank", "noopener");
  }
}

function sampleEvents(now: Date, cals: CalendarInfo[]): CalEvent[] {
  const color = (id: string) => cals.find((c) => c.id === id)?.color ?? "#039be5";
  const today = dayKey(now);
  const at = (day: string, h: number, m = 0) => {
    const [y, mo, d] = day.split("-").map(Number);
    return new Date(y, mo - 1, d, h, m).toISOString();
  };
  const out: CalEvent[] = [];
  const add = (calendarId: string, title: string, day: string, h: number | null, mins = 60, extra: Partial<CalEvent> = {}) => {
    const id = `${calendarId}-${day}-${title}`.replace(/\W+/g, "-");
    const base = { id, calendarId, title, location: null, description: null, link: "https://calendar.google.com/", meet: null, color: color(calendarId), declined: false, free: false, organizer: null, attendees: 0 };
    if (h === null) out.push({ ...base, start: day, end: addDay(day, Math.max(1, Math.round(mins / 1440))), allDay: true, ...extra });
    else {
      const start = at(day, Math.floor(h), Math.round((h % 1) * 60));
      out.push({ ...base, start, end: new Date(new Date(start).getTime() + mins * 60_000).toISOString(), allDay: false, ...extra });
    }
  };
  for (let i = -45; i <= 75; i++) {
    const day = addDay(today, i);
    const wd = new Date(day + "T12:00").getDay();
    if (wd >= 1 && wd <= 5) {
      add("work", "Team standup", day, 9.5, 15, { meet: "https://meet.google.com/abc-defg-hij", attendees: 6, organizer: "Jordan Lee" });
      if (wd === 2 || wd === 4) add("work", "Design review", day, 14, 60, { location: "Room 4B · 2nd floor", attendees: 4, description: "<p>Agenda:</p><ul><li>Sidebar cards</li><li>Calendar panel</li></ul><p>Notes doc: https://docs.example.com/review</p>" });
      if (wd === 5) add("work", "1:1 with Sam", day, 11, 30, { attendees: 2 });
    }
    if (wd === 3) add("me@example.com", "Gym", day, 18.5, 75, { location: "Downtown Fitness" });
    if (wd === 6 && i % 14 === 0) add("me@example.com", "Farmers market", day, 9, 120, { location: "Riverside Park" });
    if (wd === 0) add("me@example.com", "Call Mom", day, 17, 30);
    if (i % 23 === 5) add("sports", "Game night", day, 19, 180);
  }
  add("me@example.com", "Dentist", addDay(today, 2), 8, 45, { location: "Smile Dental, 120 Main St" });
  add("me@example.com", "Dinner with Alex", today, 19, 120, { location: "Luigi's" });
  add("holidays", "Long weekend", addDay(today, 12), null, 3 * 1440, { free: true });
  add("holidays", "Company holiday", addDay(today, 30), null, 1440, { free: true });
  add("work", "Quarterly planning", addDay(today, 6), 13, 180, { declined: false, attendees: 12, organizer: "Priya N." });
  add("work", "Optional: brown bag", addDay(today, 1), 12, 60, { declined: true, attendees: 30 });
  add("me@example.com", "Flight to Denver", addDay(today, 9), 21, 300, { location: "Gate B12" });
  return out;
}

let instance: CalendarApi | null = null;

export function calendarApi(): CalendarApi {
  if (!instance) {
    if (inTauri()) instance = new TauriCalendarApi();
    else {
      // Browser preview: `?sample` starts signed in with sample events.
      const sample = typeof location !== "undefined" && new URLSearchParams(location.search).has("sample");
      instance = new MockCalendarApi(sample);
    }
  }
  return instance;
}

export function setCalendarApiForTests(api: CalendarApi | null) {
  instance = api;
}
