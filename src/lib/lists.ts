// Things 3 list semantics, computed from the snapshot. See ARCHITECTURE.md.
import type { Area, ListId, Selection, Snapshot, Task } from "../types";
import { addDays, daysBetween, monthName, parseYmd, relativeLabel, weekdayName } from "./dates";

export interface Index {
  byId: Map<string, Task>;
  areas: Map<string, Area>;
  checklistByTask: Map<string, Snapshot["checklist"]>;
}

export function buildIndex(s: Snapshot): Index {
  const byId = new Map(s.tasks.map((t) => [t.id, t]));
  const areas = new Map(s.areas.map((a) => [a.id, a]));
  const checklistByTask = new Map<string, Snapshot["checklist"]>();
  for (const c of s.checklist) {
    const list = checklistByTask.get(c.taskId) ?? [];
    list.push(c);
    checklistByTask.set(c.taskId, list);
  }
  for (const list of checklistByTask.values()) list.sort((a, b) => a.index - b.index);
  return { byId, areas, checklistByTask };
}

/** Area of a task, directly or through its project. */
export function areaOf(t: Task, ix: Index): string | null {
  if (t.areaId) return t.areaId;
  if (t.projectId) return ix.byId.get(t.projectId)?.areaId ?? null;
  return null;
}

/** False when the task or any container is finished or trashed. */
export function isLive(t: Task, ix: Index): boolean {
  if (t.trashed || t.status !== "open") return false;
  for (const parentId of [t.headingId, t.projectId]) {
    if (!parentId) continue;
    const p = ix.byId.get(parentId);
    if (p && (p.trashed || p.status !== "open")) return false;
  }
  return true;
}

function inSomedayProject(t: Task, ix: Index): boolean {
  const p = t.projectId ? ix.byId.get(t.projectId) : undefined;
  return !!p && p.start === "someday" && !p.startDate;
}

export function isToday(t: Task, today: string): boolean {
  return t.start !== "inbox" && !!t.startDate && t.startDate <= today;
}

export function belongsTo(list: ListId, t: Task, ix: Index, today: string): boolean {
  const live = isLive(t, ix);
  const actionable = t.type !== "heading";
  switch (list) {
    case "inbox":
      return live && actionable && t.start === "inbox";
    case "today":
      return live && actionable && isToday(t, today);
    case "upcoming":
      return live && actionable && !!t.startDate && t.startDate > today;
    case "anytime":
      return live && actionable && t.type === "task" && t.start === "anytime" && !(t.startDate && t.startDate > today) && !inSomedayProject(t, ix);
    case "someday":
      return live && actionable && t.start === "someday" && !t.startDate;
    case "logbook":
      return !t.trashed && t.status !== "open" && t.type !== "heading";
    case "trash":
      return t.trashed && t.type !== "heading";
  }
}

export function countFor(list: ListId, s: Snapshot, ix: Index, today: string): number {
  return s.tasks.filter((t) => t.type === "task" && belongsTo(list, t, ix, today)).length;
}

export interface Group {
  key: string;
  title: string | null;
  subtitle?: string;
  /** Project/area the group header links to. */
  link?: Selection;
  tasks: Task[];
}

const byIndex = (a: Task, b: Task) => a.index - b.index || a.id.localeCompare(b.id);
const byTodayIndex = (a: Task, b: Task) => a.todayIndex - b.todayIndex || byIndex(a, b);

/** Groups tasks by project, then area, then loose — the Anytime/Someday layout. */
function groupByContainer(tasks: Task[], ix: Index): Group[] {
  const loose: Task[] = [];
  const groups = new Map<string, Group>();
  for (const t of tasks) {
    const projectId = t.type === "task" ? t.projectId : null;
    const areaId = areaOf(t, ix);
    if (projectId) {
      const p = ix.byId.get(projectId);
      const g = groups.get(projectId) ?? { key: projectId, title: p?.title || "Untitled Project", link: { kind: "project", id: projectId }, tasks: [] };
      g.tasks.push(t);
      groups.set(projectId, g);
    } else if (areaId) {
      const a = ix.areas.get(areaId);
      const g = groups.get(areaId) ?? { key: areaId, title: a?.title || "Untitled Area", link: { kind: "area", id: areaId }, tasks: [] };
      g.tasks.push(t);
      groups.set(areaId, g);
    } else {
      loose.push(t);
    }
  }
  const out: Group[] = [];
  if (loose.length) out.push({ key: "loose", title: null, tasks: loose.sort(byIndex) });
  for (const g of groups.values()) out.push({ ...g, tasks: g.tasks.sort(byIndex) });
  return out;
}

export function groupsFor(sel: Selection, s: Snapshot, ix: Index, today: string): Group[] {
  const tasks = s.tasks;
  if (sel.kind === "list") {
    const items = tasks.filter((t) => belongsTo(sel.id, t, ix, today));
    switch (sel.id) {
      case "inbox":
        return [{ key: "inbox", title: null, tasks: items.sort(byIndex) }];
      case "today": {
        const day = items.filter((t) => !t.evening).sort(byTodayIndex);
        const evening = items.filter((t) => t.evening).sort(byTodayIndex);
        const out: Group[] = [{ key: "today", title: null, tasks: day }];
        if (evening.length) out.push({ key: "evening", title: "This Evening", tasks: evening });
        return out;
      }
      case "upcoming":
        return upcomingGroups(items, today);
      case "anytime":
      case "someday":
        return groupByContainer(items, ix);
      case "logbook":
        return logbookGroups(items, today);
      case "trash":
        return [{ key: "trash", title: null, tasks: items.sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0)) }];
    }
  }
  if (sel.kind === "project") {
    const children = tasks.filter((t) => t.projectId === sel.id && t.id !== sel.id && !t.trashed);
    const headings = children.filter((t) => t.type === "heading" && t.status === "open").sort(byIndex);
    const open = children.filter((t) => t.type === "task" && t.status === "open");
    const out: Group[] = [{ key: "none", title: null, tasks: open.filter((t) => !t.headingId || !headings.some((h) => h.id === t.headingId)).sort(byIndex) }];
    for (const h of headings) out.push({ key: h.id, title: h.title, tasks: open.filter((t) => t.headingId === h.id).sort(byIndex) });
    const done = children.filter((t) => t.type === "task" && t.status !== "open").sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
    if (done.length) out.push({ key: "done", title: "Completed", tasks: done });
    return out;
  }
  if (sel.kind === "area") {
    const live = tasks.filter((t) => t.areaId === sel.id && isLive(t, ix) && t.type !== "heading" && !(t.start === "someday" && !t.startDate && t.type === "task"));
    const projects = live.filter((t) => t.type === "project").sort(byIndex);
    const loose = live.filter((t) => t.type === "task").sort(byIndex);
    const out: Group[] = [];
    if (projects.length) out.push({ key: "projects", title: null, tasks: projects });
    out.push({ key: "tasks", title: projects.length ? "To-Dos" : null, tasks: loose });
    const someday = tasks.filter((t) => t.areaId === sel.id && isLive(t, ix) && t.type === "task" && t.start === "someday" && !t.startDate);
    if (someday.length) out.push({ key: "someday", title: "Someday", tasks: someday.sort(byIndex) });
    return out;
  }
  // Tag: every live to-do with this tag (or a child tag).
  const tagIds = new Set([sel.id, ...s.tags.filter((t) => t.parentId === sel.id).map((t) => t.id)]);
  const items = tasks.filter((t) => isLive(t, ix) && t.type !== "heading" && t.tagIds.some((id) => tagIds.has(id)));
  return groupByContainer(items, ix);
}

function upcomingGroups(items: Task[], today: string): Group[] {
  const sorted = [...items].sort((a, b) => (a.startDate! < b.startDate! ? -1 : a.startDate! > b.startDate! ? 1 : byIndex(a, b)));
  const out: Group[] = [];
  // Next seven days get their own section each, like Things.
  for (let i = 1; i <= 7; i++) {
    const d = addDays(today, i);
    const dayTasks = sorted.filter((t) => t.startDate === d);
    out.push({ key: d, title: String(parseYmd(d).getDate()), subtitle: i === 1 ? "Tomorrow" : weekdayName(d), tasks: dayTasks });
  }
  const later = sorted.filter((t) => daysBetween(today, t.startDate!) > 7);
  const months = new Map<string, Task[]>();
  for (const t of later) {
    const d = parseYmd(t.startDate!);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    months.set(key, [...(months.get(key) ?? []), t]);
  }
  const thisYear = parseYmd(today).getFullYear();
  for (const [key, ts] of months) {
    const [y, m] = key.split("-").map(Number);
    out.push({ key, title: y === thisYear ? monthName(m) : `${monthName(m)} ${y}`, tasks: ts });
  }
  return out;
}

function logbookGroups(items: Task[], today: string): Group[] {
  const sorted = [...items].sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
  const groups = new Map<string, Task[]>();
  for (const t of sorted) {
    const d = t.completedAt ? new Date(t.completedAt) : null;
    const key = d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` : "unknown";
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  return [...groups].map(([key, tasks]) => ({ key, title: key === "unknown" ? "Earlier" : relativeLabel(key, today), tasks }));
}

/** Open/total counts for a project's progress pie. */
export function projectProgress(projectId: string, s: Snapshot): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const t of s.tasks) {
    if (t.projectId !== projectId || t.type !== "task" || t.trashed || t.id === projectId) continue;
    total++;
    if (t.status !== "open") done++;
  }
  return { done, total };
}

/** Sidebar structure: areas with their open projects, and projects without an area. */
export function sidebarTree(s: Snapshot, ix: Index): { looseProjects: Task[]; areas: { area: Area; projects: Task[] }[] } {
  const projects = s.tasks.filter((t) => t.type === "project" && isLive(t, ix)).sort(byIndex);
  return {
    looseProjects: projects.filter((p) => !p.areaId || !ix.areas.has(p.areaId)),
    areas: [...s.areas].sort((a, b) => a.index - b.index).map((area) => ({ area, projects: projects.filter((p) => p.areaId === area.id) })),
  };
}

export function search(query: string, s: Snapshot, ix: Index): Task[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return s.tasks
    .filter((t) => !t.trashed && t.type !== "heading" && (t.title.toLowerCase().includes(q) || t.notes.toLowerCase().includes(q)))
    .sort((a, b) => Number(isLive(b, ix)) - Number(isLive(a, ix)) || Number(b.title.toLowerCase().startsWith(q)) - Number(a.title.toLowerCase().startsWith(q)))
    .slice(0, 50);
}

// ---------------- Logbook search and filters ----------------

export type LogPeriod = "all" | "today" | "yesterday" | "week" | "lastWeek" | "7d" | "30d" | "month" | "year" | "custom";

export interface LogbookFilter {
  query: string;
  period: LogPeriod;
  /** Custom range, inclusive "YYYY-MM-DD" (either end may be open). */
  from: string | null;
  to: string | null;
  status: "all" | "completed" | "canceled";
  kind: "all" | "task" | "project";
  /** Only items in this project or area. */
  container: string | null;
}

export const EMPTY_LOGBOOK_FILTER: LogbookFilter = { query: "", period: "all", from: null, to: null, status: "all", kind: "all", container: null };

export function isLogbookFiltered(f: LogbookFilter): boolean {
  return !!f.query.trim() || f.period !== "all" || f.status !== "all" || f.kind !== "all" || !!f.container;
}

/** Inclusive date range for a period; weeks start on Monday. */
export function periodRange(f: Pick<LogbookFilter, "period" | "from" | "to">, today: string): { from: string | null; to: string | null } {
  const d = parseYmd(today);
  const monday = addDays(today, -((d.getDay() + 6) % 7));
  switch (f.period) {
    case "all":
      return { from: null, to: null };
    case "today":
      return { from: today, to: today };
    case "yesterday":
      return { from: addDays(today, -1), to: addDays(today, -1) };
    case "week":
      return { from: monday, to: today };
    case "lastWeek":
      return { from: addDays(monday, -7), to: addDays(monday, -1) };
    case "7d":
      return { from: addDays(today, -6), to: today };
    case "30d":
      return { from: addDays(today, -29), to: today };
    case "month":
      return { from: `${today.slice(0, 7)}-01`, to: today };
    case "year":
      return { from: `${today.slice(0, 4)}-01-01`, to: today };
    case "custom": {
      const [a, b] = [f.from, f.to];
      return a && b && a > b ? { from: b, to: a } : { from: a, to: b };
    }
  }
}

function completedDay(t: Task): string | null {
  if (!t.completedAt) return null;
  const d = new Date(t.completedAt);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Returns a predicate for Logbook items. Search looks at the title, notes,
 * checklist items, and the names of the project, area and tags.
 */
export function logbookMatcher(f: LogbookFilter, s: Snapshot, ix: Index, today: string): (t: Task) => boolean {
  const range = periodRange(f, today);
  const words = f.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const tagNames = new Map(s.tags.map((t) => [t.id, t.title.toLowerCase()]));
  const haystack = (t: Task) => {
    const project = t.projectId ? ix.byId.get(t.projectId)?.title : "";
    const areaId = areaOf(t, ix);
    const area = areaId ? ix.areas.get(areaId)?.title : "";
    const checklist = (ix.checklistByTask.get(t.id) ?? []).map((c) => c.title).join(" ");
    const tags = t.tagIds.map((id) => tagNames.get(id) ?? "").join(" ");
    return `${t.title} ${t.notes} ${checklist} ${project ?? ""} ${area ?? ""} ${tags}`.toLowerCase();
  };
  return (t) => {
    if (f.status !== "all" && t.status !== f.status) return false;
    if (f.kind !== "all" && t.type !== f.kind) return false;
    if (f.container && !(t.id === f.container || t.projectId === f.container || areaOf(t, ix) === f.container)) return false;
    if (range.from || range.to) {
      const day = completedDay(t);
      if (!day) return false;
      if (range.from && day < range.from) return false;
      if (range.to && day > range.to) return false;
    }
    if (words.length) {
      const h = haystack(t);
      if (!words.every((w) => h.includes(w))) return false;
    }
    return true;
  };
}

export interface LogbookStats {
  completed: number;
  canceled: number;
  projects: number;
  /** Distinct days with something logged. */
  days: number;
  /** Most items logged in one day. */
  best: { day: string; count: number } | null;
}

export function logbookStats(items: Task[]): LogbookStats {
  const perDay = new Map<string, number>();
  let completed = 0;
  let canceled = 0;
  let projects = 0;
  for (const t of items) {
    if (t.type === "project") projects++;
    else if (t.status === "canceled") canceled++;
    else completed++;
    const d = completedDay(t);
    if (d) perDay.set(d, (perDay.get(d) ?? 0) + 1);
  }
  let best: LogbookStats["best"] = null;
  for (const [day, count] of perDay) if (!best || count > best.count) best = { day, count };
  return { completed, canceled, projects, days: perDay.size, best };
}
