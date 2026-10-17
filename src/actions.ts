// Task actions shared by rows, the editor, drag-and-drop and shortcuts.
import { addDays, todayYmd } from "./lib/dates";
import type { MoveTarget } from "./components/Pickers";
import { useStore } from "./store";
import { belongsTo, buildIndex } from "./lib/lists";
import type { ListId, Mutation, Selection, Task, TaskStatus, When } from "./types";

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

const fresh = (t: Task) => useStore.getState().view?.tasks.find((x) => x.id === t.id) ?? t;

/** Moves to (or restores from) the Trash. Trashing offers Undo. */
export async function trash(t: Task, trashed = true) {
  const r = await apply({ type: "setTrashed", id: t.id, baseRev: t.rev, trashed });
  if (r && trashed) {
    useStore.getState().toast(`Moved “${t.title || "Untitled"}” to the Trash`, "info", { label: "Undo", run: () => void trash(fresh(t), false) });
  }
  return r;
}

export function setStatus(t: Task, status: TaskStatus) {
  return apply({ type: "setStatus", id: t.id, baseRev: t.rev, status });
}

/** The When choice that reproduces a task's current schedule. */
export function whenOf(t: Task): When {
  if (t.start === "inbox") return { kind: "inbox" };
  if (t.startDate && t.startDate <= todayYmd()) return t.evening ? { kind: "evening" } : { kind: "today" };
  if (t.startDate) return { kind: "date", date: t.startDate };
  return t.start === "someday" ? { kind: "someday" } : { kind: "anytime" };
}

/** Creates a copy of a to-do with its notes, schedule, tags and checklist. */
export async function duplicate(t: Task) {
  const s = useStore.getState();
  const checklist = (s.view?.checklist ?? []).filter((c) => c.taskId === t.id).sort((a, b) => a.index - b.index).map((c) => c.title);
  const r = await apply({
    type: "createTask",
    title: t.title || "Untitled",
    notes: t.notes,
    when: whenOf(t),
    deadline: t.deadline,
    tagIds: t.tagIds,
    areaId: t.headingId || t.projectId ? null : t.areaId,
    projectId: t.headingId ? null : t.projectId,
    headingId: t.headingId,
    checklist,
  });
  if (r?.created[0]) {
    s.selectTask(r.created[0]);
    s.toast("Duplicated", "success");
  }
  return r;
}

export async function copyText(text: string, what = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    useStore.getState().toast(what, "success");
  } catch {
    useStore.getState().toast("Couldn't access the clipboard.", "error");
  }
}

/** Asks for a new name, then applies it. */
export function promptRename(title: string, initial: string, submit: (value: string) => void) {
  useStore.getState().openDialog({
    kind: "prompt",
    title,
    label: "Name",
    initial,
    confirmLabel: "Rename",
    onSubmit: (v) => {
      if (v.trim() && v.trim() !== initial) submit(v.trim());
    },
  });
}

export function renameTask(t: Task) {
  const noun = t.type === "project" ? "Project" : t.type === "heading" ? "Heading" : "To-Do";
  promptRename(`Rename ${noun}`, t.title, (title) => void apply({ type: "updateTask", id: t.id, baseRev: fresh(t).rev, title }));
}

/** Shows the list or project that contains a to-do, and selects it. */
export function reveal(t: Task) {
  const s = useStore.getState();
  if (!s.view) return;
  if (t.type === "project") return s.select({ kind: "project", id: t.id });
  let sel: Selection;
  if (t.projectId) sel = { kind: "project", id: t.projectId };
  else {
    const ix = buildIndex(s.view);
    const lists: ListId[] = ["inbox", "today", "upcoming", "anytime", "someday", "logbook", "trash"];
    const found = lists.find((l) => belongsTo(l, t, ix, todayYmd()));
    sel = found ? { kind: "list", id: found } : t.areaId ? { kind: "area", id: t.areaId } : { kind: "list", id: "anytime" };
  }
  s.select(sel);
  s.selectTask(t.id);
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
