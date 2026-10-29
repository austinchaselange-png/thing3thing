// State for the calendar panel. Its own zustand store: the to-do store
// doesn't know about calendars, and this one doesn't know about to-dos.
import { create } from "zustand";
import { calendarApi } from "./api";
import { addMonth, dayKey, monthKey, monthRange } from "./dates";
import type { CalendarInfo, CalError, CalEvent, CalStatus } from "./types";

export const MIN_WIDTH = 280;
export const MAX_WIDTH = 560;
const DEFAULT_WIDTH = 340;
/** Refetch a month that is older than this when it comes back into view. */
const FRESH_MS = 5 * 60_000;

interface MonthData {
  events: CalEvent[];
  at: number;
  stale: boolean;
  partial?: boolean;
}

/** Reopening the panel after this long refreshes it. */
const REOPEN_REFRESH_MS = 60_000;

// Bookkeeping that doesn't need to re-render anything.
/** Months asked to reload while a load was already running: reloaded when it finishes. */
const reloadAfter = new Set<string>();
let refreshing: Promise<void> | null = null;
let refreshAgain = false;
let lastRefreshAt = 0;
/** Only the newest show/hide answer from the backend is applied. */
let visibilitySeq = 0;

/** Clears the module-level bookkeeping (tests). */
export function resetCalendarQueues() {
  reloadAfter.clear();
  refreshing = null;
  refreshAgain = false;
  lastRefreshAt = 0;
  visibilitySeq = 0;
}

interface CalendarStore {
  open: boolean;
  width: number;
  /** Only the week of the selected day is shown above the agenda. */
  collapsed: boolean;
  status: CalStatus | null;
  calendars: CalendarInfo[];
  months: Record<string, MonthData>;
  loading: Record<string, true>;
  error: CalError | null;
  /** Month shown in the grid, "YYYY-MM". */
  month: string;
  /** First and last month the agenda lists. */
  agendaFrom: string;
  agendaTo: string;
  selectedDay: string;
  /** Bumped when the agenda should scroll to the selected day. */
  scrollSeq: number;
  query: string;
  expanded: string | null;
  toggle(): void;
  setOpen(open: boolean): void;
  setWidth(w: number): void;
  setCollapsed(c: boolean): void;
  init(): Promise<void>;
  refresh(): Promise<void>;
  loadMonth(key: string, force?: boolean): Promise<void>;
  /** Grid navigation: shows that month and restarts the agenda there. */
  showMonth(key: string, day?: string): void;
  goToday(): void;
  /** Click on a day in the grid. */
  pickDay(day: string): void;
  /** The agenda scrolled; keep the grid in step without restarting the agenda. */
  followDay(day: string): void;
  extendAgenda(): void;
  setQuery(q: string): void;
  setExpanded(key: string | null): void;
  setStatus(s: CalStatus): void;
  setVisible(id: string, visible: boolean): Promise<void>;
  disconnect(): Promise<void>;
}

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

function asError(e: unknown): CalError {
  if (typeof e === "object" && e && "message" in e) return { code: String((e as CalError).code ?? "sync"), message: String((e as CalError).message) };
  return { code: "sync", message: String(e) };
}

const clampWidth = (w: number) => Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w)));

export const useCalendar = create<CalendarStore>((set, get) => {
  const today = dayKey(new Date());
  const thisMonth = monthKey(new Date());

  /** One refresh: the calendar list (names, colours, new calendars), then every month in view. */
  async function refreshOnce() {
    const api = calendarApi();
    try {
      const calendars = await api.calendars();
      set({ calendars, error: null });
    } catch (e) {
      const err = asError(e);
      set({ error: err });
      if (err.code === "noAccount") return void api.status().then((s) => get().setStatus(s), () => {});
    }
    const { month, agendaFrom, agendaTo } = get();
    const keys = new Set([addMonth(month, -1), month, addMonth(month, 1)]);
    for (let k = agendaFrom; k <= agendaTo; k = addMonth(k, 1)) keys.add(k);
    await Promise.all([...keys].map((k) => get().loadMonth(k, true)));
    void api.status().then((status) => set({ status }), () => {});
  }

  return {
    open: readPref("tings3.calendar.open") === "1",
    width: clampWidth(Number(readPref("tings3.calendar.width")) || DEFAULT_WIDTH),
    collapsed: readPref("tings3.calendar.collapsed") === "1",
    status: null,
    calendars: [],
    months: {},
    loading: {},
    error: null,
    month: thisMonth,
    agendaFrom: thisMonth,
    agendaTo: addMonth(thisMonth, 1),
    selectedDay: today,
    scrollSeq: 0,
    query: "",
    expanded: null,

    toggle() {
      get().setOpen(!get().open);
    },

    setOpen(open) {
      writePref("tings3.calendar.open", open ? "1" : "0");
      set({ open });
      if (!open) return;
      if (!get().status) void get().init();
      // Coming back to the panel after a while: show what's current.
      else if (get().status?.connected && Date.now() - lastRefreshAt > REOPEN_REFRESH_MS) void get().refresh();
    },

    setWidth(w) {
      const width = clampWidth(w);
      writePref("tings3.calendar.width", String(width));
      set({ width });
    },

    setCollapsed(collapsed) {
      writePref("tings3.calendar.collapsed", collapsed ? "1" : "0");
      set({ collapsed });
    },

    async init() {
      try {
        const status = await calendarApi().status();
        set({ status, error: null });
        if (status.connected) await get().refresh();
      } catch (e) {
        set({ error: asError(e) });
      }
    },

    setStatus(status) {
      set({ status });
      if (!status.connected) set({ calendars: [], months: {} });
    },

    // Refreshes asked for while one is running are merged into a single
    // follow-up run, so a burst of changes (e.g. "Show all calendars") costs
    // at most two refreshes and the last one always sees the latest settings.
    refresh() {
      if (refreshing) {
        refreshAgain = true;
        return refreshing;
      }
      const run = async () => {
        do {
          refreshAgain = false;
          lastRefreshAt = Date.now();
          await refreshOnce();
        } while (refreshAgain);
      };
      refreshing = run().finally(() => {
        refreshing = null;
      });
      return refreshing;
    },

    async loadMonth(key, force = false) {
      const s = get();
      if (!s.status?.connected) return;
      if (s.loading[key]) {
        // Already loading, maybe with calendars that were just switched on or off: load again after.
        if (force) reloadAfter.add(key);
        return;
      }
      const have = s.months[key];
      if (have && !force && Date.now() - have.at < FRESH_MS) return;
      set((st) => ({ loading: { ...st.loading, [key]: true } }));
      const { start, end } = monthRange(key);
      try {
        const r = await calendarApi().events(start.toISOString(), end.toISOString());
        set((st) => ({ months: { ...st.months, [key]: { events: r.events, at: Date.now(), stale: r.stale, partial: !!r.partial } }, error: r.stale || r.partial ? st.error : null }));
      } catch (e) {
        const err = asError(e);
        set({ error: err });
        if (err.code === "noAccount") void calendarApi().status().then((st) => get().setStatus(st), () => {});
      } finally {
        set((st) => {
          const loading = { ...st.loading };
          delete loading[key];
          return { loading };
        });
        if (reloadAfter.delete(key)) void get().loadMonth(key, true);
      }
    },

    showMonth(key, day) {
      const selectedDay = day ?? (key === monthKey(new Date()) ? dayKey(new Date()) : `${key}-01`);
      set((s) => ({ month: key, agendaFrom: key, agendaTo: addMonth(key, 1), selectedDay, scrollSeq: s.scrollSeq + 1, expanded: null }));
      for (const k of [addMonth(key, -1), key, addMonth(key, 1)]) void get().loadMonth(k);
    },

    goToday() {
      get().showMonth(monthKey(new Date()), dayKey(new Date()));
    },

    pickDay(day) {
      const key = monthKey(day);
      const { agendaFrom, agendaTo } = get();
      if (key < agendaFrom || key > agendaTo) return get().showMonth(key, day);
      set((s) => ({ selectedDay: day, month: key, scrollSeq: s.scrollSeq + 1 }));
      for (const k of [addMonth(key, -1), key, addMonth(key, 1)]) void get().loadMonth(k);
    },

    followDay(day) {
      if (day === get().selectedDay) return;
      const key = monthKey(day);
      set({ selectedDay: day, month: key });
      if (key !== get().month) for (const k of [addMonth(key, -1), key, addMonth(key, 1)]) void get().loadMonth(k);
    },

    extendAgenda() {
      const next = addMonth(get().agendaTo, 1);
      if (next > addMonth(get().agendaFrom, 11)) return; // a year is plenty
      set({ agendaTo: next });
      void get().loadMonth(next);
    },

    setQuery(query) {
      set({ query });
    },

    setExpanded(expanded) {
      set({ expanded });
    },

    async setVisible(id, visible) {
      // Shown or hidden at once; hiding needs nothing from Google.
      set((s) => ({ calendars: s.calendars.map((c) => (c.id === id ? { ...c, visible } : c)) }));
      const seq = ++visibilitySeq;
      try {
        const calendars = await calendarApi().setVisible(id, visible);
        // An older answer arriving after a newer toggle mustn't undo it.
        if (seq === visibilitySeq) set({ calendars });
        if (visible) await get().refresh();
      } catch (e) {
        set((s) => ({ error: asError(e), calendars: s.calendars.map((c) => (c.id === id ? { ...c, visible: !visible } : c)) }));
      }
    },

    async disconnect() {
      try {
        get().setStatus(await calendarApi().disconnect());
      } catch (e) {
        set({ error: asError(e) });
      }
    },
  };
});

/** Every loaded event, deduplicated (months overlap at their edges). */
export function loadedEvents(months: Record<string, MonthData>): CalEvent[] {
  const seen = new Map<string, CalEvent>();
  for (const m of Object.values(months)) for (const e of m.events) seen.set(`${e.calendarId}\u001f${e.id}`, e);
  return [...seen.values()];
}
