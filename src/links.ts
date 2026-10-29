// things:/// links, compatible with Things' URL scheme on Mac and iPhone:
//   things:///add?title=…&notes=…&when=today|tomorrow|evening|anytime|someday|YYYY-MM-DD
//                &deadline=YYYY-MM-DD&tags=A,B&list=Project or Area&heading=…
//                &checklist-items=a%0Ab&titles=a%0Ab&show-quick-entry=true&reveal=true
//   things:///add-project?title=…&area=…&notes=…&when=…&deadline=…&to-dos=a%0Ab
//   things:///show?id=inbox|today|upcoming|anytime|someday|logbook|trash|<id>  (or query=<name>)
//   things:///search?query=…
// They arrive from other apps, the taskbar jump list and "Copy Link".
import { reveal } from "./actions";
import { addDays, todayYmd } from "./lib/dates";
import { useStore } from "./store";
import type { ListId, Mutation, Selection, When } from "./types";

const LISTS: ListId[] = ["inbox", "today", "upcoming", "anytime", "someday", "logbook", "trash"];

export function linkFor(id: string): string {
  return `things:///show?id=${encodeURIComponent(id)}`;
}

function parseWhen(v: string | null): When | undefined {
  if (!v) return undefined;
  const s = v.trim().toLowerCase();
  if (s === "today") return { kind: "today" };
  if (s === "evening" || s === "tonight") return { kind: "evening" };
  if (s === "tomorrow") return { kind: "date", date: addDays(todayYmd(), 1) };
  if (s === "anytime") return { kind: "anytime" };
  if (s === "someday") return { kind: "someday" };
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { kind: "date", date: s };
  return undefined;
}

const lines = (v: string | null) => (v ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

/** Most to-dos one link may add (same as Paste). */
export const LINK_MAX = 100;
/** Links that add more than this many ask first: any app or web page can open one. */
export const LINK_ASK_ABOVE = 5;

/** Runs `add` right away for small links; for bigger ones, after the user agrees. */
function confirmLarge(count: number, what: string, add: () => Promise<void>): Promise<void> | void {
  if (count <= LINK_ASK_ABOVE) return add();
  useStore.getState().toast(`A link wants to add ${what}.`, "info", { label: "Add them", run: () => void add() });
}

/** Resolves list=… / list-id=… to a project or area. */
function findContainer(params: URLSearchParams): { projectId?: string; areaId?: string; headingId?: string } {
  const v = useStore.getState().view;
  if (!v) return {};
  const id = params.get("list-id");
  const name = params.get("list")?.trim().toLowerCase();
  const project = v.tasks.find((t) => t.type === "project" && !t.trashed && (t.id === id || (!!name && t.title.toLowerCase() === name)));
  if (project) {
    const heading = params.get("heading")?.trim().toLowerCase();
    const h = heading ? v.tasks.find((t) => t.type === "heading" && t.projectId === project.id && t.title.toLowerCase() === heading) : undefined;
    return h ? { headingId: h.id } : { projectId: project.id };
  }
  const area = v.areas.find((a) => a.id === id || (!!name && a.title.toLowerCase() === name));
  return area ? { areaId: area.id } : {};
}

function tagIds(v: string | null): string[] {
  const tags = useStore.getState().view?.tags ?? [];
  return (v ?? "")
    .split(",")
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean)
    .map((n) => tags.find((t) => t.title.toLowerCase() === n)?.id)
    .filter((x): x is string => !!x);
}

export async function handleLink(url: string) {
  const s = useStore.getState();
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return;
  }
  if (u.protocol !== "things:") return;
  const cmd = (u.pathname || u.host).replace(/^\/+/, "").toLowerCase();
  const p = u.searchParams;

  if (cmd === "show") {
    const id = p.get("id");
    const query = p.get("query")?.trim().toLowerCase();
    const v = s.view;
    if (id && (LISTS as string[]).includes(id)) return s.select({ kind: "list", id: id as ListId });
    const task = v?.tasks.find((t) => t.id === id || (!!query && t.title.toLowerCase() === query));
    if (task) return reveal(task);
    const area = v?.areas.find((a) => a.id === id || (!!query && a.title.toLowerCase() === query));
    if (area) return s.select({ kind: "area", id: area.id });
    const tag = v?.tags.find((t) => t.id === id || (!!query && t.title.toLowerCase() === query));
    if (tag) return s.select({ kind: "tag", id: tag.id });
    if (query && (LISTS as string[]).includes(query)) return s.select({ kind: "list", id: query as ListId });
    return s.toast("That link points to something that isn't in Things anymore.", "info");
  }

  if (cmd === "search") {
    return s.openDialog({ kind: "quickFind", initial: p.get("query") ?? "" });
  }

  if (cmd === "add") {
    const all = p.has("titles") ? lines(p.get("titles")) : [p.get("title") ?? ""].filter((t) => t.trim());
    const titles = all.slice(0, LINK_MAX);
    if (!titles.length || p.get("show-quick-entry") === "true") {
      // No title: open a new to-do to type into, like Things' Quick Entry.
      s.select({ kind: "list", id: "inbox" });
      setTimeout(() => window.dispatchEvent(new Event("tings3:new-task")), 0);
      return;
    }
    const base: Extract<Mutation, { type: "createTask" }> = {
      type: "createTask",
      title: "",
      notes: p.get("notes") ?? undefined,
      when: parseWhen(p.get("when")),
      deadline: p.get("deadline") && /^\d{4}-\d{2}-\d{2}$/.test(p.get("deadline")!) ? p.get("deadline") : null,
      tagIds: tagIds(p.get("tags")),
      checklist: lines(p.get("checklist-items")),
      ...findContainer(p),
    };
    return confirmLarge(titles.length, `${titles.length} to-dos`, async () => {
      let last: string | undefined;
      let added = 0;
      for (const title of [...titles].reverse()) {
        const r = await useStore.getState().apply({ ...base, title });
        if (!r) break;
        added++;
        last ??= r.created[0];
      }
      const st = useStore.getState();
      const skipped = all.length - added;
      if (!added) return;
      if (skipped) st.toast(`Added ${added} of ${all.length} to-dos.`, "error");
      else st.toast(titles.length === 1 ? `Added “${titles[0]}”` : `Added ${titles.length} to-dos`, "success");
      if (last && p.get("reveal") === "true") {
        const t = st.view?.tasks.find((x) => x.id === last);
        if (t) reveal(t);
      }
    });
  }

  if (cmd === "add-project") {
    const title = p.get("title")?.trim();
    if (!title) return;
    const area = useStore.getState().view?.areas.find((a) => a.title.toLowerCase() === (p.get("area") ?? "").trim().toLowerCase() || a.id === p.get("area-id"));
    const allTodos = lines(p.get("to-dos"));
    const todos = allTodos.slice(0, LINK_MAX);
    const deadline = p.get("deadline");
    return confirmLarge(todos.length + 1, `the project “${title}” with ${todos.length} to-dos`, async () => {
      const st = useStore.getState();
      const r = await st.apply({ type: "createTask", kind: "project", title, notes: p.get("notes") ?? undefined, when: parseWhen(p.get("when")) ?? { kind: "anytime" }, areaId: area?.id ?? null, deadline: deadline && /^\d{4}-\d{2}-\d{2}$/.test(deadline) ? deadline : null });
      const id = r?.created[0];
      if (!id) return;
      let failed = allTodos.length - todos.length;
      for (const todo of [...todos].reverse()) if (!(await st.apply({ type: "createTask", title: todo, projectId: id }))) failed++;
      const sel: Selection = { kind: "project", id };
      st.select(sel);
      if (failed) st.toast(`Added “${title}”, but ${failed} of its to-dos weren't added.`, "error");
    });
  }

  s.toast(`Things 3 doesn't understand “${cmd}” links yet.`, "info");
}
