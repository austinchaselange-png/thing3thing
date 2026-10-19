// Drag and drop inside lists, like Things: drop a to-do between others to
// reorder it, into another heading, into This Evening, onto another day in
// Upcoming, or into a project/area group in Anytime and Someday.
import { bulkMove, bulkSchedule } from "./actions";
import type { Group } from "./lib/lists";
import { orderChanges, placeAt } from "./lib/order";
import { useStore } from "./store";
import type { Selection, Task } from "./types";

export const TASK_MIME = "application/x-tings3-task";
export const HEADING_MIME = "application/x-tings3-heading";

/** What is being dragged. dataTransfer can't be read during dragover, so it lives here. */
export const drag: { ids: string[]; kind: "task" | "heading" | "project" | "area" | "plus" | null } = { ids: [], kind: null };
export const PLUS_MIME = "application/x-tings3-plus";

export function startDrag(kind: NonNullable<typeof drag.kind>, ids: string[], e: React.DragEvent, mime = TASK_MIME) {
  drag.kind = kind;
  drag.ids = ids;
  e.dataTransfer.setData(mime, ids.join("\n"));
  e.dataTransfer.effectAllowed = "move";
}

export function endDrag() {
  drag.kind = null;
  drag.ids = [];
}

const view = () => useStore.getState().view;
const byId = (ids: string[]) => {
  const map = new Map((view()?.tasks ?? []).map((t) => [t.id, t]));
  return ids.map((id) => map.get(id)).filter((t): t is Task => !!t);
};

/** Whether `group` in this view accepts these items at all. */
export function canDropInto(sel: Selection, group: Group, tasks: Task[]): boolean {
  if (!tasks.length || !useStore.getState().canWrite()) return false;
  if (sel.kind === "list" && (sel.id === "logbook" || sel.id === "trash")) return false;
  if (group.key === "done") return false;
  if (sel.kind === "area" && group.key === "projects") return tasks.every((t) => t.type === "project");
  if (sel.kind === "list" && sel.id === "upcoming" && !/^\d{4}-\d{2}-\d{2}$/.test(group.key)) {
    // Month groups: only reorder within the same month.
    return tasks.every((t) => group.tasks.some((g) => g.id === t.id));
  }
  return tasks.every((t) => t.type !== "heading");
}

/** Drops `ids` into `group` at `index` (a position in group.tasks). */
export async function dropTasks(sel: Selection, group: Group, index: number, ids: string[]) {
  let tasks = byId(ids);
  if (!canDropInto(sel, group, tasks)) return;

  // 1. Change container or schedule when the group means something different.
  const outside = tasks.filter((t) => !group.tasks.some((g) => g.id === t.id));
  if (outside.length) {
    if (sel.kind === "project") {
      const heading = group.key === "none" ? null : group.key;
      await bulkMove(outside, heading ? { headingId: heading } : { projectId: sel.id });
    } else if (sel.kind === "list" && sel.id === "today") {
      await bulkSchedule(outside, group.key === "evening" ? { kind: "evening" } : { kind: "today" });
    } else if (sel.kind === "list" && sel.id === "upcoming" && /^\d{4}-\d{2}-\d{2}$/.test(group.key)) {
      await bulkSchedule(outside, { kind: "date", date: group.key });
    } else if (sel.kind === "area") {
      if (group.key === "someday") await bulkSchedule(outside, { kind: "someday" });
      else if (group.key === "tasks") await bulkSchedule(outside, { kind: "anytime" });
    } else if (group.link?.kind === "project") {
      await bulkMove(outside, { projectId: group.link.id });
    } else if (group.link?.kind === "area") {
      await bulkMove(outside, { areaId: group.link.id });
    } else if (group.key === "loose") {
      await bulkMove(outside.filter((t) => t.projectId || t.areaId || t.headingId), {});
    }
  }

  // 2. Order within the group.
  tasks = byId(ids);
  const key = sel.kind === "list" && sel.id === "today" ? "todayIndex" : "index";
  const fresh = new Map((view()?.tasks ?? []).map((t) => [t.id, t]));
  const order = placeAt(
    group.tasks.map((t) => t.id),
    tasks.map((t) => t.id),
    index,
  );
  const desired = order.map((id) => fresh.get(id)).filter((t): t is Task => !!t).map((t) => ({ id: t.id, value: t[key] }));
  const changes = orderChanges(desired, new Set(tasks.map((t) => t.id)));
  if (changes.length) await useStore.getState().apply({ type: "reorder", key, items: changes });
}

/** Reorders headings within a project. */
export async function dropHeadings(projectId: string, headingIds: string[], beforeId: string | null) {
  const headings = (view()?.tasks ?? []).filter((t) => t.type === "heading" && t.projectId === projectId && !t.trashed && t.status === "open").sort((a, b) => a.index - b.index);
  const list = headings.map((h) => h.id);
  const index = beforeId ? list.indexOf(beforeId) : list.length;
  const order = placeAt(list, headingIds, index < 0 ? list.length : index);
  const map = new Map(headings.map((h) => [h.id, h]));
  const changes = orderChanges(
    order.map((id) => ({ id, value: map.get(id)!.index })),
    new Set(headingIds),
  );
  if (changes.length) await useStore.getState().apply({ type: "reorder", key: "index", items: changes });
}

/** Sidebar: reorders projects within the same area (or loose projects), or areas. */
export async function reorderSidebar(kind: "project" | "area", ids: string[], siblings: { id: string; index: number }[], beforeId: string | null) {
  const list = siblings.map((s) => s.id);
  const index = beforeId ? list.indexOf(beforeId) : list.length;
  const order = placeAt(list, ids, index < 0 ? list.length : index);
  const map = new Map(siblings.map((s) => [s.id, s.index]));
  const changes = orderChanges(
    order.filter((id) => map.has(id)).map((id) => ({ id, value: map.get(id)! })),
    new Set(ids),
  );
  if (changes.length) await useStore.getState().apply({ type: "reorder", key: "index", items: changes });
  void kind;
}

/** Ctrl+↑/↓ and Ctrl+Alt+↑/↓: moves the selection one step, or to the top/bottom of its group. */
export async function nudge(sel: Selection, groups: Group[], ids: string[], dir: "up" | "down" | "top" | "bottom") {
  const group = groups.find((g) => ids.some((id) => g.tasks.some((t) => t.id === id)));
  if (!group) return;
  const list = group.tasks.map((t) => t.id);
  const inGroup = list.filter((id) => ids.includes(id));
  if (!inGroup.length) return;
  const first = list.indexOf(inGroup[0]);
  const last = list.indexOf(inGroup[inGroup.length - 1]);
  const index = dir === "top" ? 0 : dir === "bottom" ? list.length : dir === "up" ? Math.max(0, first - 1) : Math.min(list.length, last + 2);
  if ((dir === "up" || dir === "top") && first === 0) return;
  if ((dir === "down" || dir === "bottom") && last === list.length - 1) return;
  await dropTasks(sel, group, index, inGroup);
}
