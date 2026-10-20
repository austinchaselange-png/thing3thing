import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { MockCalendarApi, setCalendarApiForTests } from "./api";
import CalendarPanel from "./CalendarPanel";
import { addMonth, byDay, dayKey, eventDays, monthDays, monthKey, plainText, timeOn, weekOf } from "./dates";
import { loadedEvents, useCalendar } from "./store";
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
