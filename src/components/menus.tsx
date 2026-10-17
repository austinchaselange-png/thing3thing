// Right-click menu definitions for every kind of item in the app.
import { copyText, duplicate, moveTo, promptRename, renameTask, reveal, schedule, setStatus, trash, whenOf } from "../actions";
import { addDays, relativeLabel, todayYmd, weekdayName } from "../lib/dates";
import { useStore, type MenuItem } from "../store";
import type { Area, ChecklistItem, ListId, Selection, Tag, Task, When } from "../types";
import {
  AreaIcon,
  ArrowRightIcon,
  BoxIcon,
  CalendarIcon,
  CancelIcon,
  CheckIcon,
  ClipboardIcon,
  CopyIcon,
  FlagIcon,
  HeadingIcon,
  InboxIcon,
  LayersIcon,
  MoonIcon,
  OpenIcon,
  PencilIcon,
  PlusIcon,
  ProgressPie,
  StarIcon,
  TagIcon,
  TrashIcon,
  UndoIcon,
} from "./Icons";

const SEP: MenuItem = { separator: true };
const store = () => useStore.getState();

/** Adds the read-only reason to write actions when changes are turned off. */
function guard(items: MenuItem[]): MenuItem[] {
  const app = store().app;
  if (app?.canWrite) return items;
  const hint =
    app && app.policy.writes && !app.format.writesSupported
      ? "This account's data format can't be written yet"
      : "Read-only — enable writing in Settings → Sync";
  return items.map((i) => (i.separator || !("write" in i) ? i : { ...i, disabled: true, hint }));
}

type W = MenuItem & { write?: true };
const w = (item: Exclude<MenuItem, { separator: true }>): W => ({ ...item, write: true }) as W;

function anchorFor(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(id)}"]`);
}

function whenItems(t: Task): MenuItem[] {
  const today = todayYmd();
  const current = whenOf(t);
  const is = (k: When["kind"]) => current.kind === k;
  const tomorrow = addDays(today, 1);
  const weekend = addDays(today, (6 - new Date().getDay() + 7) % 7 || 7);
  const nextWeek = addDays(today, (8 - new Date().getDay()) % 7 || 7);
  const go = (when: When) => () => void schedule(t, when);
  return [
    w({ label: "Today", icon: <StarIcon style={{ color: "var(--c-today)" }} />, shortcut: "Ctrl+T", checked: is("today") || undefined, onSelect: go({ kind: "today" }) }),
    w({ label: "This Evening", icon: <MoonIcon style={{ color: "var(--c-evening)" }} />, shortcut: "Ctrl+E", checked: is("evening") || undefined, onSelect: go({ kind: "evening" }) }),
    w({ label: `Tomorrow`, icon: <CalendarIcon style={{ color: "var(--c-upcoming)" }} />, checked: current.kind === "date" && current.date === tomorrow ? true : undefined, onSelect: go({ kind: "date", date: tomorrow }) }),
    w({ label: `This Weekend (${weekdayName(weekend, true)})`, icon: <CalendarIcon style={{ color: "var(--c-upcoming)" }} />, onSelect: go({ kind: "date", date: weekend }) }),
    w({ label: `Next Week (${relativeLabel(nextWeek, today)})`, icon: <CalendarIcon style={{ color: "var(--c-upcoming)" }} />, onSelect: go({ kind: "date", date: nextWeek }) }),
    SEP,
    w({ label: "Anytime", icon: <LayersIcon style={{ color: "var(--c-anytime)" }} />, shortcut: "Ctrl+R", checked: is("anytime") || undefined, onSelect: go({ kind: "anytime" }) }),
    w({ label: "Someday", icon: <BoxIcon style={{ color: "var(--c-someday)" }} />, shortcut: "Ctrl+O", checked: is("someday") || undefined, onSelect: go({ kind: "someday" }) }),
    ...(t.type === "task" && !t.areaId && !t.projectId && !t.headingId
      ? [w({ label: "Inbox", icon: <InboxIcon style={{ color: "var(--c-inbox)" }} />, checked: is("inbox") || undefined, onSelect: go({ kind: "inbox" }) })]
      : []),
    SEP,
    w({ label: "Choose Date…", icon: <CalendarIcon />, shortcut: "Ctrl+S", onSelect: () => store().openPicker({ kind: "when", taskId: t.id, anchor: anchorFor(t.id) }) }),
  ];
}

export function taskMenu(t: Task): MenuItem[] {
  const s = store();
  const open = t.status === "open";
  const isProject = t.type === "project";
  const items: W[] = [];
  if (isProject) {
    items.push({ label: "Open Project", icon: <OpenIcon />, shortcut: "Enter", onSelect: () => s.select({ kind: "project", id: t.id }) });
  } else if (!t.trashed) {
    items.push({ label: "Edit", icon: <PencilIcon />, shortcut: "Enter", onSelect: () => (s.selectTask(t.id), s.edit(t.id)) });
  }
  if (t.trashed) {
    items.push(w({ label: "Put Back", icon: <UndoIcon />, onSelect: () => void trash(t, false) }));
    items.push(SEP as W, { label: "Show in Trash", icon: <TrashIcon />, onSelect: () => reveal(t) });
    return guard(items);
  }
  items.push(SEP as W);
  items.push(
    open
      ? w({ label: isProject ? "Complete Project" : "Complete", icon: <CheckIcon />, shortcut: "Ctrl+K", onSelect: () => void setStatus(t, "completed") })
      : w({ label: "Mark as Open", icon: <UndoIcon />, shortcut: "Ctrl+K", onSelect: () => void setStatus(t, "open") }),
  );
  if (open) items.push(w({ label: isProject ? "Cancel Project" : "Cancel", icon: <CancelIcon />, onSelect: () => void setStatus(t, "canceled") }));
  items.push(SEP as W);
  if (open) items.push(w({ label: "When", icon: <CalendarIcon />, submenu: guard(whenItems(t)) }));
  items.push(
    w({ label: t.deadline ? "Change Deadline…" : "Add Deadline…", icon: <FlagIcon />, shortcut: "Ctrl+Shift+D", onSelect: () => s.openPicker({ kind: "deadline", taskId: t.id, anchor: anchorFor(t.id) }) }),
  );
  if (t.deadline) items.push(w({ label: "Remove Deadline", icon: <FlagIcon />, onSelect: () => void s.apply({ type: "updateTask", id: t.id, baseRev: t.rev, deadline: null }) }));
  items.push(w({ label: "Tags…", icon: <TagIcon />, shortcut: "Ctrl+Shift+T", onSelect: () => s.openPicker({ kind: "tags", taskId: t.id, anchor: anchorFor(t.id) }) }));
  items.push(w({ label: "Move…", icon: <ArrowRightIcon />, shortcut: "Ctrl+Shift+M", onSelect: () => s.openPicker({ kind: "move", taskId: t.id, anchor: anchorFor(t.id) }) }));
  if (!isProject && (t.projectId || t.areaId || t.headingId)) {
    items.push(w({ label: "Remove from Project/Area", icon: <LayersIcon />, onSelect: () => void moveTo(t, {}) }));
  }
  items.push(SEP as W);
  if (isProject) items.push(w({ label: "Rename…", icon: <PencilIcon />, onSelect: () => renameTask(t) }));
  if (!isProject) items.push(w({ label: "Duplicate", icon: <CopyIcon />, shortcut: "Ctrl+D", onSelect: () => void duplicate(t) }));
  items.push({ label: "Copy Title", icon: <ClipboardIcon />, onSelect: () => void copyText(t.title, "Title copied") });
  if (s.selection.kind !== "project" || s.selection.id !== (t.projectId ?? t.id)) {
    items.push({ label: isProject ? "Show Project" : "Show in List", icon: <OpenIcon />, onSelect: () => reveal(t) });
  }
  items.push(SEP as W);
  items.push(w({ label: "Move to Trash", icon: <TrashIcon />, shortcut: "Del", danger: true, onSelect: () => void trash(t) }));
  return guard(items);
}

export function headingMenu(h: Task): MenuItem[] {
  return guard([
    w({ label: "New To-Do in Heading", icon: <PlusIcon />, onSelect: () => window.dispatchEvent(new CustomEvent("tings3:new-task", { detail: { section: h.id } })) }),
    w({ label: "Rename Heading…", icon: <PencilIcon />, onSelect: () => renameTask(h) }),
    SEP,
    w({ label: "Archive Heading", icon: <CheckIcon />, hint: "Completes the heading and its to-dos", onSelect: () => void archiveHeading(h) }),
    SEP,
    w({ label: "Move to Trash", icon: <TrashIcon />, danger: true, onSelect: () => void trash(h) }),
  ]);
}

async function archiveHeading(h: Task) {
  const s = store();
  const children = (s.view?.tasks ?? []).filter((t) => t.headingId === h.id && t.status === "open" && !t.trashed);
  for (const c of children) await setStatus(c, "completed");
  await setStatus(store().view?.tasks.find((t) => t.id === h.id) ?? h, "completed");
}

export function areaMenu(a: Area): MenuItem[] {
  const s = store();
  const contents = (s.view?.tasks ?? []).filter((t) => t.areaId === a.id && !t.trashed).length;
  return guard([
    { label: "Open Area", icon: <OpenIcon />, onSelect: () => s.select({ kind: "area", id: a.id }) },
    SEP,
    w({
      label: "New Project in Area…",
      icon: <ProgressPie done={0} total={1} size={14} color="var(--c-project)" />,
      onSelect: () =>
        s.openDialog({
          kind: "prompt",
          title: `New Project in ${a.title}`,
          label: "Name",
          initial: "",
          confirmLabel: "Create",
          onSubmit: async (title) => {
            const r = await s.apply({ type: "createTask", kind: "project", title, areaId: a.id, when: { kind: "anytime" } });
            if (r?.created[0]) store().select({ kind: "project", id: r.created[0] });
          },
        }),
    }),
    w({ label: "New To-Do in Area", icon: <PlusIcon />, onSelect: () => (s.select({ kind: "area", id: a.id }), setTimeout(() => window.dispatchEvent(new Event("tings3:new-task")), 0)) }),
    SEP,
    w({ label: "Rename…", icon: <PencilIcon />, onSelect: () => promptRename("Rename Area", a.title, (title) => void s.apply({ type: "renameArea", id: a.id, baseRev: a.rev, title })) }),
    SEP,
    w({
      label: "Delete Area…",
      icon: <TrashIcon />,
      danger: true,
      disabled: contents > 0 || !s.app?.policy.destructive,
      hint: contents > 0 ? `Move or trash its ${contents} item(s) first` : !s.app?.policy.destructive ? "Enable permanent deletions in Settings → Sync" : undefined,
      onSelect: () =>
        s.openDialog({
          kind: "confirm",
          title: `Delete “${a.title}”?`,
          body: "The area is deleted permanently, here and on your iPhone. This can't be undone.",
          mutation: { type: "deleteArea", id: a.id, confirm: "" },
          phrase: true,
        }),
    }),
  ]);
}

export function tagMenu(t: Tag): MenuItem[] {
  const s = store();
  return guard([
    { label: "Show To-Dos with Tag", icon: <TagIcon />, onSelect: () => s.select({ kind: "tag", id: t.id }) },
    SEP,
    w({ label: "Rename…", icon: <PencilIcon />, onSelect: () => promptRename("Rename Tag", t.title, (title) => void s.apply({ type: "renameTag", id: t.id, baseRev: t.rev, title })) }),
    w({
      label: "Delete Tag…",
      icon: <TrashIcon />,
      danger: true,
      disabled: !s.app?.policy.destructive,
      hint: !s.app?.policy.destructive ? "Enable permanent deletions in Settings → Sync" : undefined,
      onSelect: () =>
        s.openDialog({
          kind: "confirm",
          title: `Delete tag “${t.title}”?`,
          body: "The tag is removed permanently from Things, here and on your iPhone. To-dos keep everything else.",
          mutation: { type: "deleteTag", id: t.id, confirm: "" },
          phrase: true,
        }),
    }),
  ]);
}

export function checklistMenu(c: ChecklistItem): MenuItem[] {
  const s = store();
  return guard([
    w({
      label: c.completed ? "Mark as Open" : "Complete",
      icon: c.completed ? <UndoIcon /> : <CheckIcon />,
      onSelect: () => void s.apply({ type: "updateChecklistItem", id: c.id, baseRev: c.rev, completed: !c.completed }),
    }),
    { label: "Copy Text", icon: <ClipboardIcon />, onSelect: () => void copyText(c.title) },
    SEP,
    w({
      label: "Delete Item",
      icon: <TrashIcon />,
      danger: true,
      disabled: !s.app?.policy.destructive,
      hint: !s.app?.policy.destructive ? "Enable permanent deletions in Settings → Sync" : undefined,
      onSelect: () => void s.apply({ type: "deleteChecklistItem", id: c.id }),
    }),
  ]);
}

/** "New …" entries for the current place: the blue button and empty space. */
export function newItemsMenu(sel: Selection): MenuItem[] {
  const s = store();
  const items: W[] = [w({ label: "New To-Do", icon: <PlusIcon />, shortcut: "Ctrl+N", onSelect: () => window.dispatchEvent(new Event("tings3:new-task")) })];
  if (sel.kind === "project") {
    items.push(w({ label: "New Heading", icon: <HeadingIcon />, onSelect: () => s.openPicker({ kind: "heading", taskId: null, anchor: document.querySelector<HTMLElement>(".add-bubble"), projectId: sel.id }) }));
  }
  items.push(SEP as W);
  items.push(
    w({
      label: "New Project…",
      icon: <ProgressPie done={0} total={1} size={14} color="var(--c-project)" />,
      onSelect: () =>
        s.openDialog({
          kind: "prompt",
          title: "New Project",
          label: "Name",
          initial: "",
          confirmLabel: "Create",
          onSubmit: async (title) => {
            const r = await s.apply({ type: "createTask", kind: "project", title, when: { kind: "anytime" }, areaId: sel.kind === "area" ? sel.id : null });
            if (r?.created[0]) store().select({ kind: "project", id: r.created[0] });
          },
        }),
    }),
    w({
      label: "New Area…",
      icon: <AreaIcon style={{ color: "var(--c-area)" }} />,
      onSelect: () =>
        s.openDialog({
          kind: "prompt",
          title: "New Area",
          label: "Name",
          initial: "",
          confirmLabel: "Create",
          onSubmit: async (title) => {
            const r = await s.apply({ type: "createArea", title });
            if (r?.created[0]) store().select({ kind: "area", id: r.created[0] });
          },
        }),
    }),
  );
  items.push(SEP as W, { label: "Keyboard Shortcuts", icon: <ClipboardIcon />, shortcut: "Ctrl+/", onSelect: () => s.openDialog({ kind: "shortcuts" }) });
  return guard(items);
}

export function listMenu(id: ListId): MenuItem[] {
  const s = store();
  const items: MenuItem[] = [{ label: "Open", icon: <OpenIcon />, onSelect: () => s.select({ kind: "list", id }) }];
  if (id !== "logbook" && id !== "trash") {
    items.push(w({ label: "New To-Do Here", icon: <PlusIcon />, onSelect: () => (s.select({ kind: "list", id }), setTimeout(() => window.dispatchEvent(new Event("tings3:new-task")), 0)) }));
  }
  if (id === "trash") {
    const n = (s.view?.tasks ?? []).filter((t) => t.trashed && t.type !== "heading").length;
    items.push(SEP, {
      label: "Empty Trash",
      icon: <TrashIcon />,
      disabled: true,
      hint: n ? "Permanently deleting to-dos isn't supported yet — empty the Trash in Things on your iPhone" : "The Trash is empty",
    });
  }
  return guard(items);
}
