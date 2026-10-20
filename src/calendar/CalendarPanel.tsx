// Google Calendar side panel: a month grid over a scrolling agenda, read-only.
// Self-contained — the rest of the app only mounts it and toggles it.
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { calendarApi } from "./api";
import { addDay, addMonth, agendaDayTitle, byDay, dayKey, durationLabel, eventBounds, monthDays, monthKey, monthRange, monthTitle, plainText, rangeLabel, timeLabel, timeOn, WEEKDAY_INITIALS, weekOf } from "./dates";
import { loadedEvents, MAX_WIDTH, MIN_WIDTH, useCalendar } from "./store";
import type { CalendarInfo, CalEvent } from "./types";
import "./calendar.css";

// ---------- icons (kept local so the panel has no app dependencies) ----------

const Svg = ({ size = 16, children }: { size?: number; children: ReactNode }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
    {children}
  </svg>
);
const CalIcon = ({ size = 16 }: { size?: number }) => (
  <Svg size={size}>
    <rect x="2" y="2.8" width="12" height="11.2" rx="2.2" fill="currentColor" />
    <rect x="3.3" y="6.3" width="9.4" height="6.4" rx="1" fill="var(--cal-bg)" />
    <path d="M5.2 1.6v2.6M10.8 1.6v2.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </Svg>
);
const SearchIc = () => (
  <Svg size={15}>
    <circle cx="7" cy="7" r="4.3" stroke="currentColor" strokeWidth="1.5" />
    <path d="m10.3 10.3 3.2 3.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </Svg>
);
const RefreshIc = ({ spin }: { spin?: boolean }) => (
  <span className={spin ? "cal-spin" : undefined}>
    <Svg size={14}>
      <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.7h-2.7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  </span>
);
const Chevron = ({ dir }: { dir: "left" | "right" | "down" }) => (
  <Svg size={12}>
    <path d={dir === "left" ? "M10 3 5 8l5 5" : dir === "right" ? "m6 3 5 5-5 5" : "m3.5 6 4.5 4.5L12.5 6"} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);
const PlusIc = () => (
  <Svg size={16}>
    <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </Svg>
);
const CloseIc = () => (
  <Svg size={12}>
    <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </Svg>
);
const PinIc = () => (
  <Svg size={12}>
    <path d="M8 14s4.5-4.2 4.5-7.5a4.5 4.5 0 0 0-9 0C3.5 9.8 8 14 8 14Z" stroke="currentColor" strokeWidth="1.3" />
    <circle cx="8" cy="6.5" r="1.5" fill="currentColor" />
  </Svg>
);
const PeopleIc = () => (
  <Svg size={12}>
    <circle cx="6" cy="5.5" r="2.2" stroke="currentColor" strokeWidth="1.3" />
    <path d="M2 13c.4-2.2 2-3.4 4-3.4s3.6 1.2 4 3.4M10.5 3.6a2 2 0 0 1 0 3.8M12 9.9c1 .5 1.7 1.5 2 3.1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </Svg>
);
const VideoIc = () => (
  <Svg size={13}>
    <rect x="1.8" y="4" width="8.5" height="8" rx="1.6" stroke="currentColor" strokeWidth="1.3" />
    <path d="m10.3 7 3.9-2.2v6.4L10.3 9" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
  </Svg>
);

// ---------- helpers ----------

const evKey = (e: CalEvent) => `${e.calendarId}\u001f${e.id}`;

function open(url: string) {
  void calendarApi().openUrl(url).catch(() => {});
}

/** Plain text with https links made clickable (opened in the browser). */
function Linkified({ text }: { text: string }) {
  const parts = text.split(/(https:\/\/[^\s<>"')\]]+)/g);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 ? (
          <a key={i} href={p} onClick={(e) => (e.preventDefault(), e.stopPropagation(), open(p))}>
            {p.replace(/^https:\/\/(www\.)?/, "").slice(0, 48)}
            {p.length > 56 ? "…" : ""}
          </a>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}

function ago(ms: number | null): string {
  if (!ms) return "never";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} hr ago`;
  return new Date(ms).toLocaleDateString();
}

function useNow(ms = 60_000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}

// ---------- panel ----------

export default function CalendarPanel({ controls, onClose }: { controls?: ReactNode; onClose: () => void }) {
  const status = useCalendar((s) => s.status);
  const width = useCalendar((s) => s.width);
  const error = useCalendar((s) => s.error);

  useEffect(() => {
    const s = useCalendar.getState();
    if (!s.status) void s.init();
  }, []);

  // Keep it current: every 5 minutes, and when the window comes back after a while.
  useEffect(() => {
    if (!status?.connected) return;
    let last = Date.now();
    const tick = () => {
      last = Date.now();
      void useCalendar.getState().refresh();
    };
    const timer = window.setInterval(tick, 5 * 60_000);
    const onFocus = () => Date.now() - last > 2 * 60_000 && tick();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [status?.connected]);

  return (
    <aside className="cal-panel" style={{ width }} aria-label="Google Calendar">
      <ResizeHandle />
      {!status ? (
        <>
          <PanelTop controls={controls} onClose={onClose} />
          <div className="cal-center">{error ? <p className="cal-error-text">{error.message}</p> : <div className="cal-spinner" />}</div>
        </>
      ) : !status.connected ? (
        <>
          <PanelTop controls={controls} onClose={onClose} />
          <Setup />
        </>
      ) : (
        <Connected controls={controls} onClose={onClose} />
      )}
    </aside>
  );
}

function ResizeHandle() {
  const width = useCalendar((s) => s.width);
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = useCalendar.getState().width;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    document.body.classList.add("cal-resizing");
    const move = (ev: PointerEvent) => useCalendar.getState().setWidth(startW + (startX - ev.clientX));
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      document.body.classList.remove("cal-resizing");
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  return (
    <div
      className="cal-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize calendar"
      aria-valuemin={MIN_WIDTH}
      aria-valuemax={MAX_WIDTH}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={onDown}
      onDoubleClick={() => useCalendar.getState().setWidth(340)}
      onKeyDown={(e) => {
        const s = useCalendar.getState();
        if (e.key === "ArrowLeft") s.setWidth(s.width + 20);
        if (e.key === "ArrowRight") s.setWidth(s.width - 20);
      }}
    />
  );
}

function PanelTop({ controls, onClose, children }: { controls?: ReactNode; onClose: () => void; children?: ReactNode }) {
  return (
    <header className="cal-top" data-tauri-drag-region>
      <span className="cal-brand" title="Google Calendar">
        <CalIcon size={17} />
      </span>
      {children ?? (
        <span className="cal-top-title" data-tauri-drag-region>
          Calendar
        </span>
      )}
      <span className="cal-grow" data-tauri-drag-region />
      <button className="cal-icon-btn" aria-label="Hide calendar (Ctrl+Alt+C)" title="Hide Calendar (Ctrl+Alt+C)" onClick={onClose}>
        <CloseIc />
      </button>
      {controls}
    </header>
  );
}

// ---------- setup ----------

function Setup() {
  const status = useCalendar((s) => s.status)!;
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editClient, setEditClient] = useState(false);
  const api = calendarApi();
  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await f();
    } catch (e) {
      setErr(typeof e === "object" && e && "message" in e ? String((e as { message: string }).message) : String(e));
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    run(async () => {
      useCalendar.getState().setStatus(await api.setClient(clientId, secret));
      setEditClient(false);
    });
  const connect = () =>
    run(async () => {
      const s = await api.connect();
      useCalendar.getState().setStatus(s);
      if (s.connected) await useCalendar.getState().refresh();
    });

  return (
    <div className="cal-setup">
      <div className="cal-setup-art">
        <CalIcon size={34} />
      </div>
      <h2>Google Calendar</h2>
      <p className="cal-lead">See your schedule beside your to-dos. Read-only: Things 3 can look at your events but can never change them.</p>
      {(!status.configured || editClient) && (
        <>
          <ol className="cal-steps">
            <li>
              In Google Cloud, use your Drive backup's project or create one, and{" "}
              <a href="#" onClick={(e) => (e.preventDefault(), open("https://console.cloud.google.com/apis/library/calendar-json.googleapis.com"))}>
                enable the Google Calendar API
              </a>
              .
            </li>
            <li>
              Under{" "}
              <a href="#" onClick={(e) => (e.preventDefault(), open("https://console.cloud.google.com/apis/credentials"))}>
                Credentials
              </a>
              , create an OAuth client ID of type <b>Desktop app</b> (the Drive one works too).
            </li>
            <li>Paste its client ID and secret here.</li>
          </ol>
          <label className="cal-field">
            <span>Client ID</span>
            <input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="1234-abc.apps.googleusercontent.com" spellCheck={false} autoComplete="off" />
          </label>
          <label className="cal-field">
            <span>Client secret</span>
            <input value={secret} onChange={(e) => setSecret(e.target.value)} type="password" placeholder="GOCSPX-…" autoComplete="off" />
          </label>
          <div className="cal-row">
            {editClient && (
              <button className="cal-btn" onClick={() => setEditClient(false)} disabled={busy}>
                Cancel
              </button>
            )}
            <button className="cal-btn primary" disabled={busy || !clientId.trim()} onClick={() => void save()}>
              Save
            </button>
          </div>
        </>
      )}
      {status.configured && !editClient && (
        <>
          <button className="cal-btn primary wide" disabled={busy} onClick={() => void connect()}>
            {busy ? "Waiting for Google…" : "Connect Google Calendar"}
          </button>
          <p className="cal-fine">{busy ? "Finish signing in in your browser, then come back here." : "Your browser opens Google's sign-in page. Only “See your calendars” is requested."}</p>
          {!status.builtInClient && (
            <button className="cal-link" onClick={() => setEditClient(true)} disabled={busy}>
              Use a different client ID
            </button>
          )}
        </>
      )}
      {(err || status.lastError) && <p className="cal-error-text">{err ?? status.lastError}</p>}
    </div>
  );
}

// ---------- connected ----------

function Connected({ controls, onClose }: { controls?: ReactNode; onClose: () => void }) {
  const calendars = useCalendar((s) => s.calendars);
  const months = useCalendar((s) => s.months);
  const query = useCalendar((s) => s.query);
  const loading = useCalendar((s) => Object.keys(s.loading).length > 0);
  const error = useCalendar((s) => s.error);
  const status = useCalendar((s) => s.status)!;
  const selectedDay = useCalendar((s) => s.selectedDay);
  const [searching, setSearching] = useState(false);
  const [menu, setMenu] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const visibleIds = useMemo(() => new Set(calendars.filter((c) => c.visible).map((c) => c.id)), [calendars]);
  const events = useMemo(() => loadedEvents(months).filter((e) => !calendars.length || visibleIds.has(e.calendarId)), [months, calendars.length, visibleIds]);
  const stale = Object.values(months).some((m) => m.stale);
  const days = useMemo(() => byDay(events), [events]);

  useEffect(() => {
    if (searching) searchRef.current?.focus();
  }, [searching]);

  const shown = calendars.filter((c) => c.visible);
  const setLabel = !calendars.length ? "Calendars" : shown.length === calendars.length ? "All Calendars" : shown.length === 1 ? shown[0].name : shown.length === 0 ? "No Calendars" : `${shown.length} Calendars`;

  const newEvent = () => {
    const d = selectedDay.replace(/-/g, "");
    open(`https://calendar.google.com/calendar/r/eventedit?dates=${d}T090000/${d}T100000`);
  };

  return (
    <>
      <PanelTop controls={controls} onClose={onClose}>
        <div className="cal-set-wrap">
          <button className="cal-set" onClick={() => setMenu((m) => !m)} aria-haspopup="menu" aria-expanded={menu}>
            <span className="cal-set-dots" aria-hidden="true">
              {shown.slice(0, 3).map((c) => (
                <i key={c.id} style={{ background: c.color }} />
              ))}
            </span>
            <span className="cal-set-label">{setLabel}</span>
            <Chevron dir="down" />
          </button>
          {menu && <CalendarMenu calendars={calendars} email={status.email} onClose={() => setMenu(false)} />}
        </div>
        <span className="cal-grow" data-tauri-drag-region />
        <button className={`cal-icon-btn${searching ? " on" : ""}`} aria-label="Search events" title="Search" onClick={() => (searching ? (setSearching(false), useCalendar.getState().setQuery("")) : setSearching(true))}>
          <SearchIc />
        </button>
        <button className="cal-icon-btn" aria-label="Refresh" title={`Refresh · updated ${ago(status.lastSyncAt)}`} onClick={() => void useCalendar.getState().refresh()}>
          <RefreshIc spin={loading} />
        </button>
      </PanelTop>
      {searching && (
        <div className="cal-search">
          <SearchIc />
          <input
            ref={searchRef}
            value={query}
            placeholder="Search loaded events"
            aria-label="Search events"
            onChange={(e) => useCalendar.getState().setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                useCalendar.getState().setQuery("");
                setSearching(false);
              }
            }}
          />
        </div>
      )}
      {!query && <MonthGrid days={days} />}
      {(stale || (error && error.code !== "noAccount")) && (
        <div className={`cal-banner${stale ? "" : " error"}`} role="status">
          {stale ? `Offline — showing events saved ${ago(status.lastSyncAt)}.` : error!.message}
        </div>
      )}
      <Agenda days={days} events={events} calendars={calendars} />
      <button className="cal-fab" aria-label="New event in Google Calendar" title="New event (opens Google Calendar)" onClick={newEvent}>
        <PlusIc />
      </button>
    </>
  );
}

function CalendarMenu({ calendars, email, onClose }: { calendars: CalendarInfo[]; email: string | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => !ref.current?.parentElement?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), onClose());
    document.addEventListener("mousedown", down);
    window.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key, true);
    };
  }, [onClose]);
  const s = useCalendar.getState();
  const all = calendars.every((c) => c.visible);
  return (
    <div className="cal-menu" ref={ref} role="menu">
      <div className="cal-menu-head">{email ?? "Google Calendar"}</div>
      {calendars.map((c) => (
        <label key={c.id} className="cal-menu-item" role="menuitemcheckbox" aria-checked={c.visible}>
          <input type="checkbox" checked={c.visible} onChange={(e) => void s.setVisible(c.id, e.target.checked)} style={{ accentColor: c.color }} />
          <i className="cal-swatch" style={{ background: c.color }} />
          <span className="cal-grow">{c.name}</span>
          {c.primary && <span className="cal-menu-tag">Primary</span>}
        </label>
      ))}
      {calendars.length > 1 && (
        <button
          className="cal-menu-btn"
          onClick={() => {
            for (const c of calendars) if (c.visible === all && !(all && c.primary)) void s.setVisible(c.id, !all);
          }}
        >
          {all ? "Show only primary" : "Show all calendars"}
        </button>
      )}
      <div className="cal-menu-sep" />
      <button className="cal-menu-btn" onClick={() => (open("https://calendar.google.com/"), onClose())}>
        Open Google Calendar
      </button>
      <button
        className="cal-menu-btn danger"
        onClick={() => {
          onClose();
          void s.disconnect();
        }}
      >
        Disconnect
      </button>
    </div>
  );
}

// ---------- month grid ----------

function MonthGrid({ days }: { days: Map<string, CalEvent[]> }) {
  const month = useCalendar((s) => s.month);
  const selectedDay = useCalendar((s) => s.selectedDay);
  const collapsed = useCalendar((s) => s.collapsed);
  const now = useNow();
  const today = dayKey(now);
  const s = useCalendar.getState();
  const cells = collapsed ? weekOf(selectedDay) : monthDays(month);
  const { month: name, year } = monthTitle(month);
  const step = (n: number) => (collapsed ? s.pickDay(addDay(selectedDay, n * 7)) : s.showMonth(addMonth(month, n)));

  return (
    <section
      className="cal-grid-wrap"
      onWheel={(e) => {
        // Horizontal swipes on a touchpad flip months, like the iPad app.
        if (Math.abs(e.deltaX) > 30 && Math.abs(e.deltaX) > Math.abs(e.deltaY) * 2) step(e.deltaX > 0 ? 1 : -1);
      }}
    >
      <div className="cal-month-row">
        <button className="cal-month-title" onClick={() => s.goToday()} title="Go to today">
          <b>{name}</b> {year}
        </button>
        <span className="cal-grow" />
        {(month !== monthKey(now) || selectedDay !== today) && (
          <button className="cal-today-btn" onClick={() => s.goToday()}>
            Today
          </button>
        )}
        <button className="cal-icon-btn" aria-label={collapsed ? "Previous week" : "Previous month"} onClick={() => step(-1)}>
          <Chevron dir="left" />
        </button>
        <button className="cal-icon-btn" aria-label={collapsed ? "Next week" : "Next month"} onClick={() => step(1)}>
          <Chevron dir="right" />
        </button>
      </div>
      <div className="cal-grid" role="grid" aria-label={`${name} ${year}`}>
        {WEEKDAY_INITIALS.map((d) => (
          <span key={d} className="cal-wd" role="columnheader">
            {d}
          </span>
        ))}
        {cells.map((d) => {
          const evs = days.get(d) ?? [];
          const colors = [...new Set(evs.filter((e) => !e.declined).map((e) => e.color))].slice(0, 3);
          const inMonth = collapsed || d.startsWith(month);
          const weekSel = !collapsed && weekOf(selectedDay).includes(d);
          return (
            <button
              key={d}
              role="gridcell"
              aria-selected={d === selectedDay}
              aria-label={`${new Date(d + "T12:00").toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}${evs.length ? `, ${evs.length} event${evs.length === 1 ? "" : "s"}` : ""}`}
              className={`cal-day${inMonth ? "" : " out"}${d === today ? " today" : ""}${d === selectedDay ? " sel" : ""}${weekSel ? " week" : ""}${d < today ? " past" : ""}`}
              onClick={() => s.pickDay(d)}
            >
              <span className="cal-num">{Number(d.slice(8))}</span>
              <span className="cal-dots">
                {colors.map((c) => (
                  <i key={c} style={{ background: c }} />
                ))}
              </span>
            </button>
          );
        })}
      </div>
      <button className="cal-grabber" aria-label={collapsed ? "Show the whole month" : "Show one week"} title={collapsed ? "Show month" : "Show week"} onClick={() => s.setCollapsed(!collapsed)}>
        <span />
      </button>
    </section>
  );
}

// ---------- agenda ----------

function Agenda({ days, events, calendars }: { days: Map<string, CalEvent[]>; events: CalEvent[]; calendars: CalendarInfo[] }) {
  const agendaFrom = useCalendar((s) => s.agendaFrom);
  const agendaTo = useCalendar((s) => s.agendaTo);
  const selectedDay = useCalendar((s) => s.selectedDay);
  const scrollSeq = useCalendar((s) => s.scrollSeq);
  const query = useCalendar((s) => s.query).trim().toLowerCase();
  const loadingAny = useCalendar((s) => Object.keys(s.loading).length > 0);
  const now = useNow();
  const today = dayKey(now);
  const ref = useRef<HTMLDivElement>(null);
  const programmatic = useRef(0);
  const calName = useMemo(() => new Map(calendars.map((c) => [c.id, c.name])), [calendars]);

  // Which days to list: days with events in range, plus today and the selected day.
  const list = useMemo(() => {
    if (query) {
      const hits = events.filter((e) => [e.title, e.location ?? "", e.description ?? "", e.organizer ?? "", calName.get(e.calendarId) ?? ""].some((f) => f.toLowerCase().includes(query)));
      const m = byDay(hits);
      return [...m.keys()].sort().map((d) => ({ day: d, events: m.get(d)! }));
    }
    const from = monthRange(agendaFrom).start;
    const to = monthRange(agendaTo).end;
    const out: { day: string; events: CalEvent[] }[] = [];
    for (let d = dayKey(from); d < dayKey(to); d = addDay(d, 1)) {
      const evs = days.get(d);
      if (evs?.length || d === today || d === selectedDay) out.push({ day: d, events: evs ?? [] });
    }
    return out;
  }, [query, events, days, agendaFrom, agendaTo, today, selectedDay, calName]);

  // Scroll to the selected day when the grid asks for it.
  useEffect(() => {
    const box = ref.current;
    if (!box || query) return;
    const target = [...box.querySelectorAll<HTMLElement>("[data-day]")].find((el) => el.dataset.day! >= selectedDay);
    programmatic.current = Date.now();
    box.scrollTop = target ? target.offsetTop - 1 : 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollSeq, list.length > 0]);

  const onScroll = () => {
    const box = ref.current;
    if (!box) return;
    if (box.scrollTop + box.clientHeight > box.scrollHeight - 400 && !query) useCalendar.getState().extendAgenda();
    if (Date.now() - programmatic.current < 400 || query) return;
    // The day whose header sits at the top follows into the grid.
    const top = box.scrollTop + 8;
    let current: string | null = null;
    for (const el of box.querySelectorAll<HTMLElement>("[data-day]")) {
      if (el.offsetTop <= top) current = el.dataset.day!;
      else break;
    }
    if (current) useCalendar.getState().followDay(current);
  };

  return (
    <div className="cal-agenda" ref={ref} onScroll={onScroll}>
      {query && <div className="cal-search-note">{list.length ? `${list.reduce((n, d) => n + d.events.length, 0)} matches in loaded months` : "No matching events in the loaded months."}</div>}
      {list.map(({ day, events: evs }) => {
        const t = agendaDayTitle(day, today);
        const nowIndex = day === today ? evs.findIndex((e) => !timeOn(e, day).allDay && eventBounds(e).start > now) : -1;
        return (
          <section key={day} className={`cal-day-sec${day === today ? " is-today" : ""}${day === selectedDay && !query ? " is-sel" : ""}`} data-day={day}>
            <h3 className="cal-day-title">
              <span>{t.weekday}</span> {t.date}
              {t.relative && <em>{t.relative}</em>}
            </h3>
            {evs.length === 0 && <p className="cal-none">No events</p>}
            {evs.map((e, i) => (
              <Fragment key={evKey(e)}>
                {i === nowIndex && <NowLine now={now} />}
                <EventRow event={e} day={day} now={now} calendar={calName.get(e.calendarId)} />
              </Fragment>
            ))}
            {day === today && nowIndex === -1 && evs.some((e) => !timeOn(e, day).allDay) && <NowLine now={now} />}
          </section>
        );
      })}
      {!query && (
        <button className="cal-more" onClick={() => useCalendar.getState().extendAgenda()} disabled={loadingAny}>
          {loadingAny ? "Loading…" : "Show more"}
        </button>
      )}
    </div>
  );
}

function NowLine({ now }: { now: Date }) {
  return (
    <div className="cal-now" aria-label={`Now, ${timeLabel(now)}`}>
      <i />
    </div>
  );
}

function EventRow({ event: e, day, now, calendar }: { event: CalEvent; day: string; now: Date; calendar?: string }) {
  const key = `${evKey(e)}@${day}`;
  const expanded = useCalendar((s) => s.expanded === key);
  const t = timeOn(e, day);
  const { end } = eventBounds(e);
  const past = end <= now;
  const desc = useMemo(() => (expanded && e.description ? plainText(e.description) : ""), [expanded, e.description]);
  const toggle = () => useCalendar.getState().setExpanded(expanded ? null : key);
  const sub = e.location ?? (e.organizer ? `Organized by ${e.organizer}` : null);

  return (
    <div className={`cal-event${t.allDay ? " all-day" : ""}${past ? " past" : ""}${e.declined ? " declined" : ""}${expanded ? " open" : ""}`}>
      <button className="cal-event-main" onClick={toggle} aria-expanded={expanded} style={{ ["--ev" as string]: e.color }}>
        {t.allDay ? (
          <span className="cal-pill">{e.title}</span>
        ) : (
          <>
            <span className="cal-time">
              <i className="cal-dot" />
              {t.label}
            </span>
            <span className="cal-title">{e.title}</span>
            {sub && <span className="cal-sub">{sub}</span>}
          </>
        )}
      </button>
      {expanded && (
        <div className="cal-detail">
          <div className="cal-detail-line strong">{rangeLabel(e)}</div>
          {durationLabel(e) && <div className="cal-detail-line">{durationLabel(e)}</div>}
          {e.location && (
            <button className="cal-detail-line link" onClick={() => open(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(e.location!)}`)}>
              <PinIc /> {e.location}
            </button>
          )}
          {e.meet && (
            <button className="cal-btn primary small" onClick={() => open(e.meet!)}>
              <VideoIc /> Join video call
            </button>
          )}
          {(e.attendees > 0 || e.organizer) && (
            <div className="cal-detail-line">
              <PeopleIc /> {e.attendees > 0 ? `${e.attendees} guest${e.attendees === 1 ? "" : "s"}` : ""}
              {e.organizer ? `${e.attendees > 0 ? " · " : ""}Organizer: ${e.organizer}` : ""}
            </div>
          )}
          {e.declined && <div className="cal-detail-line warn">You declined this event.</div>}
          {desc && (
            <p className="cal-desc">
              <Linkified text={desc} />
            </p>
          )}
          <div className="cal-detail-foot">
            <span className="cal-detail-cal">
              <i className="cal-swatch" style={{ background: e.color }} /> {calendar ?? "Calendar"}
              {e.free ? " · Free" : ""}
            </span>
            {e.link && (
              <button className="cal-link" onClick={() => open(e.link!)}>
                Open in Google Calendar
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
