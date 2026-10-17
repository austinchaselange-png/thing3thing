// Task actions shared by rows, the editor, drag-and-drop and shortcuts.
import { addDays, todayYmd } from "./lib/dates";
import type { MoveTarget } from "./components/Pickers";
import { useStore } from "./store";
import type { Mutation, Selection, Task, When } from "./types";

const apply = (m: Mutation) => useStore.getState().apply(m);

export function toggleComplete(t: Task) {
  return apply({ type: "setStatus", id: t.id, baseRev: t.rev, status: t.status === "open" ? "completed" : "open" });
}

export function schedule(t: Task, when: When, reminder?: string | null) {
  const m: Mutation = { type: "schedule", id: t.id, baseRev: t.rev, when };
  if (reminder !== undefined) m.reminder = reminder;
  return apply(m);
}

export async function moveTo(t: Task, target: MoveTarget) {
  if (target.inbox) {
    if (t.areaId || t.projectId || t.headingId) {
      const r = await apply({ type: "move", id: t.id, baseRev: t.rev });
      if (!r) return null;
    }
    const fresh = useStore.getState().view?.tasks.find((x) => x.id === t.id) ?? t;
    return apply({ type: "schedule", id: t.id, baseRev: fresh.rev, when: { kind: "inbox" } });
  }
  return apply({ type: "move", id: t.id, baseRev: t.rev, areaId: target.areaId ?? null, projectId: target.projectId ?? null, headingId: target.headingId ?? null });
}

export function trash(t: Task, trashed = true) {
  return apply({ type: "setTrashed", id: t.id, baseRev: t.rev, trashed });
}

/** Defaults for a new to-do created while viewing `sel`. */
export function newTaskDefaults(sel: Selection, section?: string): Partial<Extract<Mutation, { type: "createTask" }>> {
  if (sel.kind === "project") return { projectId: sel.id, headingId: section && section !== "none" && section !== "done" ? section : null };
  if (sel.kind === "area") return { areaId: sel.id, when: section === "someday" ? { kind: "someday" } : undefined };
  if (sel.kind === "tag") return { tagIds: [sel.id], when: { kind: "anytime" } };
  switch (sel.id) {
    case "today":
      return { when: section === "evening" ? { kind: "evening" } : { kind: "today" } };
    case "upcoming":
      return section && /^\d{4}-\d{2}-\d{2}$/.test(section) ? { when: { kind: "date", date: section } } : { when: { kind: "date", date: addDays(todayYmd(), 1) } };
    case "anytime":
      return { when: { kind: "anytime" } };
    case "someday":
      return { when: { kind: "someday" } };
    default:
      return {};
  }
}
