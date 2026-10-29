import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEventBase from "@testing-library/user-event";

// No artificial delay between keystrokes: same events, much faster.
const userEvent = userEventBase.setup({ delay: null });
import { beforeEach, describe, expect, it } from "vitest";
import { MockCalendarApi, setCalendarApiForTests } from "./api";
import CalendarPanel from "./CalendarPanel";
import { addMonth, byDay, dayKey, eventDays, monthDays, monthKey, plainText, rangeLabel, timeOn, weekOf } from "./dates";
import { loadedEvents, resetCalendarQueues, useCalendar } from "./store";
import type { CalEvent } from "./types";

const ev = (p: Partial<CalEvent>): CalEvent => ({
  id: "e",
  calendarId: "c",
  title: "Event",
  start: "2026-10-20",
  end: "2026-10-21",
  allDay: true,
  location: null,
  description: null,
  link: null,
  meet: null,
  color: "#039be5",
  declined: false,
  free: false,
  organizer: null,
  attendees: 0,
  ...p,
});

function resetStore() {
  resetCalendarQueues();
  const today = dayKey(new Date());
  const m = monthKey(new Date());
  useCalendar.setState({ open: true, status: null, calendars: [], months: {}, loading: {}, error: null, month: m, agendaFrom: m, agendaTo: addMonth(m, 1), selectedDay: today, query: "", expanded: null, collapsed: false });
}

describe("calendar dates", () => {
  it("builds Sunday-first grids and weeks", () => {
    const days = monthDays("2026-10");
    expect(days).toHaveLength(42);
    expect(days[0]).toBe("2026-09-27"); // Oct 1 2026 is a Thursday
    expect(weekOf("2026-10-21")).toEqual(["2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24"]);
  });

  it("spreads events over the days they touch", () => {
    expect(eventDays(ev({ start: "2026-10-20", end: "2026-10-23" }))).toEqual(["2026-10-20", "2026-10-21", "2026-10-22"]);
    const overnight = ev({ allDay: false, start: new Date(2026, 9, 20, 22).toISOString(), end: new Date(2026, 9, 21, 2).toISOString() });
    expect(eventDays(overnight)).toEqual(["2026-10-20", "2026-10-21"]);
    expect(timeOn(overnight, "2026-10-21").label).toMatch(/^Until /);
    const toMidnight = ev({ allDay: false, start: new Date(2026, 9, 20, 23).toISOString(), end: new Date(2026, 9, 21, 0).toISOString() });
    expect(eventDays(toMidnight)).toEqual(["2026-10-20"]);
  });

  it("sorts each day with all-day events first", () => {
    const m = byDay([ev({ id: "b", allDay: false, start: new Date(2026, 9, 20, 9).toISOString(), end: new Date(2026, 9, 20, 10).toISOString() }), ev({ id: "a" })]);
    expect(m.get("2026-10-20")!.map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("labels the last day of an all-day range by calendar day, across a DST change", () => {
    // US clocks change on Sun, Mar 8 2026; the exclusive end is Mon, Mar 9.
    const label = rangeLabel(ev({ start: "2026-03-06", end: "2026-03-09" }));
    const f: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" };
    expect(label).toBe(`${new Date(2026, 2, 6).toLocaleDateString(undefined, f)} – ${new Date(2026, 2, 8).toLocaleDateString(undefined, f)}`);
  });

  it("reads simple HTML descriptions as text", () => {
    expect(plainText("<p>Agenda</p><ul><li>One</li></ul><script>alert(1)</script>")).toBe("Agenda\n• One\nalert(1)");
    expect(plainText("plain")).toBe("plain");
  });
});

describe("calendar panel", () => {
  beforeEach(resetStore);

  it("walks through setup and connecting", async () => {
    setCalendarApiForTests(new MockCalendarApi(false));
    render(<CalendarPanel onClose={() => {}} />);
    expect(await screen.findByRole("heading", { name: "Google Calendar" })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Client ID"), "nope");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/doesn't look like a Google OAuth client ID/)).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("Client ID"));
    await userEvent.type(screen.getByLabelText("Client ID"), "123-abc.apps.googleusercontent.com");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await userEvent.click(await screen.findByRole("button", { name: "Connect Google Calendar" }));
    expect(await screen.findByRole("button", { name: /All Calendars|Calendars/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText("Team standup").length + screen.getAllByText("Dinner with Alex").length).toBeGreaterThan(0));
  });

  it("shows the agenda, expands an event, searches and hides a calendar", async () => {
    setCalendarApiForTests(new MockCalendarApi(true));
    render(<CalendarPanel onClose={() => {}} />);
    const dinner = (await screen.findAllByText("Dinner with Alex"))[0];
    await userEvent.click(dinner);
    // The location shows under the title and again, as a maps link, in the details.
    await waitFor(() => expect(screen.getAllByText(/Luigi's/)).toHaveLength(2));
    expect(screen.getByRole("button", { name: "Open in Google Calendar" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Search events" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Search events" }), "dentist");
    expect(await screen.findByText(/matches in loaded months/)).toBeInTheDocument();
    expect(screen.getAllByText("Dentist").length).toBeGreaterThan(0);
    expect(screen.queryByText("Dinner with Alex")).toBeNull();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search events" }), { key: "Escape" });

    await userEvent.click(screen.getByRole("button", { name: /3 Calendars/ })); // Sports starts hidden
    const menu = await screen.findByRole("menu");
    await userEvent.click(within(menu).getByText("Work"));
    await waitFor(() => expect(screen.queryAllByText("Team standup")).toHaveLength(0));
    expect(useCalendar.getState().calendars.find((c) => c.id === "work")?.visible).toBe(false);
  });

  it("loads a calendar switched on while a refresh is already running", async () => {
    // Events requests wait until released, so the toggle lands mid-refresh.
    class SlowApi extends MockCalendarApi {
      gate: Promise<void> = Promise.resolve();
      async events(min: string, max: string) {
        await this.gate;
        return super.events(min, max);
      }
    }
    const api = new SlowApi(true);
    setCalendarApiForTests(api);
    useCalendar.setState({ status: await api.status() });
    let release!: () => void;
    api.gate = new Promise((r) => (release = r));
    const first = useCalendar.getState().refresh();
    await waitFor(() => expect(Object.keys(useCalendar.getState().loading).length).toBeGreaterThan(0));
    // Sports starts hidden; switching it on mid-refresh must not be lost.
    const toggled = useCalendar.getState().setVisible("sports", true);
    release();
    await first;
    await toggled;
    await waitFor(() => expect(Object.keys(useCalendar.getState().loading)).toHaveLength(0));
    const sports = loadedEvents(useCalendar.getState().months).filter((e) => e.calendarId === "sports");
    expect(sports.length).toBeGreaterThan(0);
  });

  it("merges a burst of refreshes into at most one more", async () => {
    const api = new MockCalendarApi(true);
    let calls = 0;
    const calendars = api.calendars.bind(api);
    api.calendars = async () => (calls++, calendars());
    setCalendarApiForTests(api);
    useCalendar.setState({ status: await api.status() });
    await Promise.all([1, 2, 3, 4, 5].map(() => useCalendar.getState().refresh()));
    expect(calls).toBeLessThanOrEqual(2);
  });

  it("navigates months and collapses to a week", async () => {
    setCalendarApiForTests(new MockCalendarApi(true));
    render(<CalendarPanel onClose={() => {}} />);
    await screen.findAllByText("Dinner with Alex");
    const start = useCalendar.getState().month;
    await userEvent.click(screen.getByRole("button", { name: "Next month" }));
    expect(useCalendar.getState().month).toBe(addMonth(start, 1));
    await userEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(useCalendar.getState().month).toBe(start);
    await userEvent.click(screen.getByRole("button", { name: "Show one week" }));
    expect(screen.getAllByRole("gridcell")).toHaveLength(7);
    await act(async () => useCalendar.getState().setCollapsed(false));
    expect(screen.getAllByRole("gridcell")).toHaveLength(42);
    expect(loadedEvents(useCalendar.getState().months).length).toBeGreaterThan(10);
  });
});
