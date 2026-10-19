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
export async function duplicate(t: Task, opts: { quiet?: boolean } = {}) {
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
  if (r?.created[0] && !opts.quiet) {
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

// ---------------- several to-dos at once (multi-selection) ----------------

const plural = (n: number, noun = "to-do") => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** Runs `fn` on every task. When writes are off, runs it once so the user sees why. */
async function bulk<T>(tasks: Task[], fn: (t: Task) => Promise<T>): Promise<T[]> {
  if (!tasks.length) return [];
  if (!useStore.getState().canWrite()) return [await fn(tasks[0])];
  // The backend serializes writes; sending them together keeps the UI snappy.
  return Promise.all(tasks.map((t) => fn(fresh(t))));
}

const okCount = (rs: unknown[]) => rs.filter(Boolean).length;

export async function bulkSetStatus(tasks: Task[], status: TaskStatus) {
  const targets = tasks.filter((t) => t.status !== status && t.type !== "heading");
  const n = okCount(await bulk(targets, (t) => setStatus(t, status)));
  if (n > 1) {
    const verb = status === "open" ? "Reopened" : status === "completed" ? "Completed" : "Canceled";
    useStore.getState().toast(`${verb} ${plural(n)}`, "success", { label: "Undo", run: () => void bulkSetStatus(targets.map(fresh), "open") });
  }
}

export async function bulkSchedule(tasks: Task[], when: When, reminder?: string | null) {
  const targets = tasks.filter((t) => t.type !== "heading" && !(when.kind === "inbox" && (t.projectId || t.areaId || t.headingId || t.type === "project")));
  await bulk(targets, (t) => schedule(t, when, reminder));
}

export async function bulkMove(tasks: Task[], target: MoveTarget) {
  // Projects only go into areas; headings stay where they are.
  const intoProject = !!(target.projectId || target.headingId || target.inbox);
  const targets = tasks.filter((t) => t.type === "task" || (t.type === "project" && !intoProject));
  await bulk(targets, (t) => moveTo(t, target));
}

export async function bulkTrash(tasks: Task[], trashed = true) {
  if (trashed && tasks.length && tasks.every((t) => t.trashed)) return deletePermanently(tasks);
  tasks = tasks.filter((t) => t.trashed !== trashed);
  if (!tasks.length) return;
  if (tasks.length === 1) return void (await trash(tasks[0], trashed));
  const n = okCount(await bulk(tasks, (t) => apply({ type: "setTrashed", id: t.id, baseRev: t.rev, trashed })));
  const s = useStore.getState();
  if (n) s.setSelectMode(false);
  if (n && !trashed) s.toast(`Put back ${plural(n)}`, "success");
  if (n && trashed) {
    s.toast(`Moved ${plural(n)} to the Trash`, "info", { label: "Undo", run: () => void bulkTrash(tasks.map(fresh), false) });
  }
}

/** Things' Delete in the Trash: asks, then deletes for good. */
export function deletePermanently(tasks: Task[]) {
  const s = useStore.getState();
  const ids = tasks.filter((t) => t.trashed || t.projectId || t.headingId).map((t) => t.id);
  if (!ids.length) return;
  if (s.app && !s.app.policy.destructive) {
    s.toast("Permanent deletions are turned off.", "info", { label: "Turn on…", run: () => s.openDialog({ kind: "destructiveOptIn" }) });
    return;
  }
  const one = tasks.length === 1 ? `“${tasks[0].title || "Untitled"}”` : plural(tasks.length);
  s.openDialog({
    kind: "confirm",
    title: `Delete ${one} permanently?`,
    body: "They're removed from Things everywhere, including your iPhone. This can't be undone.",
    mutation: { type: "deleteTasks", ids, confirm: "" },
    phrase: false,
  });
}

/** Empty Trash: everything in the Trash, permanently. */
export function emptyTrash() {
  const v = useStore.getState().view;
  const tasks = (v?.tasks ?? []).filter((t) => t.trashed);
  if (tasks.length) deletePermanently(tasks);
}

export async function bulkDeadline(tasks: Task[], deadline: string | null) {
  await bulk(tasks.filter((t) => t.type !== "heading"), (t) => apply({ type: "updateTask", id: t.id, baseRev: t.rev, deadline }));
}

/** Adds and removes tags on every task, keeping each task's other tags. */
export async function bulkTags(tasks: Task[], add: string[], remove: string[]) {
  const targets = tasks.filter((t) => add.some((id) => !t.tagIds.includes(id)) || remove.some((id) => t.tagIds.includes(id)));
  await bulk(targets, (t) => {
    const tagIds = [...new Set([...t.tagIds.filter((id) => !remove.includes(id)), ...add])];
    return apply({ type: "updateTask", id: t.id, baseRev: t.rev, tagIds });
  });
}

/** Tags every task has: what the tag picker shows as checked. */
export function commonTags(tasks: Task[]): string[] {
  if (!tasks.length) return [];
  return tasks[0].tagIds.filter((id) => tasks.every((t) => t.tagIds.includes(id)));
}

export async function bulkDuplicate(tasks: Task[]) {
  const s = useStore.getState();
  const rs = await bulk(tasks.filter((t) => t.type === "task"), (t) => duplicate(t, { quiet: true }));
  const created = rs.map((r) => r?.created[0]).filter((x): x is string => !!x);
  if (created.length) {
    s.setSelected(created);
    s.toast(created.length === 1 ? "Duplicated" : `Duplicated ${plural(created.length)}`, "success");
  }
}

/** Copies a project with its headings, open to-dos and checklists. */
export async function duplicateProject(p: Task) {
  const s = useStore.getState();
  const snap = s.view;
  if (!snap) return;
  const r = await apply({ type: "createTask", kind: "project", title: p.title || "Untitled Project", notes: p.notes, when: whenOf(p), deadline: p.deadline, tagIds: p.tagIds, areaId: p.areaId });
  const copy = r?.created[0];
  if (!copy) return;
  // New items go to the top, so create them last-first to keep the original order.
  const children = snap.tasks.filter((t) => t.projectId === p.id && t.id !== p.id && !t.trashed && t.status === "open").sort((a, b) => b.index - a.index);
  const headingMap = new Map<string, string>();
  for (const h of children.filter((t) => t.type === "heading")) {
    const hr = await apply({ type: "createTask", kind: "heading", title: h.title || "Heading", projectId: copy });
    if (hr?.created[0]) headingMap.set(h.id, hr.created[0]);
  }
  for (const t of children.filter((c) => c.type === "task")) {
    const checklist = snap.checklist.filter((c) => c.taskId === t.id).sort((a, b) => a.index - b.index).map((c) => c.title);
    const headingId = t.headingId ? (headingMap.get(t.headingId) ?? null) : null;
    await apply({ type: "createTask", title: t.title || "Untitled", notes: t.notes, when: whenOf(t), deadline: t.deadline, tagIds: t.tagIds, projectId: headingId ? null : copy, headingId, checklist });
  }
  s.select({ kind: "project", id: copy });
  s.toast("Project duplicated", "success");
}

/** Plain-text rendering of to-dos for Share and the clipboard. */
export function tasksAsText(tasks: Task[], title?: string): string {
  const snap = useStore.getState().view;
  const lines: string[] = title ? [title, ""] : [];
  for (const t of tasks) {
    lines.push(`${t.status === "open" ? "- [ ]" : "- [x]"} ${t.title || "Untitled"}`);
    if (t.notes.trim()) lines.push(...t.notes.trim().split("\n").map((l) => `    ${l}`));
    for (const c of (snap?.checklist ?? []).filter((c) => c.taskId === t.id).sort((a, b) => a.index - b.index)) {
      lines.push(`    ${c.completed ? "- [x]" : "- [ ]"} ${c.title}`);
    }
  }
  return lines.join("\n");
}

/** A project with its headings and open to-dos, as text. */
export function projectAsText(p: Task): string {
  const snap = useStore.getState().view;
  const children = (snap?.tasks ?? []).filter((t) => t.projectId === p.id && t.id !== p.id && !t.trashed && t.status === "open").sort((a, b) => a.index - b.index);
  const parts = [tasksAsText(children.filter((t) => t.type === "task" && !t.headingId), p.title || "Untitled Project")];
  if (p.notes.trim()) parts.splice(1, 0, p.notes.trim());
  for (const h of children.filter((t) => t.type === "heading")) {
    parts.push(tasksAsText(children.filter((t) => t.headingId === h.id), `${h.title}:`));
  }
  return parts.join("\n\n");
}

/** Opens the system share sheet when there is one; otherwise copies the text. */
export async function shareText(title: string, text: string) {
  const nav = navigator as Navigator & { share?: (d: { title?: string; text?: string }) => Promise<void> };
  if (typeof nav.share === "function") {
    try {
      await nav.share({ title, text });
      return;
    } catch (e) {
      if ((e as DOMException)?.name === "AbortError") return;
    }
  }
  await copyText(text, "Copied to the clipboard");
}

/** Things' Paste: each line on the clipboard becomes a to-do in the current list. */
export async function pasteAsTodos(sel: Selection) {
  const s = useStore.getState();
  let text = "";
  try {
    text = await navigator.clipboard.readText();
  } catch {
    s.toast("Couldn't read the clipboard.", "error");
    return;
  }
  const titles = text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*•]\s*)?(?:\[[ xX]\]\s*)?/, "").trim())
    .filter(Boolean)
    .slice(0, 100);
  if (!titles.length) {
    s.toast("There's no text on the clipboard to paste.", "info");
    return;
  }
  const defaults = newTaskDefaults(sel);
  const created: string[] = [];
  // New to-dos go to the top, so add the last line first to keep the clipboard's order.
  for (const title of [...titles].reverse()) {
    const r = await apply({ type: "createTask", ...defaults, title });
    if (!r) break;
    if (r.created[0]) created.unshift(r.created[0]);
  }
  if (created.length) {
    s.setSelected(created);
    s.toast(`Pasted ${plural(created.length)}`, "success");
  }
}
