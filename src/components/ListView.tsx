import { useEffect, useMemo, useRef, useState } from "react";
import { newTaskDefaults } from "../actions";
import { deadlineLabel, relativeLabel, todayYmd } from "../lib/dates";
import { buildIndex, groupsFor, projectProgress, type Group } from "../lib/lists";
import { parseQuickEntry } from "../lib/quickParse";
import { useStore } from "../store";
import type { Selection, Snapshot, Task } from "../types";
import { AreaIcon, FlagIcon, LIST_META, MoonIcon, ProgressPie, TagIcon } from "./Icons";
import { headingMenu, newItemsMenu } from "./menus";
import { TaskRow, type RowContext } from "./TaskItem";

export function selectionTitle(sel: Selection, view: Snapshot): string {
  if (sel.kind === "list") return LIST_META[sel.id].title;
  if (sel.kind === "project") return view.tasks.find((t) => t.id === sel.id)?.title || "Untitled Project";
  if (sel.kind === "area") return view.areas.find((a) => a.id === sel.id)?.title || "Untitled Area";
  return view.tags.find((t) => t.id === sel.id)?.title ?? "Tag";
}

/** Draft row for a new to-do. Created in Things Cloud only once it has a title. */
export function NewTaskDraft({ section, onDone }: { section?: string; onDone: () => void }) {
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
        <ProgressPie done={p.done} total={p.total} size={26} color="var(--c-project)" />
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
  const filtered: Group[] = tagFilter ? groups.map((g) => ({ ...g, tasks: g.tasks.filter((t) => t.tagIds.includes(tagFilter)) })) : groups;

  // Global "new to-do" requests (Ctrl+N, toolbar, tray).
  useEffect(() => {
    const onNew = (e: Event) => {
      const section = (e as CustomEvent<{ section?: string }>).detail?.section;
      setDraft(section && filtered.some((g) => g.key === section) ? section : (filtered.find((g) => g.key !== "done")?.key ?? "default"));
    };
    window.addEventListener("tings3:new-task", onNew);
    return () => window.removeEventListener("tings3:new-task", onNew);
  });
  useEffect(() => setDraft(null), [selection]);

  const project = selection.kind === "project" ? view.tasks.find((t) => t.id === selection.id) : undefined;
  const meta = selection.kind === "list" ? LIST_META[selection.id] : null;
  const ctx: RowContext = {
    showProject: selection.kind === "list" && ["today", "upcoming", "inbox", "logbook", "trash"].includes(selection.id),
    showWhen: !(selection.kind === "list" && selection.id === "upcoming"),
    listId: selection.kind === "list" ? selection.id : selection.kind,
  };
  const isEmpty = filtered.every((g) => g.tasks.length === 0);
  const showUpcomingEmptyDays = selection.kind === "list" && selection.id === "upcoming";
  const canAdd = !(selection.kind === "list" && (selection.id === "logbook" || selection.id === "trash"));

  return (
    <section
      className="list-view"
      aria-label={selectionTitle(selection, view)}
      onContextMenu={(e) => {
        const t = e.target as HTMLElement;
        if (t.closest("[data-task-id], input, textarea, button, .group-title, .tag-filter")) return;
        e.preventDefault();
        useStore.getState().openMenu(e, newItemsMenu(selection));
      }}
    >
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
            <h1>{selectionTitle(selection, view)}</h1>
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
          return (
            <div key={g.key} className={`group${g.key === "evening" ? " evening" : ""}${g.subtitle ? " day" : ""}`}>
              {g.title && (
                <div
                  className="group-title"
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
              {draft === g.key && <NewTaskDraft section={g.key} onDone={() => setDraft(null)} />}
              {g.tasks.map((t) => (
                <TaskRow key={t.id} task={real.get(t.id) ?? t} ctx={ctx} />
              ))}
            </div>
          );
        })}
        {draft === "default" && <NewTaskDraft onDone={() => setDraft(null)} />}
        {isEmpty && draft === null && !showUpcomingEmptyDays && <EmptyState sel={selection} />}
      </div>
    </section>
  );
}
