// Reminders that just went off, with Snooze like Things 3.24: 15 minutes,
// 1 hour, 3 hours or tomorrow. Snoozing moves the reminder (and syncs it).
import { bulkSetStatus } from "../actions";
import { addDays, todayYmd } from "../lib/dates";
import { useStore } from "../store";
import type { Task } from "../types";
import { BellIcon, CheckIcon, CloseIcon } from "./Icons";

export interface DueReminder {
  taskId: string;
  title: string;
  at: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Moves a to-do's reminder: minutes from now, or "tomorrow" at the same time. */
export async function snooze(t: Task, by: number | "tomorrow") {
  const s = useStore.getState();
  if (by === "tomorrow") {
    const time = t.reminder ?? `${pad(new Date().getHours())}:${pad(new Date().getMinutes())}`;
    await s.apply({ type: "schedule", id: t.id, baseRev: t.rev, when: { kind: "date", date: addDays(todayYmd(), 1) }, reminder: time });
    return;
  }
  const at = new Date(Date.now() + by * 60_000);
  const sameDay = at.toDateString() === new Date().toDateString();
  const date = sameDay ? todayYmd() : addDays(todayYmd(), 1);
  await s.apply({ type: "schedule", id: t.id, baseRev: t.rev, when: sameDay ? (t.evening ? { kind: "evening" } : { kind: "today" }) : { kind: "date", date }, reminder: `${pad(at.getHours())}:${pad(at.getMinutes())}` });
}

export const SNOOZE_OPTIONS: [string, number | "tomorrow"][] = [
  ["15 Minutes", 15],
  ["1 Hour", 60],
  ["3 Hours", 180],
  ["Tomorrow", "tomorrow"],
];

export function ReminderBar({ items, onDismiss }: { items: DueReminder[]; onDismiss: (taskId: string) => void }) {
  const view = useStore((s) => s.view);
  const writable = useStore((s) => !!s.app?.canWrite);
  const shown = items.map((r) => ({ r, t: view?.tasks.find((x) => x.id === r.taskId) })).filter((x) => x.t && x.t.status === "open");
  if (!shown.length) return null;
  return (
    <div className="reminder-bar" role="status" aria-label="Reminders">
      {shown.map(({ r, t }) => (
        <div key={r.taskId} className="reminder-card">
          <BellIcon size={14} className="reminder-bell" />
          <button className="reminder-title" onClick={() => (useStore.getState().selectTask(t!.id), onDismiss(r.taskId))} title="Show to-do">
            {t!.title || r.title}
          </button>
          <span className="reminder-at">{r.at}</span>
          {writable &&
            SNOOZE_OPTIONS.map(([label, by]) => (
              <button
                key={label}
                className="chip"
                onClick={() => {
                  onDismiss(r.taskId);
                  void snooze(t!, by);
                }}
              >
                {label}
              </button>
            ))}
          {writable && (
            <button
              className="icon-btn"
              title="Complete"
              aria-label="Complete"
              onClick={() => {
                onDismiss(r.taskId);
                void bulkSetStatus([t!], "completed");
              }}
            >
              <CheckIcon />
            </button>
          )}
          <button className="icon-btn" title="Dismiss" aria-label="Dismiss" onClick={() => onDismiss(r.taskId)}>
            <CloseIcon size={11} />
          </button>
        </div>
      ))}
    </div>
  );
}
