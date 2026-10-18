import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { deletePermanently, moveTo, schedule, toggleComplete, trash } from "../actions";
import { deadlineLabel, relativeLabel, todayYmd } from "../lib/dates";
import { projectProgress } from "../lib/lists";
import { endDrag, startDrag } from "../dnd";
import { useMulti, useStore } from "../store";
import type { ChecklistItem, Tag, Task } from "../types";
import {
  AreaIcon,
  ArrowRightIcon,
  BellIcon,
  BoxIcon,
  CalendarIcon,
  ChecklistIcon,
  ChevronIcon,
  CloseIcon,
  FlagIcon,
  MoonIcon,
  MoreIcon,
  NotesIcon,
  ProgressPie,
  RepeatIcon,
  StarIcon,
  TagIcon,
  TrashIcon,
  UndoIcon,
} from "./Icons";
import { bulkMenu, checklistMenu, taskMenu } from "./menus";
import { DeadlinePicker, MovePicker, TagPicker, WhenPicker } from "./Pickers";

const EMPTY_TAGS: Tag[] = [];

/** Someday to-dos (no start date) get a dashed box, like Things. */
export function isSomeday(t: Pick<Task, "start" | "startDate" | "status">): boolean {
  return t.status === "open" && t.start === "someday" && !t.startDate;
}

export function Checkbox({ task, disabled }: { task: Task; disabled: boolean }) {
  const done = task.status !== "open";
  return (
    <button
      className={`checkbox${done ? " done" : ""}${task.status === "canceled" ? " canceled" : ""}${task.deadline && task.deadline <= todayYmd() && !done ? " due" : ""}${isSomeday(task) ? " someday" : ""}`}
      role="checkbox"
      aria-checked={done}
      aria-label={done ? `Mark “${task.title}” as open` : `Complete “${task.title}”`}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        void toggleComplete(task);
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {task.status === "completed" && (
        <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
          <path d="m2.5 6.3 2.3 2.2 4.7-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      {task.status === "canceled" && <CloseIcon size={10} />}
    </button>
  );
}

export function TagChips({ ids, tags }: { ids: string[]; tags: Tag[] }) {
  const names = ids.map((id) => tags.find((t) => t.id === id)?.title).filter(Boolean);
  if (!names.length) return null;
  return (
    <>
      {names.map((n) => (
        <span key={n} className="tag-chip">
          {n}
        </span>
      ))}
    </>
  );
}

export interface RowContext {
  showProject: boolean;
  showWhen: boolean;
  listId: string;
}

/** Quick actions shown to the left of the selected row. */
function RowActions({ task }: { task: Task }) {
  const openPicker = useStore((s) => s.openPicker);
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  if (task.trashed)
    return (
      <div className="row-actions" onClick={stop} onDoubleClick={stop}>
        <button className="ra-btn" title="Put Back" aria-label="Put Back" onClick={() => void trash(task, false)}>
          <UndoIcon size={13} />
        </button>
        <button className="ra-btn danger" title="Delete Permanently (Delete)" aria-label="Delete Permanently" onClick={() => deletePermanently([task])}>
          <TrashIcon size={13} />
        </button>
      </div>
    );
  return (
    <div className="row-actions" onClick={stop} onDoubleClick={stop}>
      {task.status === "open" && (
        <button className="ra-btn" title="When (Ctrl+S)" aria-label="When" onClick={(e) => openPicker({ kind: "when", taskId: task.id, anchor: e.currentTarget })}>
          <CalendarIcon size={13} />
        </button>
      )}
      <button className="ra-btn" title="Move (Ctrl+Shift+M)" aria-label="Move" onClick={(e) => openPicker({ kind: "move", taskId: task.id, anchor: e.currentTarget })}>
        <ArrowRightIcon size={13} />
      </button>
      <button className="ra-btn danger" title="Move to Trash (Delete)" aria-label="Move to Trash" onClick={() => void trash(task)}>
        <TrashIcon size={13} />
      </button>
    </div>
  );
}

/** Row ids in the order they appear on screen. */
function visibleRowIds(): string[] {
  return [...document.querySelectorAll<HTMLElement>(".groups .task-row[data-task-id]")].map((el) => el.dataset.taskId!);
}

/** Click, Ctrl-click and Shift-click selection, like Things and Explorer. */
function clickRow(e: React.MouseEvent, task: Task) {
  const s = useStore.getState();
  if (e.shiftKey) {
    const ids = visibleRowIds();
    const from = ids.indexOf(s.anchorId ?? s.selectedId ?? task.id);
    const to = ids.indexOf(task.id);
    if (from !== -1 && to !== -1) {
      const range = ids.slice(Math.min(from, to), Math.max(from, to) + 1);
      const keep = e.ctrlKey || e.metaKey ? s.selectedIds.filter((id) => !range.includes(id)) : [];
      s.setSelected([...keep, ...range], task.id);
      window.getSelection()?.removeAllRanges();
      return;
    }
  }
  if (e.ctrlKey || e.metaKey || s.selectMode) return s.toggleSelected(task.id);
  // Clicking the one selected to-do again opens it, like tapping in Things.
  if (task.type === "task" && !task.trashed && s.selectedIds.length === 1 && s.selectedId === task.id && e.detail === 1) return s.edit(task.id);
  s.selectTask(task.id);
}

export const TaskRow = memo(function TaskRow({ task, ctx }: { task: Task; ctx: RowContext }) {
  const selected = useStore((s) => s.selectedIds.includes(task.id));
  const multi = useMulti();
  const editing = useStore((s) => s.editingId === task.id);
  const view = useStore((s) => s.view);
  const writable = useStore((s) => !!s.app?.canWrite);
  const tags = view?.tags ?? EMPTY_TAGS;
  const checklist = view?.checklist;
  const parent = task.projectId ? view?.tasks.find((t) => t.id === task.projectId) : undefined;
  const area = task.areaId ? view?.areas.find((a) => a.id === task.areaId) : undefined;
  const progress = task.type === "project" && view ? projectProgress(task.id, view) : null;
  const { selectTask, edit, select } = useStore.getState();
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (selected) rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  if (editing && task.type === "task") return <TaskEditor task={task} />;

  const today = todayYmd();
  const items = checklist?.filter((c) => c.taskId === task.id) ?? [];
  const done = task.status !== "open";
  const dl = task.deadline && !done ? deadlineLabel(task.deadline, today) : null;
  const isProject = task.type === "project";

  return (
    <div
      ref={rowRef}
      className={`task-row${selected ? " selected" : ""}${done ? " is-done" : ""}${isProject ? " is-project" : ""}`}
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      draggable={writable}
      data-task-id={task.id}
      onDragStart={(e) => {
        // Dragging a selected row carries the whole selection.
        const s = useStore.getState();
        const ids = selected && s.selectedIds.length > 1 ? s.selectedIds : [task.id];
        startDrag("task", ids, e);
      }}
      onDragEnd={endDrag}
      onMouseDown={(e) => e.shiftKey && e.preventDefault() /* no text selection on Shift-click */}
      onClick={(e) => clickRow(e, task)}
      onDoubleClick={(e) => {
        if (e.ctrlKey || e.metaKey || e.shiftKey || useStore.getState().selectMode) return;
        if (isProject) select({ kind: "project", id: task.id });
        else edit(task.id);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        const s = useStore.getState();
        if (selected && s.selectedIds.length > 1) {
          const byId = new Map((s.view?.tasks ?? []).map((t) => [t.id, t]));
          const tasks = s.selectedIds.map((id) => byId.get(id)).filter((t): t is Task => !!t);
          s.openMenu(e, bulkMenu(tasks, rowRef.current));
          return;
        }
        selectTask(task.id);
        s.openMenu(e, taskMenu(task));
      }}
    >
      {selected && writable && !multi && <RowActions task={task} />}
      {isProject ? (
        <button className="project-pie" aria-label={`Open project ${task.title}`} onClick={() => select({ kind: "project", id: task.id })}>
          <ProgressPie done={progress?.done ?? 0} total={progress?.total ?? 0} color="var(--c-project)" dashed={isSomeday(task)} />
        </button>
      ) : (
        <Checkbox task={task} disabled={!writable} />
      )}
      <div className="task-main">
        <div className="task-line">
          {ctx.showWhen && task.startDate && task.startDate <= today && task.start !== "inbox" && ctx.listId !== "today" && (
            <StarIcon size={12} className="inline-star" aria-label="Today" />
          )}
          {ctx.showWhen && task.evening && ctx.listId !== "today" && <MoonIcon size={12} className="inline-moon" />}
          {ctx.showWhen && task.startDate && task.startDate > today && ctx.listId !== "upcoming" && (
            <span className="when-chip">{relativeLabel(task.startDate, today)}</span>
          )}
          <span className={`task-title${task.title ? "" : " placeholder"}`}>{task.title || (isProject ? "New Project" : "New To-Do")}</span>
          {task.repeat && <RepeatIcon size={12} className="meta-icon" aria-label={task.repeat.summary} />}
          {task.reminder && <BellIcon size={12} className="meta-icon" aria-label={`Reminder ${task.reminder}`} />}
          {task.notes && <NotesIcon size={12} className="meta-icon" aria-label="Has notes" />}
          {items.length > 0 && (
            <span className="meta-count" aria-label="Checklist">
              <ChecklistIcon size={12} /> {items.filter((c) => c.completed).length}/{items.length}
            </span>
          )}
          <TagChips ids={task.tagIds} tags={tags} />
          <span className="grow" />
          {dl && (
            <span className={`deadline${dl.overdue ? " overdue" : dl.soon ? " soon" : ""}`}>
              <FlagIcon size={12} /> {dl.text}
            </span>
          )}
        </div>
        {ctx.showProject && (parent || area) && <div className="task-sub">{parent ? parent.title : area?.title}</div>}
      </div>
      {multi && (
        <span className={`sel-circle${selected ? " on" : ""}`} role="presentation" aria-hidden="true">
          {selected && (
            <svg viewBox="0 0 12 12" width="9" height="9">
              <path d="m2.5 6.3 2.3 2.2 4.7-5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </span>
      )}
    </div>
  );
});

/** "○ Project ›" in the open to-do, when viewing it outside its project or area (Today, Upcoming…). */
function ContainerLink({ task }: { task: Task }) {
  const selection = useStore((s) => s.selection);
  const view = useStore((s) => s.view);
  const project = task.projectId ? view?.tasks.find((t) => t.id === task.projectId) : undefined;
  const area = task.areaId ? view?.areas.find((a) => a.id === task.areaId) : undefined;
  const progress = project && view ? projectProgress(project.id, view) : null;
  const heading = task.headingId ? view?.tasks.find((t) => t.id === task.headingId) : undefined;
  if (project && selection.kind === "project" && selection.id === project.id) return null;
  if (!project && area && selection.kind === "area" && selection.id === area.id) return null;
  if (!project && !area) return null;
  const go = () => {
    const s = useStore.getState();
    s.edit(null);
    s.select(project ? { kind: "project", id: project.id } : { kind: "area", id: area!.id });
    s.selectTask(task.id);
  };
  return (
    <button className="container-link" onClick={go} title={project ? "Open project" : "Open area"}>
      {project ? <ProgressPie done={progress?.done ?? 0} total={progress?.total ?? 0} size={14} color="var(--c-project)" dashed={isSomeday(project)} /> : <AreaIcon size={14} />}
      <span>{project ? project.title || "Untitled Project" : area!.title}</span>
      {heading && <span className="container-heading">· {heading.title}</span>}
      <ChevronIcon size={10} />
    </button>
  );
}

function autosize(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

type Picker = "when" | "tags" | "deadline" | "move" | null;

export function TaskEditor({ task }: { task: Task }) {
  const apply = useStore((s) => s.apply);
  const tags = useStore((s) => s.view?.tags) ?? EMPTY_TAGS;
  const writable = useStore((s) => !!s.app?.canWrite);
  const allChecklist = useStore((s) => s.view?.checklist);
  const checklist = useMemo(() => (allChecklist ?? []).filter((c) => c.taskId === task.id), [allChecklist, task.id]);
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes);
  const [picker, setPicker] = useState<Picker>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [showChecklist, setShowChecklist] = useState(checklist.length > 0);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  // Base revision: the version the user started editing, for conflict detection.
  const baseRev = useRef(task.rev);

  useEffect(() => {
    titleRef.current?.focus();
    autosize(notesRef.current);
  }, []);

  const save = () => {
    const patch: { title?: string; notes?: string } = {};
    if (title.trim() && title.trim() !== task.title) patch.title = title.trim();
    if (notes !== task.notes) patch.notes = notes;
    if (Object.keys(patch).length && writable) void apply({ type: "updateTask", id: task.id, baseRev: baseRev.current, ...patch });
  };
  const close = () => {
    save();
    useStore.getState().edit(null);
  };

  // Click outside closes and saves, like Things.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t) || document.querySelector(".popover-layer")?.contains(t)) return;
      close();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  });

  const open = (p: Picker) => (e: React.MouseEvent<HTMLElement>) => {
    setAnchor(e.currentTarget);
    setPicker(p);
  };

  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  const today = todayYmd();
  const whenLabel =
    task.start === "inbox"
      ? null
      : task.startDate && task.startDate <= today
        ? task.evening
          ? "This Evening"
          : "Today"
        : task.startDate
          ? relativeLabel(task.startDate, today)
          : task.start === "someday"
            ? "Someday"
            : null;

  return (
    <div ref={rootRef} className="task-editor" onKeyDown={onKey} data-task-id={task.id}>
      <div className="editor-head">
        <Checkbox task={task} disabled={!writable} />
        <input
          ref={titleRef}
          className="editor-title"
          value={title}
          placeholder="New To-Do"
          readOnly={!writable}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), close())}
          aria-label="Title"
        />
      </div>
      <textarea
        ref={notesRef}
        className="editor-notes"
        placeholder="Notes"
        value={notes}
        readOnly={!writable}
        rows={1}
        onChange={(e) => {
          setNotes(e.target.value);
          autosize(e.target);
        }}
        onBlur={save}
        aria-label="Notes"
      />
      {showChecklist && <ChecklistEditor taskId={task.id} items={checklist} writable={writable} />}
      {task.repeat && (
        <div className="editor-repeat">
          <RepeatIcon size={12} /> {task.repeat.summary}
          <span className="hint"> · New occurrences are created by Things on your iPhone.</span>
        </div>
      )}
      <div className="editor-foot">
        <div className="editor-chips">
          {whenLabel && (
            <button className="chip when" onClick={open("when")} disabled={!writable}>
              {whenLabel === "Today" ? <StarIcon size={12} style={{ color: "var(--c-today)" }} /> : whenLabel === "This Evening" ? <MoonIcon size={12} style={{ color: "var(--c-evening)" }} /> : whenLabel === "Someday" ? <BoxIcon size={12} /> : <CalendarIcon size={12} style={{ color: "var(--c-upcoming)" }} />}
              {whenLabel}
              {task.reminder && ` · ${task.reminder}`}
              <span
                className="chip-x"
                role="button"
                aria-label="Clear when"
                onClick={(e) => {
                  e.stopPropagation();
                  void schedule(task, { kind: "anytime" });
                }}
              >
                ×
              </span>
            </button>
          )}
          {task.tagIds.length > 0 && (
            <button className="chip" onClick={open("tags")} disabled={!writable}>
              <TagChips ids={task.tagIds} tags={tags} />
            </button>
          )}
          {task.deadline && (
            <button className="chip deadline-chip" onClick={open("deadline")} disabled={!writable}>
              <FlagIcon size={12} /> Deadline: {relativeLabel(task.deadline, today)}
            </button>
          )}
        </div>
        <div className="editor-actions">
          {!whenLabel && (
            <button className="icon-btn" title="When (Ctrl+S)" onClick={open("when")} disabled={!writable}>
              <CalendarIcon />
            </button>
          )}
          {!task.tagIds.length && (
            <button className="icon-btn" title="Tags (Ctrl+Shift+T)" onClick={open("tags")} disabled={!writable}>
              <TagIcon />
            </button>
          )}
          {!showChecklist && (
            <button className="icon-btn" title="Checklist" onClick={() => setShowChecklist(true)} disabled={!writable}>
              <ChecklistIcon />
            </button>
          )}
          {!task.deadline && (
            <button className="icon-btn" title="Deadline (Ctrl+Shift+D)" onClick={open("deadline")} disabled={!writable}>
              <FlagIcon />
            </button>
          )}
          <button className="icon-btn" title="Move (Ctrl+Shift+M)" onClick={open("move")} disabled={!writable}>
            <ArrowRightIcon />
          </button>
          <button className="icon-btn" title="Move to Trash (Delete)" onClick={() => void trash(task)} disabled={!writable}>
            <TrashIcon />
          </button>
          <button className="icon-btn" title="More" aria-label="More actions" onClick={(e) => useStore.getState().openMenu(e.currentTarget, taskMenu(task))}>
            <MoreIcon />
          </button>
        </div>
      </div>
      <div className="editor-where">
        <ContainerLink task={task} />
      </div>
      {picker === "when" && (
        <WhenPicker anchor={anchor} task={task} onPick={(w, r) => void schedule(task, w, r)} onClose={() => setPicker(null)} />
      )}
      {picker === "tags" && (
        <TagPicker anchor={anchor} value={task.tagIds} onChange={(ids) => void apply({ type: "updateTask", id: task.id, baseRev: task.rev, tagIds: ids })} onClose={() => setPicker(null)} />
      )}
      {picker === "deadline" && (
        <DeadlinePicker anchor={anchor} value={task.deadline} onPick={(d) => void apply({ type: "updateTask", id: task.id, baseRev: task.rev, deadline: d })} onClose={() => setPicker(null)} />
      )}
      {picker === "move" && <MovePicker anchor={anchor} task={task} onPick={(t) => void moveTo(task, t)} onClose={() => setPicker(null)} />}
    </div>
  );
}

function ChecklistEditor({ taskId, items, writable }: { taskId: string; items: ChecklistItem[]; writable: boolean }) {
  const apply = useStore((s) => s.apply);
  const destructive = useStore((s) => !!s.app?.policy.destructive);
  const [draft, setDraft] = useState("");
  const add = () => {
    if (!draft.trim()) return;
    void apply({ type: "addChecklistItem", taskId, title: draft.trim() });
    setDraft("");
  };
  return (
    <div className="checklist" role="list">
      {items.map((c) => (
        <ChecklistRow key={c.id} item={c} writable={writable} canDelete={destructive} />
      ))}
      {writable && (
        <div className="checklist-row new">
          <span className="mini-check" />
          <input value={draft} placeholder="Add checklist item" onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), add())} onBlur={add} />
        </div>
      )}
    </div>
  );
}

function ChecklistRow({ item, writable, canDelete }: { item: ChecklistItem; writable: boolean; canDelete: boolean }) {
  const apply = useStore((s) => s.apply);
  const [title, setTitle] = useState(item.title);
  useEffect(() => setTitle(item.title), [item.title]);
  return (
    <div
      className={`checklist-row${item.completed ? " done" : ""}`}
      role="listitem"
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).tagName === "INPUT" && window.getSelection()?.toString()) return; // keep copy/paste on selected text
        e.preventDefault();
        useStore.getState().openMenu(e, checklistMenu(item));
      }}
    >
      <button
        className={`mini-check${item.completed ? " done" : ""}`}
        role="checkbox"
        aria-checked={item.completed}
        aria-label={item.title}
        disabled={!writable}
        onClick={() => void apply({ type: "updateChecklistItem", id: item.id, baseRev: item.rev, completed: !item.completed })}
      />
      <input
        value={title}
        readOnly={!writable}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => title.trim() && title !== item.title && void apply({ type: "updateChecklistItem", id: item.id, baseRev: item.rev, title })}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
      {canDelete && (
        <button className="icon-btn tiny" aria-label="Delete checklist item" title="Delete permanently" onClick={() => void apply({ type: "deleteChecklistItem", id: item.id })}>
          <CloseIcon size={10} />
        </button>
      )}
    </div>
  );
}
