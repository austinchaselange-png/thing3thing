// Google Calendar side panel — shapes shared with src-tauri/src/gcal.rs.
// Nothing in here is shared with the to-do side of the app.

export interface CalStatus {
  configured: boolean;
  builtInClient: boolean;
  connected: boolean;
  email: string | null;
  lastSyncAt: number | null;
  lastError: string | null;
}

export interface CalendarInfo {
  id: string;
  name: string;
  color: string;
  primary: boolean;
  visible: boolean;
}

export interface CalEvent {
  id: string;
  calendarId: string;
  title: string;
  /** "YYYY-MM-DD" for all-day events (end exclusive), RFC 3339 otherwise. */
  start: string;
  end: string;
  allDay: boolean;
  location: string | null;
  description: string | null;
  link: string | null;
  meet: string | null;
  color: string;
  declined: boolean;
  free: boolean;
  organizer: string | null;
  attendees: number;
}

export interface EventsResult {
  events: CalEvent[];
  stale: boolean;
  /** Some calendars couldn't be fetched; their events are the last ones saved. */
  partial?: boolean;
  fetchedAt: number | null;
}

export interface CalError {
  code: string;
  message: string;
}
