import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { newTaskDefaults } from "../actions";
import { canDropInto, drag, dropHeadings, dropTasks, endDrag, HEADING_MIME, nudge, startDrag } from "../dnd";
import { deadlineLabel, relativeLabel, todayYmd } from "../lib/dates";
import { buildIndex, groupsFor, projectProgress, type Group } from "../lib/lists";
import { parseQuickEntry } from "../lib/quickParse";
import { useStore } from "../store";
import type { Selection, Snapshot, Task } from "../types";
import { AreaIcon, FlagIcon, LIST_META, MoonIcon, MoreIcon, ProgressPie, TagIcon } from "./Icons";
import { areaTitleMenu, headingMenu, listViewMenu, newItemsMenu, projectMenu, tagMenu } from "./menus";
import { isSomeday } from "./TaskItem";
import { TaskRow, type RowContext } from "./TaskItem";

export function selectionTitle(sel: Selection, view: Snapshot): string {
  if (sel.kind === "list") return LIST_META[sel.id].title;
  if (sel.kind === "project") return view.tasks.find((t) => t.id === sel.id)?.title || "Untitled Project";
  if (sel.kind === "area") return view.areas.find((a) => a.id === sel.id)?.title || "Untitled Area";
  return view.tags.find((t) => t.id === sel.id)?.title ?? "Tag";
}

/** Draft row for a new to-do. Created in Things Cloud only once it has a title. */
export function NewTaskDraft({ section, onDone, place }: { section?: string; onDone: () => void; place?: { group: Group; index: number } }) {
  const selection = useStore((s) => s.selection);
  const tags = useStore((s) => s.view?.tags) ?? [];
  const apply = useStore((s) => s.apply);
  const [text, setText] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const commit = async (keepOpen: boolean) => {
    const parsed = parseQuickEntry(text, tags, todayYmd());
    if (!parsed.title) return onDone();
    const defaults = newTaskDefaults(selection, section);
    setText("");
    const r = await apply({
      type: "createTask",
      ...defaults,
      title: parsed.title,
      when: parsed.when ?? defaults.when ?? null,
      deadline: parsed.deadline,
      reminder: parsed.reminder,
      tagIds: [...new Set([...(defaults.tagIds ?? []), ...parsed.tagIds])],
    });
    if (r?.created[0] && parsed.when && !defaults.when && selection.kind === "list") {
      const label = parsed.when.kind === "date" ? relativeLabel(parsed.when.date, todayYmd()) : { today: "Today", evening: "This Evening", someday: "Someday", anytime: "Anytime", inbox: "Inbox" }[parsed.when.kind];
      useStore.getState().toast(`Added “${parsed.title}” · ${label}`, "success");
    }
    if (r?.created[0] && place) await dropTasks(selection, place.group, place.index, [r.created[0]]);
    if (r?.created[0] && !keepOpen) useStore.getState().selectTask(r.created[0]);
    if (!keepOpen) onDone();
  };
  return (
    <div className="task-editor draft">
      <div className="editor-head">
        <span className="checkbox" aria-hidden="true" />
        <input
          ref={ref}
          className="editor-title"
          placeholder="New To-Do"
          value={text}
          aria-label="New to-do title"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commit(e.shiftKey || e.ctrlKey);
            } else if (e.key === "Escape") {
              e.stopPropagation();
              onDone();
            }
          }}
          onBlur={() => void commit(false)}
        />
      </div>
      <div className="draft-hint">Enter to save · Shift+Enter to add another · try “tomorrow at 9am #Errand”</div>
    </div>
  );
}

function ProjectHeader({ project }: { project: Task }) {
  const view = useStore((s) => s.view)!;
  const apply = useStore((s) => s.apply);
  const writable = useStore((s) => !!s.app?.canWrite);
  const [title, setTitle] = useState(project.title);
  const [notes, setNotes] = useState(project.notes);
  useEffect(() => {
    setTitle(project.title);
    setNotes(project.notes);
  }, [project.id, project.title, project.notes]);
  const p = projectProgress(project.id, view);
  const today = todayYmd();
  const save = (patch: { title?: string; notes?: string }) => void apply({ type: "updateTask", id: project.id, baseRev: project.rev, ...patch });
  const area = view.areas.find((a) => a.id === project.areaId);
  return (
    <header className="list-header project">
      <div className="list-title-row">
        <ProgressPie done={p.done} total={p.total} size={26} color="var(--c-project)" dashed={isSomeday(project)} />
        <input
          className="list-title-input"
          value={title}
          readOnly={!writable}
          placeholder="New Project"
          aria-label="Project title"
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title.trim() && title !== project.title && save({ title })}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
        <TitleMore label="Project actions" items={(el) => projectMenu(project, el)} />
      </div>
      <div className="project-meta">
        {area && (
          <button className="crumb" onClick={() => useStore.getState().select({ kind: "area", id: area.id })}>
            <AreaIcon size={12} /> {area.title}
          </button>
        )}
        {project.startDate && <span className="crumb">{relativeLabel(project.startDate, today)}</span>}
        {project.deadline && (
          <span className={`deadline${deadlineLabel(project.deadline, today).overdue ? " overdue" : ""}`}>
            <FlagIcon size={12} /> Deadline {relativeLabel(project.deadline, today)}
          </span>
        )}
        {project.repeat && <span className="crumb">{project.repeat.summary}</span>}
      </div>
      <textarea
        className="project-notes"
        value={notes}
        readOnly={!writable}
        placeholder="Notes"
        rows={Math.max(1, notes.split("\n").length)}
        onChange={(e) => setNotes(e.target.value)}
        onBlur={() => notes !== project.notes && save({ notes })}
        aria-label="Project notes"
      />
    </header>
  );
}

const writableNow = () => useStore.getState().canWrite();

/** The ••• pill beside a project, area or tag title. */
function TitleMore({ label, items }: { label: string; items: (anchor: HTMLElement) => import("../store").MenuItem[] }) {
  return (
    <button className="title-more" aria-label={label} title={label} onClick={(e) => useStore.getState().openMenu(e.currentTarget, items(e.currentTarget))}>
      <MoreIcon size={15} />
    </button>
  );
}

const EMPTY: Record<string, [string, string]> = {
  inbox: ["Inbox Zero", "Capture anything with Ctrl+N, or from anywhere with the Quick Entry shortcut."],
  today: ["All clear for today", "Nothing planned. Enjoy it — or pull something in from Anytime."],
  upcoming: ["Nothing scheduled", "To-dos with a start date appear here, grouped by day."],
  anytime: ["No to-dos here", "To-dos you can do at any time collect here."],
  someday: ["No someday ideas yet", "Park things you might want to do later."],
  logbook: ["Nothing completed yet", "Completed to-dos are filed here."],
  trash: ["Trash is empty", "Deleted to-dos stay here until you empty it."],
};

function EmptyState({ sel }: { sel: Selection }) {
  const [title, msg] = (sel.kind === "list" && EMPTY[sel.id]) || ["No to-dos", sel.kind === "project" ? "Press Ctrl+N to add the first to-do to this project." : "Nothing here yet."];
  const meta = sel.kind === "list" ? LIST_META[sel.id] : null;
  return (
    <div className="empty-state">
      {meta && (
        <div className="empty-art" style={{ color: meta.color }}>
          <meta.Icon size={30} />
        </div>
      )}
      <h3>{title}</h3>
      <p>{msg}</p>
    </div>
  );
}

export function ListView() {
  const view = useStore((s) => s.view)!;
  const selection = useStore((s) => s.selection);
  const recentlyCompleted = useStore((s) => s.recentlyCompleted);
  const tagFilter = useStore((s) => s.tagFilter);
  const setTagFilter = useStore((s) => s.setTagFilter);
  const [draft, setDraft] = useState<string | null>(null);
  /** The row a new to-do goes right after (Space). */
  const [draftAfter, setDraftAfter] = useState<string | null>(null);
  /** Where a dragged to-do would land: before group.tasks[index]. */
  const [drop, setDrop] = useState<{ key: string; index: number } | null>(null);
  /** Heading drag: insert before this heading (or "end"). */
  const [headingDrop, setHeadingDrop] = useState<string | null>(null);
  const [showLogged, setShowLogged] = useState(false);
  const [hideLater, setHideLater] = useState(false);
  const today = todayYmd();

  // Things keeps just-completed items in place until you leave the list.
  const visibleSnap = useMemo<Snapshot>(() => {
    if (!recentlyCompleted.length) return view;
    const set = new Set(recentlyCompleted);
    return { ...view, tasks: view.tasks.map((t) => (set.has(t.id) && t.status !== "open" ? { ...t, status: "open" as const } : t)) };
  }, [view, recentlyCompleted]);
  const ix = useMemo(() => buildIndex(visibleSnap), [visibleSnap]);
  const real = useMemo(() => new Map(view.tasks.map((t) => [t.id, t])), [view]);
  const groups = useMemo(() => groupsFor(selection, visibleSnap, ix, today), [selection, visibleSnap, ix, today]);
  const usedTags = useMemo(() => {
    const ids = new Set(groups.flatMap((g) => g.tasks.flatMap((t) => t.tagIds)));
    return view.tags.filter((t) => ids.has(t.id));
  }, [groups, view.tags]);
  const laterCount = selection.kind === "project" ? groups.filter((g) => g.key !== "done").reduce((n, g) => n + g.tasks.filter((t) => t.startDate && t.startDate > today).length, 0) : 0;
  const filtered: Group[] = groups
    .map((g) => (tagFilter ? { ...g, tasks: g.tasks.filter((t) => t.tagIds.includes(tagFilter)) } : g))
    .map((g) => (hideLater && g.key !== "done" ? { ...g, tasks: g.tasks.filter((t) => !(t.startDate && t.startDate > today)) } : g));

  // Global "new to-do" requests (Ctrl+N, toolbar, tray).
  useEffect(() => {
    const onNew = (e: Event) => {
      const detail = (e as CustomEvent<{ section?: string; after?: string }>).detail;
      const afterGroup = detail?.after ? filtered.find((g) => g.key !== "done" && g.tasks.some((t) => t.id === detail.after)) : undefined;
      if (afterGroup) {
        setDraftAfter(detail!.after!);
        setDraft(afterGroup.key);
        return;
      }
      setDraftAfter(null);
      const section = detail?.section;
      setDraft(section && filtered.some((g) => g.key === section) ? section : (filtered.find((g) => g.key !== "done")?.key ?? "default"));
    };
    // Ctrl+↑/↓ (and with Alt: to the top/bottom) from the keyboard handler.
    const onNudge = (e: Event) => {
      const s = useStore.getState();
      void nudge(selection, filtered, s.selectedIds, (e as CustomEvent<"up" | "down" | "top" | "bottom">).detail);
    };
    window.addEventListener("tings3:new-task", onNew);
    window.addEventListener("tings3:nudge", onNudge);
    return () => {
      window.removeEventListener("tings3:new-task", onNew);
      window.removeEventListener("tings3:nudge", onNudge);
    };
  });
  useEffect(() => {
    setDraft(null);
    setDraftAfter(null);
    setShowLogged(false);
    setHideLater(false);
  }, [selection]);

  /** Index in `g.tasks` the pointer points at: before or after the row under it. */
  const dropIndex = (e: React.DragEvent, g: Group): number => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".task-row[data-task-id]");
    if (!row) return (e.target as HTMLElement).closest(".group-title") ? 0 : g.tasks.length;
    const i = g.tasks.findIndex((t) => t.id === row.dataset.taskId);
    if (i < 0) return g.tasks.length;
    const r = row.getBoundingClientRect();
    return e.clientY > r.top + r.height / 2 ? i + 1 : i;
  };
  const onGroupDragOver = (e: React.DragEvent, g: Group) => {
    if (drag.kind === "heading" && selection.kind === "project") {
      if (g.key === "none" || g.key === "done") return;
      e.preventDefault();
      const onTitle = !!(e.target as HTMLElement).closest(".group-title");
      const headings = filtered.filter((x) => x.key !== "none" && x.key !== "done").map((x) => x.key);
      const before = onTitle ? g.key : (headings[headings.indexOf(g.key) + 1] ?? "end");
      if (before !== headingDrop) setHeadingDrop(before);
      return;
    }
    if (drag.kind !== "task") return;
    const tasks = drag.ids.map((id) => real.get(id)).filter((t): t is NonNullable<typeof t> => !!t);
    if (!canDropInto(selection, g, tasks)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const index = dropIndex(e, g);
    if (drop?.key !== g.key || drop.index !== index) setDrop({ key: g.key, index });
  };
  const onGroupDrop = (e: React.DragEvent, g: Group) => {
    e.preventDefault();
    const ids = drag.ids;
    if (drag.kind === "heading" && selection.kind === "project" && headingDrop) {
      void dropHeadings(selection.id, ids, headingDrop === "end" ? null : headingDrop);
    } else if (drag.kind === "task" && drop?.key === g.key) {
      void dropTasks(selection, g, drop.index, ids);
    }
    setDrop(null);
    setHeadingDrop(null);
    endDrag();
  };
  const clearDrop = () => {
    setDrop(null);
    setHeadingDrop(null);
  };

  const project = selection.kind === "project" ? view.tasks.find((t) => t.id === selection.id) : undefined;
  const meta = selection.kind === "list" ? LIST_META[selection.id] : null;
  const ctx: RowContext = {
    showProject: selection.kind === "list" && ["today", "upcoming", "inbox", "logbook", "trash"].includes(selection.id),
    showWhen: !(selection.kind === "list" && selection.id === "upcoming"),
    listId: selection.kind === "list" ? selection.id : selection.kind,
  };
  const isEmpty = filtered.every((g) => g.tasks.length === 0);
  const selectMode = useStore((s) => s.selectMode);
  const title = selectionTitle(selection, view);
  const visibleTasks = () => filtered.flatMap((g) => g.tasks.map((t) => real.get(t.id) ?? t));
  const area = selection.kind === "area" ? view.areas.find((a) => a.id === selection.id) : undefined;
  const tag = selection.kind === "tag" ? view.tags.find((t) => t.id === selection.id) : undefined;
  const corner = selectMode ? (
    <button className="btn primary done-btn" onClick={() => useStore.getState().setSelectMode(false)}>
      Done
    </button>
  ) : (
    <button
      className="list-more"
      aria-label="List actions"
      title="Filter by Tag, Select, Paste, Share"
      onClick={(e) => useStore.getState().openMenu(e.currentTarget, listViewMenu(selection, title, usedTags, visibleTasks))}
    >
      <MoreIcon size={16} />
    </button>
  );
  const showUpcomingEmptyDays = selection.kind === "list" && selection.id === "upcoming";
  const canAdd = !(selection.kind === "list" && (selection.id === "logbook" || selection.id === "trash"));

  return (
    <section
      className="list-view"
      aria-label={selectionTitle(selection, view)}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && clearDrop()}
      onDragEnd={() => (clearDrop(), endDrag())}
      onContextMenu={(e) => {
        const t = e.target as HTMLElement;
        if (t.closest("[data-task-id], input, textarea, button, .group-title, .tag-filter")) return;
        e.preventDefault();
        useStore.getState().openMenu(e, newItemsMenu(selection));
      }}
    >
      <div className="list-corner">{corner}</div>
      {project ? (
        <ProjectHeader project={project} />
      ) : (
        <header className="list-header">
          <div className="list-title-row">
            {meta ? (
              <meta.Icon size={26} style={{ color: meta.color }} />
            ) : selection.kind === "area" ? (
              <AreaIcon size={26} style={{ color: "var(--c-area)" }} />
            ) : (
              <TagIcon size={26} style={{ color: "var(--text-2)" }} />
            )}
            <h1>{title}</h1>
            {area && <TitleMore label="Area actions" items={() => areaTitleMenu(area)} />}
            {tag && <TitleMore label="Tag actions" items={() => tagMenu(tag)} />}
          </div>
        </header>
      )}
      {usedTags.length > 0 && (
        <div className="tag-filter" role="toolbar" aria-label="Filter by tag">
          <button className={`chip${!tagFilter ? " active" : ""}`} onClick={() => setTagFilter(null)}>
            All
          </button>
          {usedTags.map((t) => (
            <button key={t.id} className={`chip${tagFilter === t.id ? " active" : ""}`} onClick={() => setTagFilter(tagFilter === t.id ? null : t.id)}>
              {t.title}
            </button>
          ))}
        </div>
      )}
      <div className="groups" role="listbox" aria-label="To-dos">
        {filtered.map((g) => {
          if (!g.tasks.length && !(showUpcomingEmptyDays && g.subtitle) && draft !== g.key && !(g.title && selection.kind === "project" && g.key !== "done"))
            return null;
          const isHeading = selection.kind === "project" && g.key !== "none" && g.key !== "done";
          if (g.key === "done" && selection.kind === "project") {
            return (
              <div key={g.key} className="group logged">
                <button className="logged-toggle" onClick={() => setShowLogged((v) => !v)} aria-expanded={showLogged}>
                  {showLogged ? "Hide logged items" : `Show ${g.tasks.length} logged item${g.tasks.length === 1 ? "" : "s"}`}
                </button>
                {showLogged && g.tasks.map((t) => <TaskRow key={t.id} task={real.get(t.id) ?? t} ctx={ctx} />)}
              </div>
            );
          }
          return (
            <div
              key={g.key}
              className={`group${g.key === "evening" ? " evening" : ""}${g.subtitle ? " day" : ""}${headingDrop === g.key ? " heading-drop" : ""}`}
              onDragOver={(e) => onGroupDragOver(e, g)}
              onDrop={(e) => onGroupDrop(e, g)}
            >
              {g.title && (
                <div
                  className="group-title"
                  draggable={isHeading && writableNow()}
                  onDragStart={(e) => isHeading && startDrag("heading", [g.key], e, HEADING_MIME)}
                  onContextMenu={(e) => {
                    const heading = selection.kind === "project" ? view.tasks.find((t) => t.id === g.key && t.type === "heading") : undefined;
                    if (!heading) return;
                    e.preventDefault();
                    useStore.getState().openMenu(e, headingMenu(heading));
                  }}
                >
                  {g.key === "evening" && <MoonIcon size={14} style={{ color: "var(--c-evening)" }} />}
                  {g.subtitle ? (
                    <>
                      <span className="day-num">{g.title}</span>
                      <span className="day-name">{g.subtitle}</span>
                    </>
                  ) : g.link ? (
                    <button className="group-link" onClick={() => useStore.getState().select(g.link!)}>
                      {g.title}
                    </button>
                  ) : (
                    <span>{g.title}</span>
                  )}
                  {canAdd && g.key !== "done" && (
                    <button className="group-add" aria-label={`New to-do in ${g.subtitle ?? g.title}`} onClick={() => setDraft(g.key)}>
                      +
                    </button>
                  )}
                </div>
              )}
              {draft === g.key && !(draftAfter && g.tasks.some((t) => t.id === draftAfter)) && <NewTaskDraft section={g.key} onDone={() => setDraft(null)} />}
              {g.tasks.map((t, i) => (
                <Fragment key={t.id}>
                  {drop?.key === g.key && drop.index === i && <div className="drop-line" aria-hidden="true" />}
                  <TaskRow task={real.get(t.id) ?? t} ctx={ctx} />
                  {draft === g.key && draftAfter === t.id && (
                    <NewTaskDraft
                      section={g.key}
                      place={{ group: g, index: i + 1 }}
                      onDone={() => {
                        setDraft(null);
                        setDraftAfter(null);
                      }}
                    />
                  )}
                </Fragment>
              ))}
              {drop?.key === g.key && drop.index === g.tasks.length && <div className="drop-line" aria-hidden="true" />}
              {!g.tasks.length && drop?.key !== g.key && drag.kind === "task" && <div className="drop-zone" aria-hidden="true" />}
            </div>
          );
        })}
        {headingDrop === "end" && <div className="drop-line heading" aria-hidden="true" />}
        {draft === "default" && <NewTaskDraft onDone={() => setDraft(null)} />}
        {laterCount > 0 && (
          <button className="logged-toggle later" onClick={() => setHideLater((v) => !v)}>
            {hideLater ? `Show ${laterCount} later item${laterCount === 1 ? "" : "s"}` : "Hide later items"}
          </button>
        )}
        {isEmpty && draft === null && !showUpcomingEmptyDays && <EmptyState sel={selection} />}
      </div>
    </section>
  );
}
